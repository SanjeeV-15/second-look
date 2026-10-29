import { describe, expect, it } from 'vitest';
// @ts-expect-error plain browser module with no type declarations
import { planTryOns, resultFile, tagSignature, tryOnKey, wearableItems } from '../public/samplekeys.js';

const item = (category: string, file: string) => ({ category, file });
const page = (category: string, sampleFile: string) => ({ category, sampleFile });

describe('tryOnKey', () => {
  it('uses the first top then the first pair of shoes, whatever order the items are given', () => {
    expect(tryOnKey('p.jpg', [item('shoes', 's.jpg'), item('top', 't.jpg')])).toBe('p.jpg|t.jpg+s.jpg');
  });

  it('ignores anything that cannot be rendered', () => {
    expect(tryOnKey('p.jpg', [item('bottom', 'b.jpg'), item('hat', 'h.jpg'), item('top', 't.jpg')])).toBe('p.jpg|t.jpg');
  });

  it('keeps only the first of each kind', () => {
    expect(tryOnKey('p.jpg', [item('top', 't1.jpg'), item('top', 't2.jpg')])).toBe('p.jpg|t1.jpg');
  });

  it('gives no key when nothing is wearable or there is no sample person', () => {
    expect(tryOnKey('p.jpg', [item('bag', 'b.jpg')])).toBeNull();
    expect(tryOnKey(null, [item('top', 't.jpg')])).toBeNull();
  });

  it('reads either the page field (sampleFile) or the manifest field (file) and gets the same key', () => {
    expect(tryOnKey('p.jpg', [page('top', 't.jpg'), page('shoes', 's.jpg')])).toBe(
      tryOnKey('p.jpg', [item('top', 't.jpg'), item('shoes', 's.jpg')]),
    );
  });
});

describe('wearableItems', () => {
  it('returns items in chain order', () => {
    expect(wearableItems([item('shoes', 's'), item('top', 't')]).map((i: any) => i.category)).toEqual(['top', 'shoes']);
  });
});

describe('resultFile', () => {
  it('builds a readable path under results/', () => {
    expect(resultFile('person.jpg|orange-tee.jpg+sneakers.jpg')).toBe('results/person__orange-tee__sneakers.jpg');
    expect(resultFile('person.jpg|orange-tee.jpg')).toBe('results/person__orange-tee.jpg');
  });
});

describe('tagSignature', () => {
  const tags = { name: 'a', category: 'top', color: 'b', style: 'c', formality: 'casual', notes: 'd' };
  it('is stable and changes when any shown detail is edited', () => {
    expect(tagSignature(tags)).toBe(tagSignature({ ...tags }));
    for (const key of Object.keys(tags)) {
      expect(tagSignature({ ...tags, [key]: 'changed' }), key).not.toBe(tagSignature(tags));
    }
  });
});

describe('planTryOns', () => {
  const manifest = {
    person: { file: 'p.jpg' },
    closet: [item('top', 'ct.jpg'), item('shoes', 'cs.jpg'), item('bottom', 'cb.jpg')],
    candidates: [item('top', 'nt1.jpg'), item('top', 'nt2.jpg'), item('shoes', 'ns.jpg')],
  };
  const advice = {
    'nt1.jpg': { outfits: [{ files: ['cs.jpg', 'cb.jpg'] }] },
    'ns.jpg': { outfits: [{ files: ['ct.jpg', 'cb.jpg'] }] },
  };
  const keys = planTryOns(manifest, advice).map((p: any) => p.key);

  it('covers each wearable candidate on its own', () => {
    expect(keys).toContain('p.jpg|nt1.jpg');
    expect(keys).toContain('p.jpg|nt2.jpg');
    expect(keys).toContain('p.jpg|ns.jpg');
  });

  it('covers each advised outfit, using only its wearable pieces', () => {
    expect(keys).toContain('p.jpg|nt1.jpg+cs.jpg');
    expect(keys).toContain('p.jpg|ct.jpg+ns.jpg');
  });

  it('covers every top-and-shoes pair from the tray', () => {
    expect(keys).toContain('p.jpg|nt1.jpg+ns.jpg');
    expect(keys).toContain('p.jpg|nt2.jpg+ns.jpg');
  });

  it('lists each try-on once', () => {
    expect(keys.length).toBe(new Set(keys).size);
  });

  it('copes with a candidate that has no advice yet', () => {
    expect(() => planTryOns(manifest, {})).not.toThrow();
  });
});
