import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error plain browser module with no type declarations
import { closetSignature, planTryOns, resultFile } from '../public/samplekeys.js';

// The keyless walkthrough only works if the pre-generated data is complete and matches the sample set.
// These checks fail when someone adds a sample photo and forgets to run `npm run samples:generate`.
const dir = path.join(process.cwd(), 'public', 'samples');
const manifest = JSON.parse(readFileSync(path.join(dir, 'samples.json'), 'utf8'));
const precomputed = JSON.parse(readFileSync(path.join(dir, 'precomputed.json'), 'utf8'));

const closetFiles = new Set(manifest.closet.map((c: any) => c.file));
const isJpeg = (file: string) => {
  const b = readFileSync(path.join(dir, file));
  return b[0] === 0xff && b[1] === 0xd8;
};

describe('pre-generated advice', () => {
  it('was written for the closet that samples.json describes today', () => {
    expect(precomputed.closet).toBe(closetSignature(manifest.closet));
  });

  it('exists for every sample piece being considered', () => {
    for (const c of manifest.candidates) expect(precomputed.advice[c.file], c.file).toBeDefined();
  });

  it('has a verdict, a gap note and at least one outfit', () => {
    for (const c of manifest.candidates) {
      const a = precomputed.advice[c.file];
      expect(a.verdict.length, `${c.file} verdict`).toBeGreaterThan(10);
      expect(a.gap.length, `${c.file} gap`).toBeGreaterThan(5);
      expect(a.outfits.length, `${c.file} outfits`).toBeGreaterThan(0);
    }
  });

  it('only mentions pieces that are in the sample closet', () => {
    for (const a of Object.values<any>(precomputed.advice)) {
      for (const d of a.duplicates) expect(closetFiles.has(d.file), d.file).toBe(true);
      for (const o of a.outfits) for (const f of o.files) expect(closetFiles.has(f), f).toBe(true);
    }
  });

  it('only covers pieces that still exist in samples.json', () => {
    const candidates = new Set(manifest.candidates.map((c: any) => c.file));
    for (const file of Object.keys(precomputed.advice)) expect(candidates.has(file), file).toBe(true);
  });
});

describe('pre-generated try-ons', () => {
  const plan = planTryOns(manifest, Object.fromEntries(Object.entries<any>(precomputed.advice)));

  it('cover every try-on a visitor can reach with the samples', () => {
    const missing = plan.filter((p: any) => !precomputed.tryons[p.key]).map((p: any) => p.key);
    expect(missing).toEqual([]);
  });

  it('point at result images that exist, are JPEGs and stay small', () => {
    for (const [key, entry] of Object.entries<any>(precomputed.tryons)) {
      expect(entry.file, key).toBe(resultFile(key));
      expect(existsSync(path.join(dir, entry.file)), entry.file).toBe(true);
      expect(isJpeg(entry.file), `${entry.file} is a JPEG`).toBe(true);
      expect(statSync(path.join(dir, entry.file)).size, entry.file).toBeLessThan(450 * 1024);
    }
  });

  it('have no stray result files nobody refers to', () => {
    const referenced = new Set(Object.values<any>(precomputed.tryons).map((e) => e.file));
    const resultsDir = path.join(dir, 'results');
    const onDisk = existsSync(resultsDir) ? readdirSync(resultsDir).filter((f) => f.endsWith('.jpg')) : [];
    expect(onDisk.filter((f) => !referenced.has(`results/${f}`))).toEqual([]);
  });

  it('contains no placeholder text', () => {
    expect(JSON.stringify(precomputed)).not.toMatch(/TEMP|FIXTURE|lorem/i);
  });
});
