import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { ClaudeError, type Claude } from '../src/claude.js';
import { ItemTagsSchema } from '../src/schema.js';
import { fakeYoucam, jpegUrl } from './helpers.js';

const TAGS = { name: 'Orange tee', category: 'top', color: 'orange', style: 'basic', formality: 'casual', notes: 'cotton' };
const ADVICE = { verdict: 'Worth it.', gap: 'Adds colour.', duplicates: [], outfits: [{ name: 'Casual', itemIds: ['a'], reason: 'Easy.' }] };

let mode: 'ok' | 'claude-error' | 'crash' = 'ok';
const seen = { tag: 0, advise: 0 };
const claude: Claude = {
  async tag() {
    seen.tag++;
    if (mode === 'claude-error') throw new ClaudeError('Claude is rate limiting requests. Try again in a moment.', 'status 429');
    if (mode === 'crash') throw new Error('internal secret detail');
    return TAGS as any;
  },
  async advise() {
    seen.advise++;
    if (mode === 'claude-error') throw new ClaudeError('Claude is rate limiting requests. Try again in a moment.', 'status 429');
    if (mode === 'crash') throw new Error('internal secret detail');
    return ADVICE;
  },
};

let server: Server;
let base: string;
beforeAll(async () => {
  server = createApp({ youcam: fakeYoucam().client, claude }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const post = (route: string, body: unknown) =>
  fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/tag', () => {
  it('returns the tags for a valid photo', async () => {
    mode = 'ok';
    const res = await post('/api/tag', { image: jpegUrl() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).tags).toEqual(TAGS);
  });

  it('only returns tags that match the schema the UI relies on', () => {
    expect(ItemTagsSchema.safeParse(TAGS).success).toBe(true);
    expect(ItemTagsSchema.safeParse({ ...TAGS, category: 'watch' }).success).toBe(false);
  });

  it('rejects a bad image with 400 before calling Claude', async () => {
    mode = 'ok';
    const before = seen.tag;
    const res = await post('/api/tag', { image: 'data:text/plain;base64,AAAA' });
    expect(res.status).toBe(400);
    expect(seen.tag).toBe(before);
  });

  it('rejects a missing image', async () => {
    expect((await post('/api/tag', {})).status).toBe(400);
  });

  it('answers 502 with a friendly message when Claude fails', async () => {
    mode = 'claude-error';
    const res = await post('/api/tag', { image: jpegUrl() });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toContain('rate limiting');
  });

  it('answers 500 without leaking internal details on an unexpected crash', async () => {
    mode = 'crash';
    const res = await post('/api/tag', { image: jpegUrl() });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('internal secret');
  });
});

const goodItem = (id: string) => ({ id, name: 'Grey chinos', category: 'bottom', color: 'grey', style: 'classic', formality: 'casual', notes: '' });
const goodAdvise = () => ({
  closet: [goodItem('a')],
  candidate: { name: 'Orange tee', category: 'top', color: 'orange', style: 'basic', formality: 'casual', notes: '' },
});

describe('POST /api/advise', () => {
  it('returns advice for a valid request', async () => {
    mode = 'ok';
    const res = await post('/api/advise', goodAdvise());
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).advice).toEqual(ADVICE);
  });

  const bad: [string, (b: any) => void][] = [
    ['an empty closet', (b) => (b.closet = [])],
    ['no closet', (b) => delete b.closet],
    ['no candidate', (b) => delete b.candidate],
    ['an unknown category', (b) => (b.closet[0].category = 'watch')],
    ['an over-long note', (b) => (b.closet[0].notes = 'x'.repeat(500))],
    ['more than 40 items', (b) => (b.closet = Array.from({ length: 41 }, (_, i) => goodItem(`i${i}`)))],
  ];
  it.each(bad)('rejects %s with 400 before calling Claude', async (_name, mutate) => {
    mode = 'ok';
    const before = seen.advise;
    const body = goodAdvise();
    mutate(body);
    const res = await post('/api/advise', body);
    expect(res.status).toBe(400);
    expect(seen.advise).toBe(before);
  });

  it('tells the user to add clothes first when the closet is empty', async () => {
    const res = await post('/api/advise', { ...goodAdvise(), closet: [] });
    expect(((await res.json()) as any).error).toContain('closet first');
  });

  it('answers 502 with a friendly message when Claude fails', async () => {
    mode = 'claude-error';
    const res = await post('/api/advise', goodAdvise());
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toContain('rate limiting');
  });
});

describe('missing keys', () => {
  async function keyless(route: string, body: unknown) {
    const s = createApp({ youcam: fakeYoucam().client }).listen(0);
    await new Promise((r) => s.once('listening', r));
    const port = (s.address() as AddressInfo).port;
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      return await fetch(`http://127.0.0.1:${port}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
      s.close();
    }
  }

  it('answers 503 on /api/tag', async () => {
    const res = await keyless('/api/tag', { image: jpegUrl() });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error).toContain('ANTHROPIC_API_KEY');
  });

  it('answers 503 on /api/advise', async () => {
    const res = await keyless('/api/advise', goodAdvise());
    expect(res.status).toBe(503);
  });
});
