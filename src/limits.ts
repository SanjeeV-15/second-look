// Spending guards. Nothing here knows about prices: a "budget" just counts calls (or render steps)
// per visitor per hour and for the whole server per day, so a stuck loop or a runaway client
// can't burn credit. State is in memory, so a restart resets it.

export interface Gate {
  ok: boolean;
  retryAfterSec: number;
  reason?: 'visitor' | 'daily';
}

interface Window {
  count: number;
  resetAt: number;
}

export interface BudgetOptions {
  perVisitorPerHour: number;
  perDay: number;
  now?: () => number;
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

export class Budget {
  private visitors = new Map<string, Window>();
  private day: Window = { count: 0, resetAt: 0 };
  private readonly now: () => number;

  constructor(private readonly opts: BudgetOptions) {
    this.now = opts.now ?? Date.now;
  }

  // Spend `cost` units for this visitor, or say when to come back. Nothing is spent on a refusal.
  consume(visitor: string, cost = 1): Gate {
    const t = this.now();
    this.sweep(t);

    if (t >= this.day.resetAt) this.day = { count: 0, resetAt: t + DAY };
    const mine = this.visitors.get(visitor) ?? { count: 0, resetAt: t + HOUR };

    if (mine.count + cost > this.opts.perVisitorPerHour) {
      return { ok: false, reason: 'visitor', retryAfterSec: Math.ceil((mine.resetAt - t) / 1000) };
    }
    if (this.day.count + cost > this.opts.perDay) {
      return { ok: false, reason: 'daily', retryAfterSec: Math.ceil((this.day.resetAt - t) / 1000) };
    }

    mine.count += cost;
    this.day.count += cost;
    this.visitors.set(visitor, mine);
    return { ok: true, retryAfterSec: 0 };
  }

  private sweep(t: number) {
    for (const [key, w] of this.visitors) if (t >= w.resetAt) this.visitors.delete(key);
  }
}

// Lets one visitor run a single try-on at a time (each one is slow and uses several units).
export class InFlight {
  private active = new Set<string>();
  tryStart(visitor: string): boolean {
    if (this.active.has(visitor)) return false;
    this.active.add(visitor);
    return true;
  }
  end(visitor: string) {
    this.active.delete(visitor);
  }
}

export interface Limits {
  claude: Budget; // tagging and advice calls
  render: Budget; // YouCam try-on steps (2 units each)
  inFlight: InFlight;
}

const num = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Limits {
  return {
    claude: new Budget({
      perVisitorPerHour: num(env.LIMIT_CLAUDE_PER_HOUR, 100),
      perDay: num(env.LIMIT_CLAUDE_PER_DAY, 500),
    }),
    render: new Budget({
      perVisitorPerHour: num(env.LIMIT_RENDER_STEPS_PER_HOUR, 30),
      perDay: num(env.LIMIT_RENDER_STEPS_PER_DAY, 150),
    }),
    inFlight: new InFlight(),
  };
}

export function limitMessage(gate: Gate, what: string): string {
  const mins = Math.max(1, Math.ceil(gate.retryAfterSec / 60));
  return gate.reason === 'daily'
    ? `The daily limit for ${what} has been reached. Try again in about ${mins} minutes.`
    : `You've used the hourly limit for ${what}. Try again in about ${mins} minutes.`;
}
