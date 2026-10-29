import type { Advice, ClosetItem, RawAdvice } from './schema.js';

const MAX_OUTFITS = 3;
const MAX_DUPLICATES = 3;
const MAX_ACCESSORIES = 2;
const clip = (s: string, n: number) => s.trim().slice(0, n);

// Claude proposes, the server disposes: only real closet ids, one piece per slot, nothing that
// clashes with the candidate, and no outfit that ends up empty.
export function cleanAdvice(raw: RawAdvice, closet: ClosetItem[], candidate: Omit<ClosetItem, 'id'>): Advice {
  const byId = new Map(closet.map((item) => [item.id, item]));

  const seenDuplicate = new Set<string>();
  const duplicates = raw.duplicates
    .filter((d) => byId.has(d.item_id) && !seenDuplicate.has(d.item_id) && seenDuplicate.add(d.item_id))
    .slice(0, MAX_DUPLICATES)
    .map((d) => ({ itemId: d.item_id, reason: clip(d.reason, 240) }));

  const outfits: Advice['outfits'] = [];
  for (const outfit of raw.outfits) {
    const used = new Set<string>([candidate.category]);
    let accessories = 0;
    const itemIds: string[] = [];
    for (const id of outfit.item_ids) {
      const item = byId.get(id);
      if (!item || itemIds.includes(id)) continue;
      if (item.category === 'accessory') {
        if (candidate.category === 'accessory' || accessories >= MAX_ACCESSORIES) continue;
        accessories++;
      } else {
        if (used.has(item.category)) continue;
        used.add(item.category);
      }
      itemIds.push(id);
    }
    if (itemIds.length === 0) continue;
    outfits.push({ name: clip(outfit.name, 60), itemIds, reason: clip(outfit.reason, 300) });
    if (outfits.length === MAX_OUTFITS) break;
  }

  return { verdict: clip(raw.verdict, 400), gap: clip(raw.gap, 300), duplicates, outfits };
}
