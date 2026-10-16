import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/providers/rate_limit';

function makeClock(start = 0) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe('RateLimiter', () => {
  it('first call never waits', async () => {
    const clock = makeClock();
    const sleeps: number[] = [];
    const rl = new RateLimiter(1, clock.now, async (ms) => {
      sleeps.push(ms);
    });
    await rl.gate('a');
    expect(sleeps).toEqual([]);
  });

  it('second call waits the remaining delta', async () => {
    const clock = makeClock();
    const sleeps: number[] = [];
    const rl = new RateLimiter(1, clock.now, async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    });
    await rl.gate('a');
    clock.advance(400);
    await rl.gate('a');
    expect(sleeps).toEqual([600]);
  });

  it('does not wait when the delay has already elapsed', async () => {
    const clock = makeClock();
    const sleeps: number[] = [];
    const rl = new RateLimiter(1, clock.now, async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    });
    await rl.gate('a');
    clock.advance(1500);
    await rl.gate('a');
    expect(sleeps).toEqual([]);
  });

  it('zero minDelay never sleeps', async () => {
    const clock = makeClock();
    const sleeps: number[] = [];
    const rl = new RateLimiter(0, clock.now, async (ms) => {
      sleeps.push(ms);
    });
    await rl.gate('a');
    await rl.gate('a');
    await rl.gate('a');
    expect(sleeps).toEqual([]);
  });

  it('different keys are independent', async () => {
    const clock = makeClock();
    const sleeps: number[] = [];
    const rl = new RateLimiter(1, clock.now, async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    });
    await rl.gate('a');
    await rl.gate('b');
    expect(sleeps).toEqual([]);
    clock.advance(400);
    await rl.gate('a');
    await rl.gate('b');
    expect(sleeps).toEqual([600]);
  });

  it('concurrent gates on the same key are serialized and spaced', async () => {
    const clock = makeClock();
    const sleeps: number[] = [];
    const rl = new RateLimiter(1, clock.now, async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    });
    // Fire three gates without awaiting: each must land a full delay apart.
    const p1 = rl.gate('a');
    const p2 = rl.gate('a');
    const p3 = rl.gate('a');
    await Promise.all([p1, p2, p3]);
    expect(sleeps).toEqual([1000, 1000]);
  });

  it('a rejected gate does not poison the chain for later gates', async () => {
    const clock = makeClock();
    let failNextSleep = true;
    const sleeps: number[] = [];
    const rl = new RateLimiter(1, clock.now, async (ms) => {
      if (failNextSleep) {
        failNextSleep = false;
        throw new Error('boom');
      }
      sleeps.push(ms);
      clock.advance(ms);
    });
    await rl.gate('a'); // first call: schedules a slot, never sleeps
    await rl.gate('a').catch(() => undefined); // sleep rejects → gate rejects
    // The chain must survive the rejection: this gate waits the full delay.
    await rl.gate('a');
    expect(sleeps).toEqual([1000]);
  });
});
