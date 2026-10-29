import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';
import type { Claude } from '../src/claude.js';
import { Budget, InFlight, type Limits } from '../src/limits.js';
import { YoucamError, type YoucamClient } from '../src/youcam.js';
import { fakeYoucam, jpegUrl } from './helpers.js';

const limits = (render: number, claude: number): Limits => ({
  claude: new Budget({ perVisitorPerHour: claude, perDay: 1000 }),
  render: new Budget({ perVisitorPerHour: render, perDay: 1000 }),
  inFlight: new InFlight(),
});

const servers: Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
});

async function start(deps: { youcam?: YoucamClient; claude?: Claude; limits: Limits }) {
  const server = createApp(deps).listen(0);
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (route: string, body: unknown) =>
    fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { base, post };
}

const render = (items = 2) => ({
  person: jpegUrl(),
  gender: 'male',
  items: [{ slot: 'top', image: jpegUrl() }, { slot: 'shoes', image: jpegUrl() }].slice(0, items),
});

const claude: Claude = {
  tag: async () => ({ name: 'x', category: 'top', color: 'c', style: 's', formality: 'casual', notes: '' }),
  advise: async () => ({ verdict: 'v', gap: 'g', duplicates: [], outfits: [] }),
};
const closetBody = () => ({
  closet: [{ id: 'a', name: 'n', category: 'bottom', color: 'c', style: 's', formality: 'casual', notes: '' }],
  candidate: { name: 'n', category: 'top', color: 'c', style: 's', formality: 'casual', notes: '' },
});

describe('render limits', () => {
  it('refuses a try-on that would pass the hourly step limit, before any YouCam call', async () => {
    const fake = fakeYoucam();
    const { post } = await start({ youcam: fake.client, limits: limits(3, 100) });

    expect((await post('/api/render', render(2))).status).toBe(200); // 2 of 3 steps
    const second = await post('/api/render', render(2)); // needs 2, only 1 left
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toBeTruthy();
    expect(((await second.json()) as any).error).toContain('hourly limit');
    expect(fake.tasks).toHaveLength(2); // nothing ran for the refused request
  });

  it('does not charge for an invalid request', async () => {
    const { post } = await start({ youcam: fakeYoucam().client, limits: limits(2, 100) });
    expect((await post('/api/render', { ...render(2), person: 'nope' })).status).toBe(400);
    expect((await post('/api/render', render(2))).status).toBe(200);
  });

  it('allows one try-on at a time per visitor, and a refused click costs nothing', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = fakeYoucam();
    const slow: YoucamClient = {
      ...fake.client,
      runTask: async (task, body) => {
        await gate;
        return fake.client.runTask(task, body);
      },
    };
    const { post } = await start({ youcam: slow, limits: limits(4, 100) }); // room for exactly two 2-step renders

    const first = post('/api/render', render(2)); // starts and waits on the gate
    await new Promise((r) => setTimeout(r, 100));
    const second = await post('/api/render', render(2));
    expect(second.status).toBe(429);
    expect(((await second.json()) as any).error).toContain('already running');

    release();
    expect((await first).status).toBe(200);
    await (await first).text();
    expect((await post('/api/render', render(2))).status).toBe(200); // budget was not spent by the refused click
  });

  it('frees the visitor even when the chain fails', async () => {
    const fake = fakeYoucam({ failOnTask: 1, failWith: new YoucamError('pose', 'error_pose') });
    const { post } = await start({ youcam: fake.client, limits: limits(10, 100) });
    const first = await post('/api/render', render(2));
    expect(await first.text()).toContain('"type":"error"');
    expect((await post('/api/render', render(2))).status).toBe(200);
  });
});

describe('Claude limits', () => {
  it('limits tagging and advice together, and answers 429 with a wait time', async () => {
    const { post } = await start({ youcam: fakeYoucam().client, claude, limits: limits(10, 2) });
    expect((await post('/api/tag', { image: jpegUrl() })).status).toBe(200);
    expect((await post('/api/advise', closetBody())).status).toBe(200);
    const third = await post('/api/tag', { image: jpegUrl() });
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
    expect(((await third.json()) as any).error).toContain('Claude requests');
  });

  it('does not charge for an invalid request', async () => {
    const { post } = await start({ youcam: fakeYoucam().client, claude, limits: limits(10, 1) });
    expect((await post('/api/tag', { image: 'nope' })).status).toBe(400);
    expect((await post('/api/advise', { closet: [] })).status).toBe(400);
    expect((await post('/api/tag', { image: jpegUrl() })).status).toBe(200);
  });
});

describe('security headers', () => {
  it('sends a strict content security policy and the usual hardening headers', async () => {
    const { base } = await start({ youcam: fakeYoucam().client, limits: limits(1, 1) });
    const res = await fetch(`${base}/api/health`);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });
});
