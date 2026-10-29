import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ClosetItemSchema } from '../src/schema.js';

const dir = path.join(process.cwd(), 'public', 'samples');
const samples = JSON.parse(readFileSync(path.join(dir, 'samples.json'), 'utf8'));

// Sample tags are shown to users and sent to Claude as closet data, so they must pass the same checks.
const asItem = (s: any, i: number) => ClosetItemSchema.safeParse({ id: `sample-${i}`, ...s, file: undefined });

describe('sample data', () => {
  const all = [...samples.closet, ...samples.candidates];

  it('has a person photo and a usable closet and candidate', () => {
    expect(samples.person.file).toBeTruthy();
    expect(samples.closet.length).toBeGreaterThanOrEqual(3);
    expect(samples.candidates.length).toBeGreaterThanOrEqual(1);
  });

  it.each(all.map((s: any, i: number) => [s.file, s, i]))('%s has valid tags', (_file, s: any, i: number) => {
    const parsed = asItem(s, i as number);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('points at image files that exist, are JPEGs, and are small enough', () => {
    for (const file of [samples.person.file, ...all.map((s: any) => s.file)]) {
      const full = path.join(dir, file);
      expect(existsSync(full), file).toBe(true);
      const bytes = readFileSync(full);
      expect(bytes[0] === 0xff && bytes[1] === 0xd8, `${file} is a JPEG`).toBe(true);
      expect(statSync(full).size, file).toBeLessThan(500 * 1024);
    }
  });

  it('credits the photographers', () => {
    expect(samples.credit).toContain('Pexels');
  });

  it('includes at least one top and one pair of shoes, so a sample try-on can show both', () => {
    const categories = all.map((s: any) => s.category);
    expect(categories).toContain('top');
    expect(categories).toContain('shoes');
  });
});
