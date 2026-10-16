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
});
