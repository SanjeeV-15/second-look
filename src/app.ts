import express, { type ErrorRequestHandler } from 'express';
import path from 'node:path';
import { createClaudeFromEnv, type Claude } from './claude.js';
import { renderHandler } from './render.js';
import { adviseHandler, tagHandler } from './tag.js';
import { createYoucamClientFromEnv, type YoucamClient } from './youcam.js';

export interface AppDeps {
  youcam?: YoucamClient;
  claude?: Claude;
}

export function createApp(deps: AppDeps = {}) {
  const app = express();
  app.disable('x-powered-by');
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

  app.post('/api/render', renderHandler(getClient));
  app.post('/api/tag', tagHandler(getClaude));
  app.post('/api/advise', adviseHandler(getClaude));

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
