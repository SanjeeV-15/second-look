import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { createClaudeFromEnv, type Claude } from './claude.js';
import { limitsFromEnv, type Limits } from './limits.js';
import { renderHandler } from './render.js';
import { adviseHandler, tagHandler } from './tag.js';
import { createYoucamClientFromEnv, type YoucamClient } from './youcam.js';

export interface AppDeps {
  youcam?: YoucamClient;
  claude?: Claude;
  limits?: Limits;
}

// Everything the page loads comes from this server; images may also be data: or blob: URLs.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export function createApp(deps: AppDeps = {}) {
  const app = express();
  const limits = deps.limits ?? limitsFromEnv();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set({
      'Content-Security-Policy': CSP,
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
    });
    next();
  });
  app.use(express.json({ limit: '25mb' }));

  // Built on first use so the server still starts (and says why) when the key is missing.
  let client: YoucamClient | null = deps.youcam ?? null;
  const getClient = () => {
    if (!client) {
      try {
        client = createYoucamClientFromEnv();
      } catch {
        return null;
      }
    }
    return client;
  };

  let claude: Claude | null = deps.claude ?? null;
  const getClaude = () => {
    if (!claude) {
      try {
        claude = createClaudeFromEnv();
      } catch {
        return null;
      }
    }
    return claude;
  };

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.post('/api/render', renderHandler(getClient, limits));
  app.post('/api/tag', tagHandler(getClaude, limits.claude));
  app.post('/api/advise', adviseHandler(getClaude, limits.claude));

  app.use(express.static(path.join(process.cwd(), 'public')));

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === 'number' ? err.status : 500;
    if (status >= 500) console.error('request failed:', err?.message ?? err);
    const message = status === 413 ? 'That upload is too large.' : status < 500 ? 'Bad request.' : 'Server error.';
    if (!res.headersSent) res.status(status).json({ error: message });
  };
  app.use(onError);

  return app;
}
