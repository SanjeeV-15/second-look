// Pure helpers shared by the page and the sample generator, so the two always agree on which
// pre-generated result matches a given person and set of pieces. No DOM, no network.

// Only these can be rendered, and the chain always runs them in this order.
export const WEARABLE_ORDER = ['top', 'shoes'];

const base = (file) => file.replace(/\.[^.]+$/, '');

// Items come from the page (sampleFile) or from samples.json (file).
const fileOf = (item) => item.sampleFile ?? item.file;

// The pieces a try-on would render: the first top and the first pair of shoes, in chain order.
export function wearableItems(items) {
  const picked = [];
  for (const category of WEARABLE_ORDER) {
    const item = items.find((i) => i.category === category);
    if (item) picked.push(item);
  }
  return picked;
}

export function tryOnKey(personFile, items) {
  const files = wearableItems(items).map(fileOf);
  return personFile && files.length ? `${personFile}|${files.join('+')}` : null;
}

// Where a pre-generated result lives, relative to /samples/.
export function resultFile(key) {
  const [person, pieces] = key.split('|');
  return `results/${base(person)}__${pieces.split('+').map(base).join('__')}.jpg`;
}

// If a user edits a sample piece's details, it no longer matches the pre-generated advice.
export function tagSignature(item) {
  return JSON.stringify([item.name, item.category, item.color, item.style, item.formality, item.notes]);
}

// A short fingerprint of the sample closet (which pieces, with which details). The pre-generated advice is
// written for one specific closet, so it is only valid while this still matches.
export function closetSignature(closet) {
  const text = closet.map((c) => c.file + ':' + tagSignature(c)).join('|');
  let hash = 0x811c9dc5; // FNV-1a, 32 bit: the same result in Node and in the browser
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return hash.toString(16).padStart(8, '0');
}

// Every try-on the sample walkthrough can reach: each wearable candidate on its own, each outfit in the
// pre-generated advice, and each top-and-shoes pair from the tray.
export function planTryOns(manifest, advice) {
  const closet = new Map(manifest.closet.map((c) => [c.file, c]));
  const found = new Map();
  const add = (items) => {
    const key = tryOnKey(manifest.person.file, items);
    if (key && !found.has(key)) found.set(key, wearableItems(items));
  };

  for (const candidate of manifest.candidates) {
    add([candidate]);
    for (const outfit of advice[candidate.file]?.outfits ?? []) {
      add([candidate, ...outfit.files.map((f) => closet.get(f)).filter(Boolean)]);
    }
  }
  const tops = manifest.candidates.filter((c) => c.category === 'top');
  const shoes = manifest.candidates.filter((c) => c.category === 'shoes');
  for (const t of tops) for (const s of shoes) add([t, s]);

  return [...found].map(([key, items]) => ({ key, items }));
}
