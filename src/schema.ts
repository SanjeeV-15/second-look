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
