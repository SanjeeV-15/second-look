// Builds the keyless sample walkthrough: Claude's advice for each sample piece, and the YouCam try-on for
// every combination a visitor can reach with the samples. Results go into public/samples/ and are served
// as-is, so judges can explore the app with no API keys.
//
//   npm run samples:generate            show what is missing and what it would cost (spends nothing)
//   npm run samples:generate -- --yes   generate the missing pieces (spends YouCam units and a little Claude)
//
// It only makes what is missing, so after adding sample photos it pays for the new combinations only.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { runChain, type Slot } from '../src/chain.js';
import { createClaudeFromEnv } from '../src/claude.js';
import type { Img } from '../src/images.js';
import { createYoucamClientFromEnv } from '../src/youcam.js';
// @ts-expect-error plain browser module with no type declarations
import { closetSignature, planTryOns, resultFile } from '../public/samplekeys.js';

const dir = path.join(process.cwd(), 'public', 'samples');
const manifestPath = path.join(dir, 'samples.json');
const outPath = path.join(dir, 'precomputed.json');
const GENDER = 'male' as const; // the sample person in samples.json

interface Sample {
  file: string;
  name: string;
  category: string;
  color: string;
  style: string;
  formality: string;
  notes: string;
}
interface Stored {
  closet?: string; // fingerprint of the sample closet the advice was written for
  advice: Record<string, { verdict: string; gap: string; duplicates: { file: string; reason: string }[]; outfits: { name: string; files: string[]; reason: string }[] }>;
  tryons: Record<string, { file: string }>;
}

const yes = process.argv.includes('--yes');
// A safety cap on YouCam units for one run. After the advice is written the exact cost is known; if it is over
// the cap, nothing is rendered. Raise it deliberately with --max-units=N.
const maxUnits = Number(process.argv.find((a) => a.startsWith('--max-units='))?.split('=')[1]) || 40;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const stored: Stored = existsSync(outPath) ? JSON.parse(await readFile(outPath, 'utf8')) : { advice: {}, tryons: {} };
stored.advice ??= {};
stored.tryons ??= {};

// Advice is written for one specific closet. If the closet changed, all of it is out of date.
const closetNow = closetSignature(manifest.closet);
const closetChanged = !!stored.closet && stored.closet !== closetNow;
if (closetChanged) stored.advice = {};
const save = () => writeFile(outPath, JSON.stringify(stored, null, 2) + '\n');

const readImg = async (file: string): Promise<Img> => ({ bytes: await readFile(path.join(dir, file)), type: 'image/jpeg', name: file });
const slim = (s: Sample) => ({ id: s.file, name: s.name, category: s.category, color: s.color, style: s.style, formality: s.formality, notes: s.notes });

// 1. Advice. Claude is asked about each candidate against the whole sample closet.
const needAdvice = (): Sample[] => manifest.candidates.filter((c: Sample) => !stored.advice[c.file]);

// 2. Try-ons. Planned from the advice we have; new advice can add more, so the plan is recomputed after it.
const isDone = (key: string) => {
  const entry = stored.tryons[key];
  return !!entry && existsSync(path.join(dir, entry.file));
};
const missingTryOns = () => planTryOns(manifest, stored.advice).filter((p: { key: string }) => !isDone(p.key));

const stepsOf = (items: Sample[]) => items.length;
const planned = missingTryOns();
const unitsNow = planned.reduce((n: number, p: { items: Sample[] }) => n + 2 * stepsOf(p.items), 0);

console.log(`Sample person: ${manifest.person.file}`);
console.log(`Closet: ${manifest.closet.length} pieces. Candidates: ${manifest.candidates.length}.`);
if (closetChanged) console.log('\nThe sample closet changed since the advice was written, so all advice will be regenerated.');
console.log(`\nAdvice still to generate (Claude, about 2 cents each): ${needAdvice().length}`);
for (const c of needAdvice()) console.log(`  - ${c.file}`);
console.log(`\nTry-ons still to generate from the advice we already have: ${planned.length} (about ${unitsNow} YouCam units)`);
for (const p of planned) console.log(`  - ${p.key}`);
if (needAdvice().length) console.log('\nNew advice may add more try-ons (each outfit it suggests), at 2 units per piece.');

if (!yes) {
  console.log('\nDry run only. Nothing was spent. Add --yes to generate.');
  process.exit(0);
}

// ---- Generate ----
const claude = createClaudeFromEnv();
const client = createYoucamClientFromEnv();
await mkdir(path.join(dir, 'results'), { recursive: true });

const closetSlim = manifest.closet.map(slim);
for (const c of needAdvice()) {
  console.log(`\nAdvice for ${c.file} ...`);
  const { id, ...candidate } = slim(c);
  const advice = await claude.advise(closetSlim, candidate);
  stored.closet = closetNow;
  stored.advice[c.file] = {
    verdict: advice.verdict,
    gap: advice.gap,
    duplicates: advice.duplicates.map((d) => ({ file: d.itemId, reason: d.reason })),
    outfits: advice.outfits.map((o) => ({ name: o.name, files: o.itemIds, reason: o.reason })),
  };
  await save();
  console.log(`  ${advice.verdict}`);
}

async function renderOne(key: string, items: Sample[]) {
  const slots: Partial<Record<Slot, Img>> = {};
  for (const item of items) {
    if (item.category === 'top') slots.top = await readImg(item.file);
    if (item.category === 'shoes') slots.shoes = await readImg(item.file);
  }
  let last: string | null = null;
  let failure: string | null = null;
  await runChain({
    client,
    person: await readImg(manifest.person.file),
    items: slots,
    gender: GENDER,
    emit: (e) => {
      if (e.type === 'step') last = e.image;
      if (e.type === 'error') failure = e.message;
    },
  });
  if (failure || !last) throw new Error(failure ?? 'no image came back');
  const file = resultFile(key);
  await writeFile(path.join(dir, file), Buffer.from((last as string).split(',')[1]!, 'base64'));
  stored.tryons[key] = { file };
  await save();
}

const todo = missingTryOns();
const unitsNeeded = todo.reduce((n: number, p: { items: Sample[] }) => n + 2 * stepsOf(p.items), 0);
console.log(`\nTry-ons to generate: ${todo.length} (${unitsNeeded} YouCam units; cap is ${maxUnits})`);
for (const p of todo) console.log(`  - ${p.key}`);
if (unitsNeeded > maxUnits) {
  console.log(`\nOver the cap, so nothing was rendered. The advice is saved. Re-run with --max-units=${unitsNeeded} to go ahead.`);
  process.exit(2);
}
let done = 0;
for (const { key, items } of todo) {
  const started = Date.now();
  try {
    await renderOne(key, items);
    done++;
    console.log(`  ok   ${key}  (${Math.round((Date.now() - started) / 1000)}s)`);
  } catch (err) {
    console.log(`  FAIL ${key}: ${err instanceof Error ? err.message : err}`);
  }
}
console.log(`\nDone: ${done} of ${todo.length} try-ons generated. Run it again to retry any that failed.`);
process.exit(done === todo.length ? 0 : 1);
