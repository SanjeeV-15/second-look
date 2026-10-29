// YouCam API client: upload an image, run an async task, poll for the result.
// The API key only ever goes in the Authorization header and never into an error message.

export type YoucamErrorCode =
  | 'pose'
  | 'multi_person'
  | 'invalid_photo'
  | 'too_large'
  | 'nsfw'
  | 'auth'
  | 'rate_limited'
  | 'timeout'
  | 'upstream';

const USER_MESSAGES: Record<YoucamErrorCode, string> = {
  pose: "We couldn't read the pose. Stand straight, face the camera, arms relaxed, with your whole body in frame.",
  multi_person: 'Only one person should be in the photo.',
  invalid_photo: "That photo doesn't work. Use a clear JPG or PNG showing your face and body.",
  too_large: 'That photo is too large. Use one under 10 MB.',
  nsfw: 'That image was rejected by the content filter.',
  auth: 'The YouCam API key was rejected. Check YOUCAM_API_KEY.',
  rate_limited: 'YouCam is rate limiting requests. Try again in a moment.',
  timeout: 'The try-on took too long. Try again.',
  upstream: 'YouCam had a problem. Try again.',
};

const RAW_CODES: Record<string, YoucamErrorCode> = {
  error_pose: 'pose',
  error_multi_person: 'multi_person',
  error_invalid_src: 'invalid_photo',
  error_below_min_image_size: 'invalid_photo',
  error_no_face: 'invalid_photo',
  exceed_max_filesize: 'too_large',
  error_nsfw_content_detected: 'nsfw',
  InvalidAccessToken: 'auth',
};

export class YoucamError extends Error {
  readonly code: YoucamErrorCode;
  readonly rawCode?: string;
  readonly userMessage: string;

  constructor(code: YoucamErrorCode, rawCode?: string, detail?: string) {
    super(`YouCam ${code}${rawCode ? ` (${rawCode})` : ''}${detail ? `: ${detail}` : ''}`);
    this.name = 'YoucamError';
    this.code = code;
    this.rawCode = rawCode;
    this.userMessage = USER_MESSAGES[code];
  }
}

// Error codes show up in different places depending on the failure, so look in all of them.
function rawCodeFrom(json: any): string | undefined {
  const candidates = [json?.error_code, json?.data?.error, json?.error];
  for (const c of candidates) {
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object') {
      const nested = c.code ?? c.error_code;
      if (typeof nested === 'string') return nested;
    }
  }
  return undefined;
}

function toError(status: number | undefined, json: any): YoucamError {
  const raw = rawCodeFrom(json);
  if (raw && RAW_CODES[raw]) return new YoucamError(RAW_CODES[raw], raw);
  if (status === 401) return new YoucamError('auth', raw);
  if (status === 429) return new YoucamError('rate_limited', raw);
  return new YoucamError('upstream', raw, status ? `HTTP ${status}` : undefined);
}

export interface YoucamOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type ImageType = 'image/jpeg' | 'image/png';

export interface YoucamClient {
  upload(bytes: Uint8Array, fileName: string, type: ImageType): Promise<string>;
  runTask(task: string, body: Record<string, unknown>): Promise<string>;
  download(url: string): Promise<Buffer>;
}

export function createYoucamClient(opts: YoucamOptions): YoucamClient {
  if (!opts.apiKey) throw new Error('YOUCAM_API_KEY is empty.');
  const base = opts.baseUrl ?? 'https://yce-api-01.makeupar.com';
  const doFetch = opts.fetch ?? fetch;
  const pollIntervalMs = opts.pollIntervalMs ?? 3000;
  const maxPolls = Math.ceil((opts.timeoutMs ?? 120_000) / pollIntervalMs);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function api(method: string, route: string, body?: unknown): Promise<any> {
    const res = await doFetch(base + route, {
      method,
      headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw toError(res.status, json);
    return json;
  }

  return {
    async upload(bytes, fileName, type) {
      const reg = await api('POST', '/s2s/v2.0/file', {
        files: [
          {
            // The API's own examples spell JPEG as image/jpg.
            content_type: type === 'image/png' ? 'image/png' : 'image/jpg',
            file_name: fileName,
            file_size: bytes.byteLength,
          },
        ],
      });
      const file = reg?.data?.files?.[0];
      const put = file?.requests?.[0];
      if (!file?.file_id || !put?.url) throw new YoucamError('upstream', undefined, 'bad upload response');
      // Node's fetch accepts raw bytes; the DOM typings just don't list Uint8Array<ArrayBufferLike>.
      const res = await doFetch(put.url, {
        method: put.method ?? 'PUT',
        headers: put.headers,
        body: bytes as BodyInit,
      });
      if (!res.ok) throw new YoucamError('upstream', undefined, `upload HTTP ${res.status}`);
      return file.file_id as string;
    },

    async runTask(task, body) {
      const created = await api('POST', `/s2s/v2.0/task/${task}`, body);
      const taskId = created?.data?.task_id;
      if (!taskId) throw new YoucamError('upstream', undefined, 'no task id');
      for (let i = 0; i < maxPolls; i++) {
        await sleep(pollIntervalMs);
        const poll = await api('GET', `/s2s/v2.0/task/${task}/${taskId}`);
        const status = poll?.data?.task_status;
        if (status === 'success') {
          const url = poll?.data?.results?.url;
          if (!url) throw new YoucamError('upstream', undefined, 'no result url');
          return url as string;
        }
        if (status === 'error') throw toError(undefined, poll);
      }
      throw new YoucamError('timeout');
    },

    async download(url) {
      // Result URLs are pre-signed, so no Authorization header goes with them.
      const res = await doFetch(url);
      if (!res.ok) throw new YoucamError('upstream', undefined, `download HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

export function createYoucamClientFromEnv(env: NodeJS.ProcessEnv = process.env): YoucamClient {
  return createYoucamClient({
    apiKey: env.YOUCAM_API_KEY ?? '',
    baseUrl: env.YOUCAM_BASE_URL || undefined,
  });
}
