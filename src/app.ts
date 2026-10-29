import express from 'express';
import path from 'node:path';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '25mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(express.static(path.join(process.cwd(), 'public')));
  return app;
}
