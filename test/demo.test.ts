import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createApp } from '../src/app.js';
import type { Claude } from '../src/claude.js';
import { NO_CLAUDE_KEY, NO_YOUCAM_KEY } from '../src/demo.js';
import { Budget, InFlight } from '../src/limits.js';
import { fakeYoucam, jpegUrl } from './helpers.js';

const servers: Server[] = [];
afterEach(() => {
  while (servers.length) servers.pop()!.close();
  delete process.env.TRUST_PROXY;
});

async function start(deps: Parameters<typeof createApp>[0] = {}) {
  const server = createApp(deps).listen(0);
  servers.push(server);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// The hosted demo has no keys. These make sure that is a supported, friendly state.
const withoutKeys = () => {
  delete process.env.YOUCAM_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
};

describe('GET /api/status', () => {
  it('says a keyless server is a demo', async () => {
    withoutKeys();
    const base = await start();
    expect(await (await fetch(`${base}/api/status`)).json()).toEqual({ claude: false, youcam: false, demo: true });
  });

  it('says a server with both services is not a demo', async () => {
    const claude: Claude = { tag: async () => ({}) as any, advise: async () => ({}) as any };
    const base = await start({ youcam: fakeYoucam().client, claude });
    expect(await (await fetch(`${base}/api/status`)).json()).toEqual({ claude: true, youcam: true, demo: false });
  });

  it('is not a demo when only one service is configured', async () => {
    withoutKeys();
    const base = await start({ youcam: fakeYoucam().client });
    const status = (await (await fetch(`${base}/api/status`)).json()) as any;
    expect(status).toEqual({ claude: false, youcam: true, demo: false });
  });

  it('never reveals a key', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-secret-value-123';
    process.env.YOUCAM_API_KEY = 'youcam-secret-value-456';
    try {
      const base = await start();
      const text = await (await fetch(`${base}/api/status`)).text();
      expect(text).not.toContain('secret-value');
    } finally {
      withoutKeys();
    }
  });
});

describe('keyless messages', () => {
  it('tell a visitor what to do instead of only what is missing', () => {
    for (const message of [NO_CLAUDE_KEY, NO_YOUCAM_KEY]) {
      expect(message).toContain('sample');
      expect(message).toContain('locally');
      expect(message).toContain('README');
    }
    expect(NO_CLAUDE_KEY).toContain('ANTHROPIC_API_KEY');
    expect(NO_YOUCAM_KEY).toContain('YOUCAM_API_KEY');
  });

  it('are what the routes answer with when there are no keys', async () => {
    withoutKeys();
    const base = await start();
    const post = (route: string, body: unknown) =>
      fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const tag = await post('/api/tag', { image: jpegUrl() });
    expect(tag.status).toBe(503);
    expect(((await tag.json()) as any).error).toBe(NO_CLAUDE_KEY);
    const render = await post('/api/render', { person: jpegUrl(), items: [{ slot: 'top', image: jpegUrl() }] });
    expect(render.status).toBe(503);
    expect(((await render.json()) as any).error).toBe(NO_YOUCAM_KEY);
  });

  it('still serve the page and every sample file', async () => {
    withoutKeys();
    const base = await start();
    for (const file of ['/', '/samples/samples.json', '/samples/precomputed.json', '/samples/person.jpg']) {
      expect((await fetch(base + file)).status, file).toBe(200);
    }
  });
});

describe('TRUST_PROXY', () => {
  const claude: Claude = {
    tag: async () => ({ name: 'x', category: 'top', color: 'c', style: 's', formality: 'casual', notes: '' }),
    advise: async () => ({ verdict: '', gap: '', duplicates: [], outfits: [] }),
  };
  const limits = () => ({
    claude: new Budget({ perVisitorPerHour: 1, perDay: 1000 }),
    render: new Budget({ perVisitorPerHour: 10, perDay: 1000 }),
    inFlight: new InFlight(),
  });
  const tag = (base: string, forwardedFor: string) =>
    fetch(`${base}/api/tag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': forwardedFor },
      body: JSON.stringify({ image: jpegUrl() }),
    });

  it('tells visitors apart by their forwarded address when behind a proxy', async () => {
    process.env.TRUST_PROXY = '1';
    const base = await start({ youcam: fakeYoucam().client, claude, limits: limits() });
    expect((await tag(base, '203.0.113.1')).status).toBe(200);
    expect((await tag(base, '203.0.113.2')).status).toBe(200); // a different visitor, so a different budget
    expect((await tag(base, '203.0.113.1')).status).toBe(429);
  });

  it('ignores a forged forwarded address when not behind a proxy', async () => {
    const base = await start({ youcam: fakeYoucam().client, claude, limits: limits() });
    expect((await tag(base, '203.0.113.1')).status).toBe(200);
    expect((await tag(base, '203.0.113.2')).status).toBe(429); // same real address: the header is not trusted
  });
});

describe('deployment files', () => {
  const root = process.cwd();
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const yaml = readFileSync(path.join(root, 'render.yaml'), 'utf8');

  it('start works on a server with no .env file', () => {
    expect(pkg.scripts.start).toContain('--env-file-if-exists');
    expect(pkg.scripts.start).not.toMatch(/--env-file=/);
  });

  it('has the TypeScript runner as a runtime dependency, because a server may skip devDependencies', () => {
    expect(pkg.dependencies.tsx).toBeDefined();
    expect(pkg.devDependencies.tsx).toBeUndefined();
  });

  it('has a Render blueprint that runs the app and carries no secrets', () => {
    expect(existsSync(path.join(root, 'render.yaml'))).toBe(true);
    expect(yaml).toContain('startCommand: npm start');
    expect(yaml).toContain('healthCheckPath: /api/health');
    expect(yaml).toMatch(/key: NODE_VERSION\s+value: "22"/);
    expect(yaml).toMatch(/key: TRUST_PROXY/);
    expect(yaml).not.toMatch(/(YOUCAM|ANTHROPIC)_API_KEY/);
    expect(yaml).not.toMatch(/sk-ant|Bearer/i);
  });

  it('keeps the engine requirement that matches the Render Node version', () => {
    expect(pkg.engines.node).toBe('>=22');
  });
});
