import { randomBytes } from 'node:crypto';
// A bounded admission lease, never a native cancellation or process killer.
export class UpdateGate {
  constructor({ blockers, clock = Date.now }) { this.blockers = blockers; this.clock = clock; this.lease = null; }
  get draining() {
    if (this.lease && !this.lease.committed && this.clock() >= this.lease.expiresAt) this.lease = null;
    return !!this.lease;
  }
  status() {
    const draining = this.draining, blockers = [...new Set(this.blockers())];
    return { draining, ready: draining && !blockers.length, blockers, candidate: this.lease?.candidate ?? null,
      expiresAt: this.lease?.expiresAt ?? null, committed: this.lease?.committed ?? false, nativeCancellationRequested: false };
  }
  prepare({ candidate } = {}) {
    if (!/^[a-f0-9]{64}$/.test(candidate ?? '')) throw Error('candidate_hash_required');
    if (this.draining) throw Error('update_already_prepared');
    this.lease = { token: randomBytes(32).toString('hex'), candidate, expiresAt: this.clock() + 300000, committed: false };
    return { ...this.status(), token: this.lease.token };
  }
  check(token) { if (!this.draining || this.lease.token !== token) throw Error('update_lease_invalid'); }
  abort(token) { this.check(token); if (this.lease.committed) throw Error('update_already_committed'); this.lease = null; return this.status(); }
  commit(token) {
    this.check(token); const status = this.status();
    if (!status.ready) throw Error('update_busy');
    this.lease.committed = true; return this.status();
  }
}
