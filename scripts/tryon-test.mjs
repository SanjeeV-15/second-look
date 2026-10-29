// One-off feasibility test: person photo + one garment photo -> try-on image.
// Usage: node --env-file=.env scripts/tryon-test.mjs <person.jpg> <garment.jpg> [garment_category]
// Costs 2 YouCam units per run.
import { writeFile, mkdir } from 'node:fs/promises';
import { upload, runTask } from './youcam.mjs';

const [personPath, garmentPath, category = 'upper_body'] = process.argv.slice(2);
if (!personPath || !garmentPath) {
  throw new Error('Usage: tryon-test.mjs <person.jpg> <garment.jpg> [garment_category]');
}

const [srcId, refId] = await Promise.all([upload(personPath), upload(garmentPath)]);
const started = Date.now();
const url = await runTask('cloth-v4', {
  src_file_id: srcId,
  ref_file_id: refId,
  garment_category: category,
});

await mkdir('out', { recursive: true });
const outPath = `out/tryon-${Date.now()}.jpg`;
await writeFile(outPath, Buffer.from(await (await fetch(url)).arrayBuffer()));
console.log(`saved ${outPath} in ${Math.round((Date.now() - started) / 1000)}s`);
