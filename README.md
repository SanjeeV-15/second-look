# Closet Try-On

A closet-aware outfit try-on, built on the YouCam API for the YouCam API Skin AI & eCommerce VTO Hackathon.

You keep a digital closet of your own clothes. When you find something you might buy, you add its photo. Claude compares it with your closet and says what it goes with, what it duplicates, and what it adds. YouCam then shows the outfit on a photo of you, one piece at a time.

## What it does

1. **Your photo.** Upload one photo of yourself and choose a shoe fit (men's or women's).
2. **Your closet.** Add photos of your clothes. Claude fills in each item's name, category, colour, style and formality. Every field can be edited. The closet is stored in your browser.
3. **Thinking of buying something?** Add a photo of the piece. Claude returns:
   - a short, honest verdict (it can say not to buy),
   - what the piece adds, or why it overlaps with what you own,
   - closet items that are close duplicates,
   - up to three outfits built from the piece and your own clothes.
4. **See it on me.** The outfit is rendered on your photo with YouCam, step by step. Each step appears as it finishes, with a before and after at the end. You can also try the new piece alone.
5. **I bought it.** Move the piece into your closet.

## How it uses the YouCam API

| Step | Endpoint | Notes |
|---|---|---|
| Upload | `POST /s2s/v2.0/file`, then `PUT` to the returned URL | Person photo and each garment photo |
| Top | `POST /s2s/v2.0/task/cloth-v4` with `garment_category: "upper_body"` | AI Clothes try-on |
| Shoes | `POST /s2s/v2.0/task/shoes-transfer` with `gender` | AI Shoes try-on |
| Poll | `GET /s2s/v2.0/task/{task}/{task_id}` | Until `task_status` is `success` |

- **Chaining.** Each step's result becomes the next step's input (`src_file_url`), so a top followed by shoes shows both on the same photo. The order is top, then shoes. Each piece is 2 YouCam units and about 15 to 20 seconds.
- **Category.** The clothes call always names `upper_body`. In testing, `full_body` also changed the shoes without being asked.
- **Errors.** YouCam error codes (`error_pose`, `error_multi_person`, `exceed_max_filesize`, and others) are mapped to plain messages. If a later step fails, the steps that finished are kept.
- The API key is sent only in the `Authorization` header and never appears in an error message.

## How it uses Claude

- **Tagging** (`POST /api/tag`): one photo in, structured JSON out (category, name, colour, style, formality, notes). Uses structured outputs at low effort.
- **Advice** (`POST /api/advise`): the closet as text tags (never photos) plus the new piece. The server checks every id Claude returns against the closet, allows one piece per category, and drops any outfit that would be empty, so the model cannot invent items.
- Default model is `claude-sonnet-5-5`, set with `CLAUDE_MODEL`.

## Privacy

- Your closet and photos live in your browser (IndexedDB). The server stores nothing and logs only status and timings.
- Photos are sent to the server only when you add an item (to be tagged) or ask for a try-on. From there they go to Anthropic (tagging) and to YouCam (try-on). YouCam keeps uploaded files for its own retention period; see its documentation on file retention.
- Advice requests contain text tags only.

## Run it

Requires Node 22 or newer.

```bash
npm install
cp .env.example .env
```

Fill in `.env`:

| Variable | Where to get it |
|---|---|
| `YOUCAM_API_KEY` | [YouCam API console](https://yce.makeupar.com/api-console/en/api-keys/). Hackathon participants get free units by redeeming the code from Devpost under Account, then Redeem Code. |
| `ANTHROPIC_API_KEY` | [Anthropic console](https://console.anthropic.com/) |

```bash
npm run dev
```

Open http://localhost:4320. Use a recent Chrome, Edge, Firefox or Safari.

### Photo tips

- **You:** one person, standing and facing the camera, arms relaxed, whole body in frame, plain background. JPG or PNG.
- **Closet and new pieces:** one item per photo, front-facing, on a plain background. Product-style photos work best for the try-on.

## Spending limits

The server counts calls so a bug or a stuck client cannot burn credit. State is in memory and resets when the server restarts. Override with environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `LIMIT_CLAUDE_PER_HOUR` | 100 | Tagging and advice calls per visitor per hour |
| `LIMIT_CLAUDE_PER_DAY` | 500 | Same, for the whole server per day |
| `LIMIT_RENDER_STEPS_PER_HOUR` | 30 | Try-on steps per visitor per hour (2 YouCam units each) |
| `LIMIT_RENDER_STEPS_PER_DAY` | 150 | Same, for the whole server per day |

Each visitor can also run only one try-on at a time.

## Known limits

- **Only tops and shoes are shown on you.** Bottoms, outerwear, hats, bags and other accessories appear in outfits as suggestions. Three of these were ruled out by the docs or by live tests: the clothes API says lower-body references must be photos of the item being worn, not product shots; the watch API needs a photo of your wrist; and the hat and bag APIs, when chained after a try-on, regenerated the whole picture as a new styled scene (new background, new clothes, a different pose), which would misrepresent the try-on.
- **The result is generated, not pasted.** YouCam regenerates the garment on your body, so the cut can differ slightly from the product photo.
- **Photos matter.** A photo that is not front-facing, or shows more than one person, may be rejected by YouCam.
- **A try-on takes time.** About 15 to 20 seconds per piece.

## Project layout

```
src/app.ts        Express app and routes
src/youcam.ts     YouCam client: upload, run task, poll, error mapping
src/chain.ts      Ordered render chain and progress events
src/render.ts     POST /api/render (streams progress as server-sent events)
src/claude.ts     Tagging and advice calls to Claude
src/advice.ts     Checks Claude's outfits against the real closet
src/limits.ts     Spending limits
public/           The page: index.html, app.js, closet.js (IndexedDB), image.js, styles.css
test/             vitest, with fake YouCam and fake Claude (no network, no cost)
docs/PLAN.md      The build plan
```

## Tests

```bash
npm test
npm run typecheck
```

Tests use fakes for both APIs, so they call no network and cost nothing.

## License

MIT
