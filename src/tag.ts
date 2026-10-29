import type { Request, RequestHandler, Response } from 'express';
import { BadRequest, parseDataUrl } from './images.js';
import { ClaudeError, type Claude } from './claude.js';
import { limitMessage, type Budget } from './limits.js';
import { AdviceRequestSchema } from './schema.js';

type GetClaude = () => Claude | null;

// Both Claude routes share the same key check, spending limit and failure handling.
async function withClaude<T>(
  req: Request,
  res: Response,
  getClaude: GetClaude,
  budget: Budget,
  work: (claude: Claude) => Promise<T>,
  label: string,
  wrap: (value: T) => unknown,
) {
  const claude = getClaude();
  if (!claude) return void res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set on the server.' });

  const gate = budget.consume(req.ip ?? 'unknown');
  if (!gate.ok) {
    res.set('Retry-After', String(gate.retryAfterSec));
    return void res.status(429).json({ error: limitMessage(gate, 'Claude requests') });
  }

  try {
    res.json(wrap(await work(claude)));
  } catch (err) {
    if (err instanceof ClaudeError) {
      console.error(`${label} failed:`, err.message);
      return void res.status(502).json({ error: err.userMessage });
    }
    throw err;
  }
}

export function tagHandler(getClaude: GetClaude, budget: Budget): RequestHandler {
  return async (req, res) => {
    let image;
    try {
      image = parseDataUrl(req.body?.image, 'The photo');
    } catch (err) {
      if (err instanceof BadRequest) return void res.status(400).json({ error: err.message });
      throw err;
    }
    await withClaude(req, res, getClaude, budget, (c) => c.tag(image), 'tagging', (tags) => ({ tags }));
  };
}

export function adviseHandler(getClaude: GetClaude, budget: Budget): RequestHandler {
  return async (req, res) => {
    const parsed = AdviceRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const closetEmpty = !Array.isArray(req.body?.closet) || req.body.closet.length === 0;
      return void res.status(400).json({
        error: closetEmpty ? 'Add some of your own clothes to the closet first.' : 'That request was not valid.',
      });
    }
    const { closet, candidate } = parsed.data;
    await withClaude(req, res, getClaude, budget, (c) => c.advise(closet, candidate), 'advice', (advice) => ({ advice }));
  };
}
