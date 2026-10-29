import { z } from 'zod';

export const CATEGORIES = ['top', 'bottom', 'shoes', 'outerwear', 'accessory'] as const;
export const FORMALITIES = ['casual', 'smart casual', 'formal', 'sport'] as const;

// What Claude fills in for each clothing photo. The user can edit any of it afterwards.
export const ItemTagsSchema = z.object({
  name: z.string(),
  category: z.enum(CATEGORIES),
  color: z.string(),
  style: z.string(),
  formality: z.enum(FORMALITIES),
  notes: z.string(),
});

export type ItemTags = z.infer<typeof ItemTagsSchema>;

// A closet item as the browser sends it for advice: tags plus an id, never the photo.
// Limits keep a request small and stop a long string from being used to stuff the prompt.
const text = (max: number) => z.string().max(max);
export const ClosetItemSchema = z.object({
  id: text(64).min(1),
  name: text(80),
  category: z.enum(CATEGORIES),
  color: text(40),
  style: text(60),
  formality: z.enum(FORMALITIES),
  notes: text(200),
});
export type ClosetItem = z.infer<typeof ClosetItemSchema>;

export const MAX_CLOSET_ITEMS = 40;

export const AdviceRequestSchema = z.object({
  closet: z.array(ClosetItemSchema).min(1).max(MAX_CLOSET_ITEMS),
  candidate: ClosetItemSchema.omit({ id: true }),
});

// What Claude returns. The server checks every id against the closet before the UI sees it.
export const RawAdviceSchema = z.object({
  verdict: z.string(),
  gap: z.string(),
  duplicates: z.array(z.object({ item_id: z.string(), reason: z.string() })),
  outfits: z.array(z.object({ name: z.string(), item_ids: z.array(z.string()), reason: z.string() })),
});
export type RawAdvice = z.infer<typeof RawAdviceSchema>;

export interface Advice {
  verdict: string;
  gap: string;
  duplicates: { itemId: string; reason: string }[];
  outfits: { name: string; itemIds: string[]; reason: string }[];
}
