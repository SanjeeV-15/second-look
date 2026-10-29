import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import { ClaudeError, type Tagger } from '../src/claude.js';
import { ItemTagsSchema } from '../src/schema.js';
import { fakeYoucam, jpegUrl } from './helpers.js';

const TAGS = { name: 'Orange tee', category: 'top', color: 'orange', style: 'basic', formality: 'casual', notes: 'cotton' };

let mode: 'ok' | 'claude-error' | 'crash' = 'ok';
const seen: number[] = [];
const tagger: Tagger = {
  async tag(image) {
    seen.push(image.bytes.length);
    if (mode === 'claude-error') throw new ClaudeError('Claude is rate limiting requests. Try again in a moment.', 'status 429');
    if (mode === 'crash') throw new Error('internal secret detail');
    return TAGS as any;
  },
};

let server: Server;
let base: string;
beforeAll(async () => {
  server = createApp({ youcam: fakeYoucam().client, tagger }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.close();
});

const post = (body: unknown) =>
  fetch(`${base}/api/tag`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('POST /api/tag', () => {
  it('returns the tags for a valid photo', async () => {
    mode = 'ok';
    const res = await post({ image: jpegUrl() });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).tags).toEqual(TAGS);
  });

  it('only returns tags that match the schema the UI relies on', () => {
    expect(ItemTagsSchema.safeParse(TAGS).success).toBe(true);
    expect(ItemTagsSchema.safeParse({ ...TAGS, category: 'hat' }).success).toBe(false);
  });

  it('rejects a bad image with 400 before calling Claude', async () => {
    mode = 'ok';
    const before = seen.length;
    const res = await post({ image: 'data:text/plain;base64,AAAA' });
    expect(res.status).toBe(400);
    expect(seen.length).toBe(before);
  });

  it('rejects a missing image', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });

  it('answers 502 with a friendly message when Claude fails', async () => {
    mode = 'claude-error';
    const res = await post({ image: jpegUrl() });
    expect(res.status).toBe(502);
    expect(((await res.json()) as any).error).toContain('rate limiting');
  });

  it('answers 500 without leaking internal details on an unexpected crash', async () => {
    mode = 'crash';
    const res = await post({ image: jpegUrl() });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain('internal secret');
  });

  it('answers 503 when the server has no Anthropic key', async () => {
    const keyless = createApp({ youcam: fakeYoucam().client }).listen(0);
    await new Promise((r) => keyless.once('listening', r));
    const port = (keyless.address() as AddressInfo).port;
    const previous = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: jpegUrl() }),
      });
      expect(res.status).toBe(503);
      expect(((await res.json()) as any).error).toContain('ANTHROPIC_API_KEY');
    } finally {
      if (previous !== undefined) process.env.ANTHROPIC_API_KEY = previous;
      keyless.close();
    }
  });
});
