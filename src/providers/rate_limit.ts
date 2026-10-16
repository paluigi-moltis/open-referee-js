/** Enforces a minimum delay between calls sharing the same key (e.g. a provider baseUrl). */
export class RateLimiter {
  private readonly scheduled: Map<string, number>;
  private readonly chains: Map<string, Promise<void>>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly minDelayS: number,
    now: () => number = Date.now,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.scheduled = new Map();
    this.chains = new Map();
    this.now = now;
    this.sleep = sleep;
  }

  async gate(key: string): Promise<void> {
    if (this.minDelayS <= 0) return;
    // Serialize per key so concurrent gates cannot all read the same
    // "last time" and start inside each other's window.
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.waitForSlot(key));
    // Never leak a rejection into the shared chain.
    this.chains.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  private async waitForSlot(key: string): Promise<void> {
    const minDelayMs = this.minDelayS * 1000;
    const last = this.scheduled.get(key);
    const t = this.now();
    if (last !== undefined && last > t) {
      await this.sleep(last - t);
    }
    // Reserve the slot optimistically: even if sleep uses a fake clock that
    // does not advance `now`, the next gate must wait behind this one.
    this.scheduled.set(key, Math.max(this.now(), (last ?? this.now()) + minDelayMs));
  }
}
