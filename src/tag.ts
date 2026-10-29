import type { RequestHandler } from 'express';
import { BadRequest, parseDataUrl } from './images.js';
import { ClaudeError, type Tagger } from './claude.js';

export function tagHandler(getTagger: () => Tagger | null): RequestHandler {
  return async (req, res) => {
    let image;
    try {
      image = parseDataUrl(req.body?.image, 'The photo');
    } catch (err) {
      if (err instanceof BadRequest) return void res.status(400).json({ error: err.message });
      throw err;
    }

    const tagger = getTagger();
    if (!tagger) return void res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });

    try {
      res.json({ tags: await tagger.tag(image) });
    } catch (err) {
      if (err instanceof ClaudeError) {
        console.error('tagging failed:', err.message);
        return void res.status(502).json({ error: err.userMessage });
      }
      throw err;
    }
  };
}
