import { describe, expect, it } from 'vitest';
import { runChain, type RenderEvent } from '../src/chain.js';
import type { Img } from '../src/images.js';
import { fakeYoucam, JPEG } from './helpers.js';

const img = (name: string): Img => ({ bytes: JPEG, type: 'image/jpeg', name });

async function run(items: Parameters<typeof runChain>[0]['items'], fake = fakeYoucam(), isCancelled?: () => boolean) {
  const events: RenderEvent[] = [];
  await runChain({
    client: fake.client,
    person: img('you.jpg'),
    items,
    gender: 'male',
    emit: (e) => events.push(e),
    isCancelled,
  });
  return { events, ...fake };
}

describe('runChain', () => {
  it('puts the top on first, then feeds that result into the shoes step', async () => {
    const { events, tasks } = await run({ top: img('top.jpg'), shoes: img('shoes.jpg') });

    expect(tasks.map((t) => t.task)).toEqual(['cloth-v4', 'shoes-transfer']);
    expect(tasks[0]!.body).toMatchObject({ src_file_id: 'file-1', ref_file_id: 'file-2', garment_category: 'upper_body' });
    expect(tasks[1]!.body).toMatchObject({
      src_file_url: 'https://result.test/1.jpg',
      ref_file_id: 'file-3',
      gender: 'male',
      style: 'random',
    });
    expect(tasks[1]!.body).not.toHaveProperty('src_file_id');

    expect(events.map((e) => e.type)).toEqual(['start', 'step', 'step', 'done']);
    expect(events[0]).toEqual({ type: 'start', steps: ['top', 'shoes'] });
    expect(events[1]).toMatchObject({ type: 'step', slot: 'top', index: 0 });
    expect(events[2]).toMatchObject({ type: 'step', slot: 'shoes', index: 1 });
  });

  it('runs in the fixed order whatever order the items were given', async () => {
    const { tasks } = await run({ shoes: img('shoes.jpg'), top: img('top.jpg') });
    expect(tasks.map((t) => t.task)).toEqual(['cloth-v4', 'shoes-transfer']);
  });

  it('puts the bottom between the top and the shoes', async () => {
    const { tasks } = await run({ shoes: img('s.jpg'), bottom: img('b.jpg'), top: img('t.jpg') });
    expect(tasks.map((t) => (t.body as any).garment_category ?? 'shoes')).toEqual(['upper_body', 'lower_body', 'shoes']);
  });

  it('ignores hats and bags: their APIs regenerate the whole scene, so they are never run', async () => {
    const { tasks } = await run({ top: img('t.jpg'), hat: img('hat.jpg'), bag: img('bag.jpg') } as any);
    expect(tasks.map((t) => t.task)).toEqual(['cloth-v4']);
  });

  it('skips slots that were not given and uploads only what it needs', async () => {
    const { tasks, uploads } = await run({ shoes: img('shoes.jpg') });
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.body).toMatchObject({ src_file_id: 'file-1', ref_file_id: 'file-2' });
    expect(uploads).toEqual(['you.jpg', 'shoes.jpg']);
  });

  it('sends each finished step as a data URL', async () => {
    const { events } = await run({ top: img('top.jpg') });
    const step = events.find((e) => e.type === 'step') as Extract<RenderEvent, { type: 'step' }>;
    expect(step.image.startsWith('data:image/jpeg;base64,')).toBe(true);
    expect(Buffer.from(step.image.split(',')[1]!, 'base64').toString()).toBe('image-of-https://result.test/1.jpg');
  });

  it('keeps the finished steps and reports the failing one', async () => {
    const { events } = await run({ top: img('t.jpg'), shoes: img('s.jpg') }, fakeYoucam({ failOnTask: 2 }));
    expect(events.map((e) => e.type)).toEqual(['start', 'step', 'error']);
    expect(events[2]).toMatchObject({ type: 'error', slot: 'shoes', code: 'pose', completed: 1 });
    expect((events[2] as any).message).toContain('pose');
  });

  it('turns an unexpected failure into a generic message without leaking details', async () => {
    const fake = fakeYoucam();
    fake.client.runTask = async () => {
      throw new Error('secret internal detail');
    };
    const { events } = await run({ top: img('t.jpg') }, fake);
    const err = events.at(-1) as Extract<RenderEvent, { type: 'error' }>;
    expect(err.code).toBe('upstream');
    expect(err.message).not.toContain('secret');
  });

  it('stops between steps when cancelled', async () => {
    let calls = 0;
    const { tasks, events } = await run({ top: img('t.jpg'), shoes: img('s.jpg') }, fakeYoucam(), () => ++calls > 1);
    expect(tasks).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['start', 'step']);
  });
});
