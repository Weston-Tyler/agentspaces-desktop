import { randomBytes, timingSafeEqual } from 'node:crypto';

export class OwnerBrowserSession {
  constructor(store, { clock = Date.now, lifetimeMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
    Object.assign(this, { store, clock, lifetimeMs });
    this.current();
  }
  current() {
    const saved = this.store.data.ownerBrowserSession, now = this.clock();
    if (saved?.schema === 1 && /^[a-f0-9]{64}$/.test(saved.token ?? '') && Number.isFinite(saved.expiresAt) && saved.expiresAt > now && saved.expiresAt <= now + this.lifetimeMs) return saved;
    const record = { schema: 1, token: randomBytes(32).toString('hex'), expiresAt: now + this.lifetimeMs };
    this.store.data.ownerBrowserSession = record; this.store.save(); return record;
  }
  valid(token) {
    const record = this.store.data.ownerBrowserSession;
    return typeof token === 'string' && /^[a-f0-9]{64}$/.test(token) && record?.expiresAt > this.clock() && /^[a-f0-9]{64}$/.test(record.token ?? '') && timingSafeEqual(Buffer.from(token,'hex'), Buffer.from(record.token,'hex'));
  }
  cookie() {
    const record = this.current();
    return 'as_session=' + record.token + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + Math.max(1,Math.floor((record.expiresAt - this.clock()) / 1000));
  }
}
