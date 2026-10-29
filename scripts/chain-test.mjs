// Feasibility test for chaining: person + top, then that result + shoes.
// Usage: node --env-file=.env scripts/chain-test.mjs <person> <top> <shoes> [gender]
// Costs 4 YouCam units (2 per step). Saves each step in out/.
import { writeFile, mkdir } from 'node:fs/promises';
import { upload, runTask } from './youcam.mjs';

const [personPath, topPath, shoesPath, gender = 'male'] = process.argv.slice(2);
if (!personPath || !topPath || !shoesPath) {
  throw new Error('Usage: chain-test.mjs <person> <top> <shoes> [gender]');
}

async function save(url, name) {
  await mkdir('out', { recursive: true });
  const res = await fetch(url);
  const file = `out/${name}-${Date.now()}.jpg`;
  await writeFile(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

const [personId, topId, shoesId] = await Promise.all([
  upload(personPath),
  upload(topPath),
  upload(shoesPath),
]);

let t = Date.now();
const withTop = await runTask('cloth-v4', {
  src_file_id: personId,
  ref_file_id: topId,
  garment_category: 'upper_body',
});
console.log(`step 1 (top) ok in ${Math.round((Date.now() - t) / 1000)}s: ${await save(withTop, 'step1-top')}`);

t = Date.now();
const withShoes = await runTask('shoes-transfer', {
  src_file_url: withTop,
  ref_file_id: shoesId,
  gender,
  style: 'random',
});
console.log(`step 2 (shoes) ok in ${Math.round((Date.now() - t) / 1000)}s: ${await save(withShoes, 'step2-shoes')}`);
