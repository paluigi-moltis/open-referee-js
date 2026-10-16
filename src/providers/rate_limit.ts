/** Enforces a minimum delay between calls sharing the same key (e.g. a provider baseUrl). */
export class RateLimiter {
  private lastCall: Map<string, number>;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly minDelayS: number,
    now: () => number = Date.now,
    sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
  ) {
    this.lastCall = new Map();
    this.now = now;
    this.sleep = sleep;
  }

  async gate(key: string): Promise<void> {
    if (this.minDelayS <= 0) return;
    const minDelayMs = this.minDelayS * 1000;
    const last = this.lastCall.get(key);
    const t = this.now();
    if (last !== undefined) {
      const elapsed = t - last;
      if (elapsed < minDelayMs) {
        await this.sleep(minDelayMs - elapsed);
      }
    }
    this.lastCall.set(key, this.now());
  }
}
