import { Peer, Space, Template } from '@agentspaces/client';
import { TYPES } from './fabric.mjs';

// A bounded, process-local observation of upstream events. The signed replica
// remains authoritative; this buffer never schedules work or persists effects.
export class WorkBoardActivity {
  constructor(identity, group, space, clock, baseline) {
    this.clock = clock;
    this.startedAt = new Date(clock()).toISOString();
    this.events = []; this.totalObserved = 0; this.capturing = false; this.closed = false;
    this.peer = new Peer(identity, group, clock);
    this.space = new Space(this.peer, space);
    this.subscriptions = ['request', 'result'].map(recordType => this.space.watch(
      new Template(TYPES[recordType]), event => {
        if (!this.capturing || this.closed) return;
        // This upstream version's sweep checks the original write lease. Do
        // not report a false expiry when the verified effective lease renewed.
        // It may omit that later expiry; the board's state projection remains
        // authoritative and this event feed explicitly is not complete history.
        const state = this.peer.states.get(event.entry.entryId);
        if (event.kind === 'EXPIRED' && Number(state?.leaseValue?.expiresAtMillis ?? event.entry.expiresAtMillis) > clock()) return;
        this.events.push({ sequence: ++this.totalObserved, kind: event.kind,
          entryId: event.entry.entryId,
          workEntryId: recordType === 'request' ? event.entry.entryId : event.entry.value.requestEntryId,
          recordType, observedAt: new Date(clock()).toISOString() });
        if (this.events.length > 100) this.events.shift();
      }));
    // Seed upstream watch de-duplication without presenting restored history as
    // fresh work. restoreSnapshot folds claims before states: a second fold
    // seeds TAKEN for records that were not present during the first claim fold.
    try {
      this.peer.restoreSnapshot(baseline);
      this.peer.restoreSnapshot(baseline);
      this.space.sweep();
      this.capturing = true;
    } catch (error) { this.close(); throw error; }
  }
  observe(snapshot) {
    if (this.closed) return;
    this.peer.restoreSnapshot(snapshot);
    this.space.sweep();
  }
  view() {
    return { available: !this.closed, source: 'upstream Space.watch', startedAt: this.startedAt,
      persisted: false, completeHistory: false, totalObserved: this.totalObserved,
      truncated: this.totalObserved > this.events.length,
      events: this.events.map(event => ({ ...event })),
      semantics: 'Observations since this companion opened the board. Restored state is a silent baseline; intermediate changes between reads may be absent. Upstream deduplicates written/taken/completed per entry and claim-expiry per epoch. Events never authorize or start work.' };
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.capturing = false;
    for (const subscription of this.subscriptions) { subscription.close(); subscription.removeAllListeners(); }
    this.subscriptions = []; this.events = [];
    this.peer.close(); this.peer.states.clear(); this.peer.claims.clear();
    // Upstream Space has no dispatcher disposal API. Its one unref'd timer
    // remains inert after subscriptions close; do not allocate a Space per read.
  }
}
