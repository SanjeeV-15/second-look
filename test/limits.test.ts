import { describe, expect, it } from 'vitest';
import { Budget, InFlight, limitMessage, limitsFromEnv } from '../src/limits.js';

const HOUR = 3600_000;

function budget(perVisitorPerHour: number, perDay: number) {
  let t = 1_000_000;
  const b = new Budget({ perVisitorPerHour, perDay, now: () => t });
  return { b, advance: (ms: number) => (t += ms) };
}

describe('Budget', () => {
  it('allows calls up to the hourly limit, then refuses with a wait time', () => {
    const { b } = budget(3, 100);
    expect(b.consume('a').ok).toBe(true);
    expect(b.consume('a').ok).toBe(true);
    expect(b.consume('a').ok).toBe(true);
    const refused = b.consume('a');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('visitor');
    expect(refused.retryAfterSec).toBeGreaterThan(0);
    expect(refused.retryAfterSec).toBeLessThanOrEqual(3600);
  });

  it('counts each visitor separately', () => {
    const { b } = budget(1, 100);
    expect(b.consume('a').ok).toBe(true);
    expect(b.consume('b').ok).toBe(true);
    expect(b.consume('a').ok).toBe(false);
  });

  it('refuses a cost that does not fit, and spends nothing when it does', () => {
    const { b } = budget(3, 100);
    expect(b.consume('a', 4).ok).toBe(false);
    expect(b.consume('a', 3).ok).toBe(true); // the refused attempt used nothing
    expect(b.consume('a', 1).ok).toBe(false);
  });

  it('resets a visitor after an hour', () => {
    const { b, advance } = budget(1, 100);
    expect(b.consume('a').ok).toBe(true);
    expect(b.consume('a').ok).toBe(false);
    advance(HOUR + 1);
    expect(b.consume('a').ok).toBe(true);
  });

  it('stops everyone at the daily limit, whoever is asking', () => {
    const { b } = budget(10, 3);
    b.consume('a');
    b.consume('b');
    b.consume('c');
    const refused = b.consume('d');
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe('daily');
  });

  it('resets the daily count after a day', () => {
    const { b, advance } = budget(100, 2);
    b.consume('a');
    b.consume('a');
    expect(b.consume('a').ok).toBe(false);
    advance(24 * HOUR + 1);
    expect(b.consume('a').ok).toBe(true);
  });

  it('does not charge the day for a visitor-limit refusal', () => {
    const { b } = budget(1, 2);
    b.consume('a');
    b.consume('a'); // refused by the visitor limit
    expect(b.consume('b').ok).toBe(true); // the day still has room
  });
});

describe('InFlight', () => {
  it('allows one at a time per visitor', () => {
    const f = new InFlight();
    expect(f.tryStart('a')).toBe(true);
    expect(f.tryStart('a')).toBe(false);
    expect(f.tryStart('b')).toBe(true);
    f.end('a');
    expect(f.tryStart('a')).toBe(true);
  });
});

describe('limitsFromEnv', () => {
  it('uses defaults, accepts overrides, and ignores junk', () => {
    const d = limitsFromEnv({});
    expect(d.render.consume('a', 30).ok).toBe(true);
    expect(d.render.consume('a', 1).ok).toBe(false);

    const o = limitsFromEnv({ LIMIT_RENDER_STEPS_PER_HOUR: '2' });
    expect(o.render.consume('a', 2).ok).toBe(true);
    expect(o.render.consume('a', 1).ok).toBe(false);

    const junk = limitsFromEnv({ LIMIT_RENDER_STEPS_PER_HOUR: 'abc' });
    expect(junk.render.consume('a', 30).ok).toBe(true);
  });
});

describe('limitMessage', () => {
  it('says whether it is the visitor or the daily limit, and how long to wait', () => {
    expect(limitMessage({ ok: false, reason: 'visitor', retryAfterSec: 1800 }, 'try-ons')).toContain('hourly limit');
    expect(limitMessage({ ok: false, reason: 'visitor', retryAfterSec: 1800 }, 'try-ons')).toContain('30 minutes');
    expect(limitMessage({ ok: false, reason: 'daily', retryAfterSec: 60 }, 'try-ons')).toContain('daily limit');
  });
});
