// Minimal YouCam client shared by the test scripts: upload a file, run a task, return the result URL.
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const KEY = process.env.YOUCAM_API_KEY;
const BASE = process.env.YOUCAM_BASE_URL || 'https://yce-api-01.makeupar.com';

if (!KEY) throw new Error('YOUCAM_API_KEY is empty. Paste it into .env first.');

const headers = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

async function api(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${JSON.stringify(json)}`);
  return json;
}

export async function upload(filePath) {
  const bytes = await readFile(filePath);
  const contentType = path.extname(filePath).toLowerCase() === '.png' ? 'image/png' : 'image/jpg';
  const reg = await api('POST', '/s2s/v2.0/file', {
    files: [{ content_type: contentType, file_name: path.basename(filePath), file_size: bytes.length }],
  });
  const file = reg.data.files[0];
  const put = file.requests[0];
  const res = await fetch(put.url, { method: put.method, headers: put.headers, body: bytes });
  if (!res.ok) throw new Error(`Upload of ${filePath} failed: ${res.status}`);
  return file.file_id;
}

// task: e.g. 'cloth-v4' or 'shoes-transfer'. Returns the URL of the result image.
export async function runTask(task, body, { timeoutMs = 120_000 } = {}) {
  const created = await api('POST', `/s2s/v2.0/task/${task}`, body);
  const taskId = created.data.task_id;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 3000));
    const { data } = await api('GET', `/s2s/v2.0/task/${task}/${taskId}`);
    if (data.task_status === 'success') return data.results.url;
    if (data.task_status === 'error') throw new Error(`${task} failed: ${JSON.stringify(data.error)}`);
  }
  throw new Error(`${task} timed out after ${timeoutMs / 1000}s`);
}
