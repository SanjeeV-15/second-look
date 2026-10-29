import type { RequestHandler } from 'express';
import { BadRequest, parseDataUrl, type Img } from './images.js';
import { NEEDS_GENDER, ORDER, runChain, type Gender, type RenderEvent, type Slot } from './chain.js';
import { limitMessage, type Limits } from './limits.js';
import type { YoucamClient } from './youcam.js';

const MAX_ITEMS = ORDER.length;

// Slots the UI may use today. Bottoms stay off until they pass their own test against the real API.
const ENABLED_SLOTS: Slot[] = ['top', 'shoes'];

function parse(body: any): { person: Img; items: Partial<Record<Slot, Img>>; gender: Gender } {
  const person = parseDataUrl(body?.person, 'Your photo');

  if (!Array.isArray(body?.items) || body.items.length === 0) throw new BadRequest('Add at least one item to try on.');
  if (body.items.length > MAX_ITEMS) throw new BadRequest(`At most ${MAX_ITEMS} items.`);

  const items: Partial<Record<Slot, Img>> = {};
  for (const item of body.items) {
    const slot = item?.slot as Slot;
    if (!ENABLED_SLOTS.includes(slot)) throw new BadRequest(`Unsupported item type: ${String(item?.slot)}.`);
    if (items[slot]) throw new BadRequest(`Only one ${slot} per outfit.`);
    items[slot] = parseDataUrl(item.image, `The ${slot}`);
  }

  // The shoes API takes a gender for the fit; the clothes API does not.
  const given = body?.gender === 'female' ? 'female' : body?.gender === 'male' ? 'male' : null;
  if (!given && NEEDS_GENDER.some((slot) => items[slot])) {
    throw new BadRequest('gender must be "male" or "female" when trying on shoes.');
  }
  return { person, items, gender: given ?? 'male' };
}

export function renderHandler(getClient: () => YoucamClient | null, limits: Limits): RequestHandler {
  return async (req, res) => {
    let input: ReturnType<typeof parse>;
    try {
      input = parse(req.body);
    } catch (err) {
      if (err instanceof BadRequest) return void res.status(400).json({ error: err.message });
      throw err;
    }

    const client = getClient();
    if (!client) return void res.status(503).json({ error: 'YOUCAM_API_KEY is not set on the server.' });

    // Checked after validation so a bad request costs nothing, and in-flight first so a refused
    // second click doesn't use up budget.
    const visitor = req.ip ?? 'unknown';
    if (!limits.inFlight.tryStart(visitor)) {
      return void res.status(429).json({ error: 'A try-on is already running. Wait for it to finish.' });
    }
    const gate = limits.render.consume(visitor, Object.keys(input.items).length);
    if (!gate.ok) {
      limits.inFlight.end(visitor);
      res.set('Retry-After', String(gate.retryAfterSec));
      return void res.status(429).json({ error: limitMessage(gate, 'try-ons') });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let cancelled = false;
    res.on('close', () => {
      cancelled = !res.writableEnded;
    });
    const emit = (event: RenderEvent) => {
      if (!cancelled && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      await runChain({ client, ...input, emit, isCancelled: () => cancelled });
    } finally {
      limits.inFlight.end(visitor);
      res.end();
    }
  };
}
