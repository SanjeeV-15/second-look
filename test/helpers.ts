import { YoucamError, type YoucamClient } from '../src/youcam.js';

export interface TaskCall {
  task: string;
  body: Record<string, unknown>;
}

// A fake YouCam: uploads get sequential ids, tasks return predictable URLs, and failures can be scripted.
export function fakeYoucam(opts: { failOnTask?: number; failWith?: YoucamError } = {}) {
  const uploads: string[] = [];
  const tasks: TaskCall[] = [];
  const client: YoucamClient = {
    async upload(_bytes, fileName) {
      uploads.push(fileName);
      return `file-${uploads.length}`;
    },
    async runTask(task, body) {
      tasks.push({ task, body });
      if (opts.failOnTask === tasks.length) throw opts.failWith ?? new YoucamError('pose', 'error_pose');
      return `https://result.test/${tasks.length}.jpg`;
    },
    async download(url) {
      return Buffer.from(`image-of-${url}`);
    },
  };
  return { client, uploads, tasks };
}

// Smallest bytes that pass the JPEG / PNG signature check.
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
export const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
export const jpegUrl = (b: Buffer = JPEG) => `data:image/jpeg;base64,${b.toString('base64')}`;
export const pngUrl = (b: Buffer = PNG) => `data:image/png;base64,${b.toString('base64')}`;
