import { describe, expect, it } from 'vitest';
import { createYoucamClient, YoucamError } from '../src/youcam.js';

const KEY = 'test-secret-key-123';
const BASE = 'https://api.test';

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown };
type Reply = { status?: number; json?: unknown; bytes?: Uint8Array };

// A fake fetch that answers from a queue and records every call.
function fakeFetch(replies: Reply[]) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
    calls.push({
      method: init.method ?? 'GET',
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body,
    });
    const r = replies.shift();
    if (!r) throw new Error(`unexpected call to ${url}`);
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => r.json ?? {},
      arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer,
    } as Response;
  }) as unknown as typeof fetch;
  return { f, calls };
}

const client = (replies: Reply[], extra = {}) => {
  const { f, calls } = fakeFetch(replies);
  const c = createYoucamClient({
    apiKey: KEY,
    baseUrl: BASE,
    fetch: f,
    sleep: async () => {},
    pollIntervalMs: 1000,
    timeoutMs: 3000,
    ...extra,
  });
  return { c, calls };
};

describe('upload', () => {
  it('registers the file, PUTs the bytes to the signed URL, and returns the file id', async () => {
    const { c, calls } = client([
      {
        json: {
          data: {
            files: [
              {
                file_id: 'f1',
                requests: [{ method: 'PUT', url: 'https://upload.test/x', headers: { 'Content-Type': 'image/jpg' } }],
              },
            ],
          },
        },
      },
      {},
    ]);
    const id = await c.upload(new Uint8Array([1, 2, 3]), 'me.jpg', 'image/jpeg');
    expect(id).toBe('f1');
    expect(calls[0]?.url).toBe(`${BASE}/s2s/v2.0/file`);
    expect(calls[0]?.body).toEqual({ files: [{ content_type: 'image/jpg', file_name: 'me.jpg', file_size: 3 }] });
    expect(calls[1]?.method).toBe('PUT');
    expect(calls[1]?.url).toBe('https://upload.test/x');
  });

  it('keeps image/png as image/png', async () => {
    const { c, calls } = client([
      { json: { data: { files: [{ file_id: 'f', requests: [{ method: 'PUT', url: 'https://u.test', headers: {} }] }] } } },
      {},
    ]);
    await c.upload(new Uint8Array(1), 'a.png', 'image/png');
    expect((calls[0]?.body as any).files[0].content_type).toBe('image/png');
  });
});

describe('runTask', () => {
  it('polls until success and returns the result url', async () => {
    const { c, calls } = client([
      { json: { data: { task_id: 't1' } } },
      { json: { data: { task_status: 'running' } } },
      { json: { data: { task_status: 'success', results: { url: 'https://result.test/a.jpg' } } } },
    ]);
    const url = await c.runTask('cloth-v4', { src_file_id: 'a', ref_file_id: 'b', garment_category: 'upper_body' });
    expect(url).toBe('https://result.test/a.jpg');
    expect(calls[0]?.url).toBe(`${BASE}/s2s/v2.0/task/cloth-v4`);
    expect(calls[2]?.url).toBe(`${BASE}/s2s/v2.0/task/cloth-v4/t1`);
  });

  it.each([
    ['error_pose', 'pose'],
    ['error_multi_person', 'multi_person'],
    ['error_invalid_src', 'invalid_photo'],
    ['error_no_face', 'invalid_photo'],
    ['exceed_max_filesize', 'too_large'],
    ['error_nsfw_content_detected', 'nsfw'],
  ])('maps a task error %s to %s', async (raw, code) => {
    const { c } = client([
      { json: { data: { task_id: 't' } } },
      { json: { data: { task_status: 'error', error: raw } } },
    ]);
    const err = await c.runTask('cloth-v4', {}).catch((e) => e);
    expect(err).toBeInstanceOf(YoucamError);
    expect(err.code).toBe(code);
    expect(err.userMessage.length).toBeGreaterThan(10);
  });

  it('reads the error code when it is nested in an object', async () => {
    const { c } = client([
      { json: { data: { task_id: 't' } } },
      { json: { data: { task_status: 'error', error: { code: 'error_pose' } } } },
    ]);
    const err = await c.runTask('cloth-v4', {}).catch((e) => e);
    expect(err.code).toBe('pose');
  });

  it('times out when the task never finishes', async () => {
    const { c } = client([
      { json: { data: { task_id: 't' } } },
      { json: { data: { task_status: 'running' } } },
      { json: { data: { task_status: 'running' } } },
      { json: { data: { task_status: 'running' } } },
    ]);
    const err = await c.runTask('cloth-v4', {}).catch((e) => e);
    expect(err.code).toBe('timeout');
  });

  it('maps a 401 to auth', async () => {
    const { c } = client([{ status: 401, json: { error_code: 'InvalidAccessToken' } }]);
    const err = await c.runTask('cloth-v4', {}).catch((e) => e);
    expect(err.code).toBe('auth');
  });

  it('maps a 429 to rate_limited and an unknown failure to upstream', async () => {
    const a = client([{ status: 429, json: {} }]);
    expect((await a.c.runTask('x', {}).catch((e) => e)).code).toBe('rate_limited');
    const b = client([{ status: 500, json: {} }]);
    expect((await b.c.runTask('x', {}).catch((e) => e)).code).toBe('upstream');
  });
});

describe('secrets and downloads', () => {
  it('sends the key only as a Bearer header and never puts it in an error', async () => {
    const { c, calls } = client([{ status: 401, json: { error_code: 'InvalidAccessToken' } }]);
    const err = await c.runTask('cloth-v4', {}).catch((e) => e);
    expect(calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(err.message).not.toContain(KEY);
    expect(err.userMessage).not.toContain(KEY);
  });

  it('downloads results without an Authorization header', async () => {
    const { c, calls } = client([{ bytes: new Uint8Array([9, 8, 7]) }]);
    const buf = await c.download('https://result.test/a.jpg');
    expect([...buf]).toEqual([9, 8, 7]);
    expect(calls[0]?.headers.Authorization).toBeUndefined();
  });

  it('refuses to start without a key', () => {
    expect(() => createYoucamClient({ apiKey: '' })).toThrow('YOUCAM_API_KEY');
  });
});
