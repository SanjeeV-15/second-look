# Plan: closet-aware outfit try-on (YouCam hackathon)

Deadline: 2026-11-02 11:45am EST. Submit by the evening of 2026-11-01.

## What it is

You keep a digital closet (photos of your own clothes, shoes and accessories). When you find something you might buy, you add its photo. Claude says what it goes with from your closet, whether you already own something too similar, and what gap it fills. YouCam then shows the full outfit on a photo of you, one piece at a time.

## Proven by real runs (2026-10-29)

- Top then shoes chain works: `cloth-v4` with `upper_body`, then the result URL as `src_file_url` into `shoes-transfer`. No visible drift, about 27 s, 4 units.
- `full_body` changes shoes unasked, so always pass a specific category.
- Images: JPG or PNG, long side at most 4096 px, under 10 MB, one person, standing, facing forward.

## Not yet proven (kept out of the core)

- Bottoms (`cloth-v4` `lower_body`; docs say the reference must be a worn photo, not a product shot).
- Hat, bag, scarf, watch, jewelry APIs.
- Chains of three or more steps.

Each gets its own one-off test (2 units each) before it goes into the app.

## Stack

- Node 22, TypeScript, Express, vitest. Plain HTML/CSS/JS front end served by Express, no build step.
- Anthropic SDK, `claude-sonnet-5-5` (env `CLAUDE_MODEL`), vision for tagging and a structured tool call for outfit proposals.
- YouCam via plain `fetch` (`scripts/youcam.mjs` becomes `src/youcam.ts`).
- Port 4320 (other projects use 3000, 3010, 4310).

## Data and privacy

- The closet lives in the browser (IndexedDB). Images are resized to at most 1536 px on upload.
- The server stores nothing: each request carries the images it needs, and nothing is logged except status and timings.
- YouCam holds uploaded files for its own retention period. Read `/develop/file_retention_period` and state it in the README.
- Keys only in `.env`. No hosted demo: judges run it with their own YouCam and Anthropic keys, so the README must make setup take minutes.

## Item model

```
{ id, name, category: top | bottom | shoes | outerwear | accessory,
  color, style, formality, notes, imageDataUrl, source: closet | candidate }
```

Claude fills everything except `id`, `imageDataUrl` and `source`. The user can edit any field.

## Flow

1. **Your photo:** upload once. Check size and type in the browser, and show tips (standing, facing forward, plain background).
2. **Closet:** add items in bulk. Each image goes to `POST /api/tag`, and Claude returns the fields above.
3. **Try something new:** add a candidate item. `POST /api/advise` sends the closet as JSON (no images) plus the candidate's tags. Claude returns 1 to 3 outfits, each a list of item ids with a one-line reason, plus a duplicate warning and a gap note.
4. **Render:** the user picks an outfit. `POST /api/render` runs the chain in this order: top, then bottom (if enabled), then shoes, then accessories. Progress streams over SSE. Each finished step is sent back as an image, so the person sees the outfit build up.
5. **Compare:** before and after, with the closest owned alternative shown beside the candidate.

## Failure handling

- `error_pose`, `error_multi_person`, `error_invalid_src`: tell the user what to change about their photo.
- `error_nsfw_content_detected`, timeout (120 s), 401: clear message, no retry loop.
- A step fails halfway: keep and show the steps already finished.
- Caps: per-visitor Claude and YouCam call limits and a daily total, so a stuck loop can't burn credit.

## Files

```
src/server.ts        Express app, routes, SSE
src/youcam.ts        upload, runTask, error mapping
src/chain.ts         ordered render chain, progress events
src/claude.ts        tag + advise calls, prompts, schemas
src/schema.ts        item model and validation
src/limits.ts        call caps
public/index.html, app.js, styles.css, closet.js (IndexedDB)
test/                vitest with fake YouCam and fake Claude
scripts/             one-off API tests
docs/PLAN.md, README.md, .env.example
```

## Build order

| Day | Steps |
|---|---|
| Thu 10-29 | 0. Scaffold, commit. 1. `src/youcam.ts` plus tests. 2. Render route with a top then shoes chain and SSE. |
| Fri 10-30 | 3. Closet storage and tagging (`/api/tag`). 4. Advise route and outfit UI. 5. Wire render to the chosen outfit. |
| Sat 10-31 | 6. Test bottoms and one accessory, add only if they pass. 7. Error states, caps, README, `.env.example`, license. 8. Feature freeze in the evening. |
| Sun 11-01 | Screenshots, your demo video and Devpost text, push from your terminal, submit in the evening. |

## Paid calls (confirmed with you before each run)

- YouCam: 2 units per step. A full 3-step outfit is 6 units. About 10 of 1,000 used so far.
- Claude: tagging is roughly a cent per item, advising a few cents per request. I'll state the estimate before any run.

## Risks

1. Quality drift on chains longer than two steps: test before promising it.
2. Bottoms may not work from product photos: keep them optional.
3. Judges need their own keys: make setup short and the README plain.
4. Face photos are sensitive: process in memory, store nothing, say so.
5. Demo material must be your own clothes and photo, not stock images or brand logos.
