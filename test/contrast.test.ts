import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Guards the stylesheet's colours: every text pair must reach WCAG AA (4.5:1) and every field border and
// focus ring 3:1, in both themes. Translucent glass layers are composited over the page, including under the
// brightest part of each background blob, and the worst case is the one that must pass.
const css = readFileSync(path.join(process.cwd(), 'public', 'styles.css'), 'utf8');

type RGBA = [number, number, number, number];
type Tokens = Record<string, string>;

function tokens(selector: string): Tokens {
  const start = css.indexOf(selector + ' {');
  if (start < 0) throw new Error(`no ${selector} block`);
  const body = css.slice(start, css.indexOf('}', start));
  const out: Tokens = {};
  for (const m of body.matchAll(/--([\w-]+):\s*([^;]+);/g)) out[m[1]!] = m[2]!.trim();
  return out;
}

function parse(color: string): RGBA {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as RGBA;
  const fn = color.match(/^rgba?\(([^)]+)\)$/);
  if (fn) {
    const p = fn[1]!.split(',').map((x) => parseFloat(x));
    return [p[0]!, p[1]!, p[2]!, p[3] ?? 1];
  }
  throw new Error(`cannot parse ${color}`);
}

const over = (top: RGBA, bottom: RGBA): RGBA => {
  const a = top[3];
  return [0, 1, 2].map((i) => top[i]! * a + bottom[i]! * (1 - a)).concat(1) as RGBA;
};
const lum = ([r, g, b]: RGBA) => {
  const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (fg: RGBA, bg: RGBA) => {
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
  return (a + 0.05) / (b + 0.05);
};

function rowsFor(t: Tokens): [string, number, number][] {
  const c = (k: string) => parse(t[k]!);
  const base = c('bg');
  const backdrops = [base, ...['blob-1', 'blob-2', 'blob-3'].map((k) => over(c(k), base))];
  const stacks = backdrops.map((bd) => {
    const panel = over(c('glass'), bd);
    const card = over(c('glass-soft'), panel);
    return { bd, panel, card, field: over(c('glass-strong'), card), pill: over(c('glass-soft'), bd) };
  });
  type S = (typeof stacks)[number];
  const worst = (fn: (s: S) => number) => Math.min(...stacks.map(fn));

  const rows: [string, number, number][] = [];
  const text = (label: string, fg: string, bg: (s: S) => RGBA, need = 4.5) =>
    rows.push([label, worst((s) => ratio(parse(fg), bg(s))), need]);

  text('ink on panel', t.ink!, (s) => s.panel);
  text('ink on card', t.ink!, (s) => s.card);
  text('ink on form field', t.ink!, (s) => s.field);
  text('muted on panel', t.muted!, (s) => s.panel);
  text('muted on card', t.muted!, (s) => s.card);
  text('muted and placeholder on form field', t.muted!, (s) => s.field);
  text('muted on journey pill', t.muted!, (s) => s.pill);
  text('ink on current journey pill', t.ink!, (s) => s.pill);
  text('muted on empty stage', t.muted!, (s) => over(c('glass-soft'), s.panel));
  text('unselected toggle on its track', t.muted!, (s) => over(c('accent-soft'), s.panel));
  text('accent text on chip', t['accent-text']!, (s) => over(c('accent-soft'), s.card));
  text('accent text on panel', t['accent-text']!, (s) => s.panel);
  text('accent text on card (API activity)', t['accent-text']!, (s) => s.card);
  text('accent text on journey number', t['accent-text']!, (s) => over(c('accent-soft'), s.pill));
  text('danger on panel', t.danger!, (s) => s.panel);
  text('danger on card', t.danger!, (s) => s.card);
  text('good on panel', t.good!, (s) => s.panel);
  text('good on journey pill', t.good!, (s) => s.pill);
  text('warning text on card', t['warn-ink']!, (s) => over(c('warn-bg'), s.card));
  text('warning text on page', t['warn-ink']!, (s) => over(c('warn-bg'), s.bd));
  text('toast text on toast', t.bg!, () => c('ink'));
  text('journey tick on its badge', t.bg!, () => c('good'));

  [...t.btn!.matchAll(/#[0-9a-f]{6}/gi)].forEach((m, i) => rows.push([`button label on gradient stop ${i + 1}`, ratio(c('accent-ink'), parse(m[0])), 4.5]));
  rows.push(['label on solid accent', ratio(c('accent-ink'), c('accent')), 4.5]);
  for (const [label, photo] of [['white', [255, 255, 255, 1]], ['black', [0, 0, 0, 1]]] as const) {
    rows.push([`caption on scrim over a ${label} photo`, ratio([255, 255, 255, 1], over(c('scrim'), [...photo] as RGBA)), 4.5]);
  }

  rows.push(['form field border against a card', worst((s) => ratio(over(c('field-stroke'), s.card), s.card)), 3]);
  rows.push(['checkbox border against a panel', worst((s) => ratio(over(c('field-stroke'), s.panel), s.panel)), 3]);
  rows.push(['focus ring against a panel', worst((s) => ratio(over(c('accent-ring'), s.panel), s.panel)), 3]);
  rows.push(['selected tray border against a panel', worst((s) => ratio(c('accent'), s.panel)), 3]);
  return rows;
}

const light = tokens(':root');
const dark = { ...light, ...tokens(":root[data-theme='dark']") };

describe.each([
  ['light', light],
  ['dark', dark],
])('%s theme contrast', (_name, t) => {
  it.each(rowsFor(t))('%s', (_label, actual, needed) => {
    expect(actual).toBeGreaterThanOrEqual(needed);
  });
});

describe('theme defaults', () => {
  it('uses dark unless the visitor chose light', () => {
    const script = readFileSync(path.join(process.cwd(), 'public', 'theme.js'), 'utf8');
    expect(script).toContain("'light'");
    expect(script).toContain("dataset.theme = 'dark'");
  });
});
