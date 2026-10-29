import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.js';

describe('app', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('answers the health check', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('does not advertise Express', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.headers.get('x-powered-by')).toBeNull();
  });
});
