import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { fakeYoucam, jpegUrl, pngUrl, JPEG } from './helpers.js';

const fake = fakeYoucam();
let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp({ youcam: fake.client }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const post = (body: unknown) =>
  fetch(`${base}/api/render`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const good = () => ({
  person: jpegUrl(),
  gender: 'male',
  items: [
    { slot: 'top', image: jpegUrl() },
    { slot: 'shoes', image: pngUrl() },
  ],
});

async function events(res: Response) {
  const text = await res.text();
  return text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)));
}

describe('POST /api/render', () => {
  it('streams start, a step per item, then done', async () => {
    const res = await post(good());
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const evts = await events(res);
    expect(evts.map((e) => e.type)).toEqual(['start', 'step', 'step', 'done']);
    expect(evts[1].image.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('does not need a gender when there are no shoes', async () => {
    const body = { person: jpegUrl(), items: [{ slot: 'top', image: jpegUrl() }] };
    const evts = await events(await post(body));
    expect(evts.map((e) => e.type)).toEqual(['start', 'step', 'done']);
  });

  const bad: [string, (b: any) => void, string][] = [
    ['no person photo', (b) => delete b.person, 'Your photo'],
    ['a non-image person', (b) => (b.person = 'data:text/plain;base64,AAAA'), 'JPG or PNG'],
    ['a fake JPEG', (b) => (b.person = jpegUrl(Buffer.from('not a jpeg'))), 'valid JPG'],
    ['no gender', (b) => delete b.gender, 'gender'],
    ['no items', (b) => (b.items = []), 'at least one'],
    ['an unknown slot', (b) => (b.items[0].slot = 'hat'), 'Unsupported'],
    ['bottoms (not enabled yet)', (b) => (b.items[0].slot = 'bottom'), 'Unsupported'],
    ['a duplicate slot', (b) => (b.items[1].slot = 'top'), 'Only one top'],
    ['an item without an image', (b) => delete b.items[0].image, 'The top'],
  ];
  it.each(bad)('rejects %s with a 400 before spending anything', async (_name, mutate, fragment) => {
    const before = fake.tasks.length;
    const body = good();
    mutate(body);
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain(fragment);
    expect(fake.tasks.length).toBe(before);
  });

  it('rejects an oversized image', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(10 * 1024 * 1024)]);
    const res = await post({ ...good(), person: jpegUrl(big) });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toContain('10 MB');
  });

  it('returns 400 for malformed JSON instead of a stack trace', async () => {
    const res = await fetch(`${base}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{nope',
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).not.toContain('at ');
  });

  it('answers 503 when the server has no YouCam key', async () => {
    const keyless = createApp().listen(0);
    await new Promise((r) => keyless.once('listening', r));
    const port = (keyless.address() as AddressInfo).port;
    const previous = process.env.YOUCAM_API_KEY;
    delete process.env.YOUCAM_API_KEY;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(good()),
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error).toContain('YOUCAM_API_KEY');
    } finally {
      if (previous !== undefined) process.env.YOUCAM_API_KEY = previous;
      keyless.close();
    }
  });
});
