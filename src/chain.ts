// Builds an outfit on the person one piece at a time. Each result becomes the next step's input.
import { toDataUrl, type Img } from './images.js';
import { YoucamError, type YoucamClient, type YoucamErrorCode } from './youcam.js';

export type Slot = 'top' | 'bottom' | 'shoes';
export type Gender = 'male' | 'female';

// Order matters: clothes first, then shoes.
export const ORDER: Slot[] = ['top', 'bottom', 'shoes'];

// Always name the category: "full_body" was seen changing the shoes unasked.
const STEPS: Record<Slot, { task: string; params: (gender: Gender) => Record<string, unknown> }> = {
  top: { task: 'cloth-v4', params: () => ({ garment_category: 'upper_body' }) },
  bottom: { task: 'cloth-v4', params: () => ({ garment_category: 'lower_body' }) },
  shoes: { task: 'shoes-transfer', params: (gender) => ({ gender, style: 'random' }) },
};

export type RenderEvent =
  | { type: 'start'; steps: Slot[] }
  | { type: 'step'; slot: Slot; index: number; image: string }
  | { type: 'done' }
  | { type: 'error'; slot: Slot | null; code: YoucamErrorCode; message: string; completed: number };

export interface ChainInput {
  client: YoucamClient;
  person: Img;
  items: Partial<Record<Slot, Img>>;
  gender: Gender;
  emit: (event: RenderEvent) => void;
  isCancelled?: () => boolean;
}

export async function runChain({ client, person, items, gender, emit, isCancelled }: ChainInput): Promise<void> {
  const slots = ORDER.filter((s) => items[s]);
  emit({ type: 'start', steps: slots });
  let completed = 0;
  let current: Slot | null = null;

  try {
    const [personId, ...itemIds] = await Promise.all([
      client.upload(person.bytes, person.name, person.type),
      ...slots.map((s) => client.upload(items[s]!.bytes, items[s]!.name, items[s]!.type)),
    ]);

    // The first step starts from the uploaded photo, later ones from the previous result.
    let source: Record<string, unknown> = { src_file_id: personId };

    for (const [index, slot] of slots.entries()) {
      if (isCancelled?.()) return;
      current = slot;
      const step = STEPS[slot];
      const resultUrl = await client.runTask(step.task, {
        ...source,
        ref_file_id: itemIds[index],
        ...step.params(gender),
      });
      const bytes = await client.download(resultUrl);
      completed++;
      emit({ type: 'step', slot, index, image: toDataUrl(bytes) });
      source = { src_file_url: resultUrl };
    }
    emit({ type: 'done' });
  } catch (err) {
    if (err instanceof YoucamError) {
      emit({ type: 'error', slot: current, code: err.code, message: err.userMessage, completed });
    } else {
      console.error('render failed:', err instanceof Error ? err.message : err);
      emit({ type: 'error', slot: current, code: 'upstream', message: 'Something went wrong. Try again.', completed });
    }
  }
}
