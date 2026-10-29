// Builds an outfit on the person one piece at a time. Each result becomes the next step's input.
import { toDataUrl, type Img } from './images.js';
import { YoucamError, type YoucamClient, type YoucamErrorCode } from './youcam.js';

export type Slot = 'top' | 'bottom' | 'shoes';
export type Gender = 'male' | 'female';

// Order matters: clothes first, then shoes.
export const ORDER: Slot[] = ['top', 'bottom', 'shoes'];

// Slots whose API takes a gender for the fit.
export const NEEDS_GENDER: Slot[] = ['shoes'];

// Hats and bags are deliberately absent. The hat and bag APIs were tried live and they regenerate the
// whole picture as a new styled scene (new background, new clothes, a different pose), so they
// cannot be chained on top of a try-on without destroying it.

// Always name the category: "full_body" was seen changing the shoes unasked.
// `detail` is the same parameters as a short, readable string for the on-screen API activity list.
const STEPS: Record<
  Slot,
  { task: string; params: (gender: Gender) => Record<string, unknown>; detail: (gender: Gender) => string }
> = {
  top: { task: 'cloth-v4', params: () => ({ garment_category: 'upper_body' }), detail: () => 'garment_category: upper_body' },
  bottom: { task: 'cloth-v4', params: () => ({ garment_category: 'lower_body' }), detail: () => 'garment_category: lower_body' },
  shoes: {
    task: 'shoes-transfer',
    params: (gender) => ({ gender, style: 'random' }),
    detail: (gender) => `gender: ${gender}, style: random`,
  },
};

// What YouCam charges for one try-on task (documented as 2 units for both the clothes and shoes APIs).
export const UNITS_PER_STEP = 2;

export type RenderEvent =
  | { type: 'start'; steps: Slot[] }
  // task/detail/ms/units describe the YouCam call that produced this image, for the on-screen activity list.
  | { type: 'step'; slot: Slot; index: number; image: string; task: string; detail: string; ms: number; units: number }
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
      const started = Date.now();
      const resultUrl = await client.runTask(step.task, {
        ...source,
        ref_file_id: itemIds[index],
        ...step.params(gender),
      });
      const ms = Date.now() - started;
      const bytes = await client.download(resultUrl);
      completed++;
      emit({
        type: 'step',
        slot,
        index,
        image: toDataUrl(bytes),
        task: step.task,
        detail: step.detail(gender),
        ms,
        units: UNITS_PER_STEP,
      });
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
