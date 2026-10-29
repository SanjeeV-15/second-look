import { describe, expect, it } from 'vitest';
import { cleanAdvice } from '../src/advice.js';
import type { ClosetItem, RawAdvice } from '../src/schema.js';

const item = (id: string, category: ClosetItem['category']): ClosetItem => ({
  id,
  name: id,
  category,
  color: 'grey',
  style: 'classic',
  formality: 'casual',
  notes: '',
});

const closet = [
  item('top1', 'top'),
  item('top2', 'top'),
  item('chinos', 'bottom'),
  item('jeans', 'bottom'),
  item('sneakers', 'shoes'),
  item('jacket', 'outerwear'),
  item('watch', 'accessory'),
  item('belt', 'accessory'),
  item('hat', 'accessory'),
];
const candidate = { name: 'Orange tee', category: 'top' as const, color: 'orange', style: 'basic', formality: 'casual' as const, notes: '' };

const raw = (over: Partial<RawAdvice>): RawAdvice => ({ verdict: 'v', gap: 'g', duplicates: [], outfits: [], ...over });

describe('cleanAdvice', () => {
  it('drops ids that are not in the closet', () => {
    const out = cleanAdvice(raw({ outfits: [{ name: 'A', item_ids: ['chinos', 'made-up'], reason: 'r' }] }), closet, candidate);
    expect(out.outfits[0]!.itemIds).toEqual(['chinos']);
  });

  it('never lets an outfit use a second item in the candidate\'s category', () => {
    const out = cleanAdvice(raw({ outfits: [{ name: 'A', item_ids: ['top1', 'chinos', 'sneakers'], reason: 'r' }] }), closet, candidate);
    expect(out.outfits[0]!.itemIds).toEqual(['chinos', 'sneakers']);
  });

  it('keeps one item per category', () => {
    const out = cleanAdvice(raw({ outfits: [{ name: 'A', item_ids: ['chinos', 'jeans', 'sneakers'], reason: 'r' }] }), closet, candidate);
    expect(out.outfits[0]!.itemIds).toEqual(['chinos', 'sneakers']);
  });

  it('allows up to two accessories', () => {
    const out = cleanAdvice(raw({ outfits: [{ name: 'A', item_ids: ['watch', 'belt', 'hat'], reason: 'r' }] }), closet, candidate);
    expect(out.outfits[0]!.itemIds).toEqual(['watch', 'belt']);
  });

  it('allows no extra accessory when the candidate is an accessory', () => {
    const out = cleanAdvice(
      raw({ outfits: [{ name: 'A', item_ids: ['watch', 'chinos'], reason: 'r' }] }),
      closet,
      { ...candidate, category: 'accessory' },
    );
    expect(out.outfits[0]!.itemIds).toEqual(['chinos']);
  });

  it('ignores repeated ids', () => {
    const out = cleanAdvice(raw({ outfits: [{ name: 'A', item_ids: ['chinos', 'chinos'], reason: 'r' }] }), closet, candidate);
    expect(out.outfits[0]!.itemIds).toEqual(['chinos']);
  });

  it('drops an outfit that ends up with nothing from the closet', () => {
    const out = cleanAdvice(
      raw({
        outfits: [
          { name: 'Empty', item_ids: ['ghost', 'top1'], reason: 'r' },
          { name: 'Real', item_ids: ['jeans'], reason: 'r' },
        ],
      }),
      closet,
      candidate,
    );
    expect(out.outfits.map((o) => o.name)).toEqual(['Real']);
  });

  it('returns at most three outfits', () => {
    const outfits = ['a', 'b', 'c', 'd'].map((n) => ({ name: n, item_ids: ['chinos'], reason: 'r' }));
    expect(cleanAdvice(raw({ outfits }), closet, candidate).outfits).toHaveLength(3);
  });

  it('keeps real duplicates once, drops unknown ids, and caps at three', () => {
    const out = cleanAdvice(
      raw({
        duplicates: [
          { item_id: 'top1', reason: 'same' },
          { item_id: 'top1', reason: 'again' },
          { item_id: 'ghost', reason: 'nope' },
          { item_id: 'top2', reason: 'close' },
          { item_id: 'jacket', reason: 'x' },
          { item_id: 'jeans', reason: 'y' },
        ],
      }),
      closet,
      candidate,
    );
    expect(out.duplicates.map((d) => d.itemId)).toEqual(['top1', 'top2', 'jacket']);
  });

  it('trims long text', () => {
    const out = cleanAdvice(raw({ verdict: 'x'.repeat(1000), gap: 'y'.repeat(1000) }), closet, candidate);
    expect(out.verdict.length).toBeLessThanOrEqual(400);
    expect(out.gap.length).toBeLessThanOrEqual(300);
  });

  it('returns camelCase fields for the UI', () => {
    const out = cleanAdvice(raw({ outfits: [{ name: 'A', item_ids: ['chinos'], reason: 'r' }] }), closet, candidate);
    expect(out.outfits[0]).toHaveProperty('itemIds');
    expect(out.outfits[0]).not.toHaveProperty('item_ids');
  });
});
