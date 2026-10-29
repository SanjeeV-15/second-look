import { clearAll, deleteItem, getMeta, listItems, persistent, putItem, setMeta } from './closet.js';
import { takePhoto } from './camera.js';
import { fileToDataUrl, loadSampleImage, loadSampleManifest, postJson, streamRender, tagImage } from './image.js';
import { closetSignature, tagSignature, tryOnKey } from './samplekeys.js';

const CATEGORIES = ['top', 'bottom', 'shoes', 'outerwear', 'hat', 'bag', 'accessory'];
const MAX_CLOSET = 40;
const MAX_TRAY = 8;
const MAX_LOOKS = 8;
// Only these can be shown on the person. Everything else is a text suggestion.
const WEARABLE = { top: 'Top', shoes: 'Shoes' };
const SECONDS_PER_PIECE = 20;
// Errors worth a retry button. Photo problems (pose, several people) say what to change instead.
const RETRYABLE = ['upstream', 'timeout', 'rate_limited', 'network'];

const $ = (id) => document.getElementById(id);

const state = {
  items: [], // the closet
  pending: [], // closet photos being read
  person: null,
  personIsSample: false,
  personFile: null, // which sample photo is in use, so a matching pre-generated result can be found
  gender: null,
  tray: [], // pieces being considered
  trayPending: [],
  activeId: null,
  advices: {}, // tray item id -> advice
  advising: false,
  view: 'after', // mirror: 'before' (you) or 'after' (with the outfit)
  render: null, // { label, status, steps, done, image, error, code }
  lastTry: null, // { label, items } so a failed try-on can be retried
  rendering: null, // { controller } while a try-on runs
  looks: [], // finished try-ons, newest first: { label, image, sample }
  shownLook: null, // index into looks, or null for the live result
};

// ---------- Small helpers ----------

let toastTimer;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 5500);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key.startsWith('aria-') || key.startsWith('data-')) node.setAttribute(key, value);
    else if (value !== undefined && value !== null) node[key] = value;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

const newItem = (image, extra = {}) => ({
  id: crypto.randomUUID(),
  image,
  addedAt: Date.now(),
  name: '',
  category: 'top',
  color: '',
  style: '',
  formality: 'casual',
  notes: '',
  needsReview: false,
  ...extra,
});

const slim = ({ id, name, category, color, style, formality, notes }) => ({ id, name, category, color, style, formality, notes });
const isWearable = (item) => item.category in WEARABLE;
const active = () => state.tray.find((c) => c.id === state.activeId) ?? null;

async function capture(facing, hint) {
  try {
    return await takePhoto({ facing, hint });
  } catch (err) {
    toast(err.message);
    return null;
  }
}

// ---------- Pre-generated samples (no API keys needed) ----------
// The sample photo and the sample pieces come with advice and try-on results made ahead of time with the
// real Claude and YouCam APIs, so the whole walkthrough works without keys. They only apply while nothing
// has been changed: your own photo, an edited piece, or your own clothes in the closet all run live.

let precomputed;
function loadPrecomputed() {
  precomputed ??= fetch('/samples/precomputed.json')
    .then((res) => (res.ok ? res.json() : {}))
    .catch(() => ({}));
  return precomputed;
}

const isPristineSample = (item) => !!item.sampleFile && item.sampleSig === tagSignature(item);
const pause = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

async function sampleAdviceFor(c) {
  if (!isPristineSample(c)) return null;
  const data = await loadPrecomputed();
  const entry = data.advice?.[c.sampleFile];
  if (!entry) return null;
  // The advice was written for the complete sample closet, exactly as shipped.
  const manifest = await loadSampleManifest();
  if (data.closet !== closetSignature(manifest.closet)) return null;
  const wanted = manifest.closet.map((x) => x.file);
  const have = state.items.map((i) => i.sampleFile);
  if (!state.items.every(isPristineSample) || have.length !== wanted.length || !wanted.every((f) => have.includes(f))) return null;

  const idByFile = new Map(state.items.map((i) => [i.sampleFile, i.id]));
  const ids = (files) => files.map((f) => idByFile.get(f)).filter(Boolean);
  return {
    sample: true,
    verdict: entry.verdict,
    gap: entry.gap,
    duplicates: entry.duplicates.map((d) => ({ itemId: idByFile.get(d.file), reason: d.reason })).filter((d) => d.itemId),
    outfits: entry.outfits.map((o) => ({ name: o.name, itemIds: ids(o.files), reason: o.reason })).filter((o) => o.itemIds.length),
  };
}

async function sampleResultFor(pieces) {
  if (!state.personFile || !pieces.every((p) => isPristineSample(p.item))) return null;
  const key = tryOnKey(state.personFile, pieces.map((p) => p.item));
  const entry = key && (await loadPrecomputed()).tryons?.[key];
  return entry ? `/samples/${entry.file}` : null;
}

// ---------- Theme ----------

function applyThemeButton() {
  const dark = document.documentElement.dataset.theme === 'dark';
  $('theme-btn').setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#080b16' : '#eef2fa');
}
$('theme-btn').addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme === 'dark';
  if (dark) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = 'dark';
  try {
    localStorage.setItem('theme', dark ? 'light' : 'dark');
  } catch {
    /* storage blocked: the choice lasts for this visit */
  }
  applyThemeButton();
});

// ---------- Mirror (you, and the try-on result) ----------

function liveResult() {
  const look = state.shownLook != null ? state.looks[state.shownLook] : null;
  if (look) return { image: look.image, label: look.label, look: true, sample: !!look.sample };
  if (state.render?.image) return { image: state.render.image, label: state.render.label, look: false, sample: !!state.render.sample };
  return null;
}

function renderMirror() {
  const result = liveResult();
  const showResult = !!result && (state.view === 'after' || !state.person);
  const src = showResult ? result.image : state.person;

  const img = $('stage-img');
  img.hidden = !src;
  if (src && img._src !== src) {
    img.src = src;
    img._src = src;
  }
  img.alt = showResult ? 'You wearing the outfit' : 'Your photo';
  img.classList.toggle('zoomable', showResult);
  $('credit').hidden = !showResult;
  if (showResult) $('credit').textContent = result.sample ? 'Sample result, pre-generated with the YouCam API' : 'Try-on generated with the YouCam API';
  $('stage-empty').hidden = !!src;
  $('you-hint').hidden = !!state.person; // the photo tips only matter until there is a photo

  const badge = $('stage-badge');
  const badgeText = showResult ? result.label : state.person ? (state.personIsSample ? 'Sample photo' : 'You') : '';
  badge.hidden = !badgeText;
  badge.textContent = badgeText;

  $('compare').hidden = !(result && state.person);
  for (const btn of $('compare').querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.dataset.view === state.view));

  const r = state.render;
  const running = r?.status === 'running' && state.shownLook == null;
  $('progress').hidden = !running;
  $('progress-text').textContent = running ? `Putting it on you… ${r.done.length} of ${r.steps.length} done` : '';
  $('steps').replaceChildren(...(r?.steps ?? []).map((s) => el('li', { class: r.done.includes(s) ? 'done' : '' }, WEARABLE[s] ?? s)));
  const showError = !!(r?.error && state.shownLook == null);
  $('error-box').hidden = !showError;
  $('render-error').textContent = r?.error ?? '';
  $('retry-btn').hidden = !(showError && RETRYABLE.includes(r.code) && state.lastTry);

  $('render-actions').hidden = !(showResult && (result.look || r?.status === 'done'));
  if (showResult) $('download').href = result.image;

  $('looks').hidden = state.looks.length === 0;
  $('looks-row').replaceChildren(
    ...state.looks.map((look, i) =>
      el(
        'button',
        {
          class: 'look',
          type: 'button',
          title: look.label,
          'aria-label': `Show look: ${look.label}`,
          'aria-pressed': String(state.shownLook === i),
          onclick: () => {
            state.shownLook = i;
            state.view = 'after';
            renderMirror();
          },
        },
        el('img', { src: look.image, alt: '' }),
      ),
    ),
  );

  updateFitLine();
  updateJourney();
}

for (const btn of $('compare').querySelectorAll('button')) {
  btn.addEventListener('click', () => {
    state.view = btn.dataset.view;
    renderMirror();
  });
}
// ---------- Shoe fit: asked once, only when a try-on includes shoes ----------

const FIT_LABEL = { male: "Men's styles", female: "Women's styles" };

function updateFitLine() {
  $('fit-line').hidden = !state.gender;
  $('fit-value').textContent = FIT_LABEL[state.gender] ?? '';
}

function askFit() {
  const dialog = $('fit-dialog');
  return new Promise((resolve) => {
    let choice = null;
    const buttons = [...dialog.querySelectorAll('[data-fit]')];
    const onClick = (e) => {
      choice = e.currentTarget.dataset.fit || null;
      dialog.close();
    };
    const finish = async () => {
      buttons.forEach((b) => b.removeEventListener('click', onClick));
      dialog.removeEventListener('close', finish);
      if (choice) {
        state.gender = choice;
        await setMeta('gender', choice);
        renderMirror();
      }
      resolve(choice);
    };
    buttons.forEach((b) => b.addEventListener('click', onClick));
    dialog.addEventListener('close', finish);
    dialog.showModal();
  });
}
$('fit-change').addEventListener('click', () => askFit());

// ---------- Progress steps ----------

function updateJourney() {
  const done = { photo: !!state.person, closet: state.items.length > 0, try: state.looks.length > 0 };
  const current = ['photo', 'closet', 'try'].find((k) => !done[k]);
  for (const li of $('journey').children) {
    const key = li.dataset.step;
    li.classList.toggle('done', done[key]);
    li.classList.toggle('current', key === current);
  }
}

$('cancel-btn').addEventListener('click', () => state.rendering?.controller.abort());

// ---------- You ----------

async function setPerson(file) {
  try {
    state.person = await fileToDataUrl(file);
    state.personIsSample = false;
    state.personFile = null;
    state.view = 'before';
    state.shownLook = null;
    await setMeta('person', state.person);
    await setMeta('personSample', false);
    await setMeta('personSampleFile', null);
    renderMirror();
  } catch (err) {
    toast(err.message);
  }
}

$('you-file').addEventListener('change', (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (file) setPerson(file);
});
$('you-camera').addEventListener('click', async () => {
  const file = await capture('user', 'Step back so your whole body is in frame, and face the camera.');
  if (file) setPerson(file);
});
async function useSamplePerson() {
  try {
    const manifest = await loadSampleManifest();
    state.person = await loadSampleImage(manifest.person.file);
    state.personIsSample = true;
    state.personFile = manifest.person.file;
    state.view = 'before';
    state.shownLook = null;
    await setMeta('person', state.person);
    await setMeta('personSample', true);
    await setMeta('personSampleFile', manifest.person.file);
    renderMirror();
  } catch (err) {
    toast(err.message);
  }
}
$('you-sample').addEventListener('click', useSamplePerson);
$('stage-sample').addEventListener('click', useSamplePerson);

// ---------- Item fields shared by closet cards and the selected piece ----------

function fieldsFor(item, onEdit) {
  const text = (key, label) =>
    el('input', {
      type: 'text',
      value: item[key] ?? '',
      placeholder: label,
      'aria-label': label,
      oninput: (e) => {
        item[key] = e.target.value;
        onEdit(false);
      },
    });
  const select = el(
    'select',
    {
      'aria-label': 'Category',
      onchange: (e) => {
        item.category = e.target.value;
        item.needsReview = false;
        onEdit(true);
      },
    },
    ...CATEGORIES.map((c) => el('option', { value: c, selected: c === item.category }, c)),
  );
  const name = text('name', 'Name');
  name.classList.add('name');
  return [name, select, text('color', 'Colour'), text('style', 'Style')];
}

// Read one photo: ask Claude for the details, and fall back to a blank item if Claude can't.
async function readItem(file) {
  const image = await fileToDataUrl(file);
  try {
    return newItem(image, await tagImage(image));
  } catch (err) {
    toast(`${err.message} Saved without details.`);
    return newItem(image, { name: file.name.replace(/\.[^.]+$/, ''), needsReview: true });
  }
}

// ---------- Closet ----------

function renderCloset() {
  const total = state.items.length;
  $('count').textContent = total ? `(${total})` : '';
  updateJourney();
  $('closet-empty').hidden = total + state.pending.length > 0;
  const cards = state.items.map((item) =>
    el(
      'article',
      { class: `card${item.needsReview ? ' review' : ''}` },
      el('div', { class: 'thumb' }, el('img', { src: item.image, alt: item.name || 'Clothing item' })),
      el(
        'div',
        { class: 'body' },
        ...fieldsFor(item, (rerender) => {
          putItem(item);
          if (rerender) renderCloset();
          updateAdviseControls();
        }),
        item.needsReview ? el('p', { class: 'flag' }, 'Check these details') : null,
        el('div', { class: 'actions' }, el('button', { class: 'link', type: 'button', onclick: () => removeClosetItem(item.id) }, 'Remove')),
      ),
    ),
  );
  const pending = state.pending.map((p) => el('article', { class: 'card pending' }, el('div', { class: 'thumb' }, el('img', { src: p.image, alt: '' }))));
  $('grid').replaceChildren(...cards, ...pending);
  updateAdviseControls();
}

async function removeClosetItem(id) {
  state.items = state.items.filter((i) => i.id !== id);
  await deleteItem(id);
  state.advices = {}; // advice was based on the old closet
  renderCloset();
  renderDetail();
}

async function addClosetFiles(files) {
  for (const file of files) {
    if (state.items.length + state.pending.length >= MAX_CLOSET) {
      toast(`Your closet is full (${MAX_CLOSET} items). Remove something first.`);
      break;
    }
    let preview;
    try {
      preview = await fileToDataUrl(file);
    } catch (err) {
      toast(`${file.name}: ${err.message}`);
      continue;
    }
    const pending = { image: preview };
    state.pending.push(pending);
    renderCloset();

    let item;
    try {
      item = await readItem(file);
    } finally {
      state.pending = state.pending.filter((p) => p !== pending);
    }
    state.items.push(item);
    await putItem(item);
    state.advices = {};
    renderCloset();
    renderDetail();
  }
}

$('closet-file').addEventListener('change', (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (files.length) addClosetFiles(files);
});
$('closet-camera').addEventListener('click', async () => {
  const file = await capture('environment', 'Lay the piece flat or hold it up against a plain background.');
  if (file) addClosetFiles([file]);
});

// Sample photos come with ready-made tags, so loading them costs nothing and needs no Claude key.
$('closet-sample').addEventListener('click', async () => {
  try {
    const manifest = await loadSampleManifest();
    let added = 0;
    for (const sample of manifest.closet) {
      if (state.items.some((i) => i.sampleFile === sample.file)) continue;
      if (state.items.length >= MAX_CLOSET) break;
      const { file, ...tags } = sample;
      const item = newItem(await loadSampleImage(file), { ...tags, sampleFile: file, sampleSig: tagSignature(tags) });
      state.items.push(item);
      await putItem(item);
      added++;
    }
    state.advices = {};
    renderCloset();
    renderDetail();
    toast(added ? `Added ${added} sample pieces to your closet.` : 'The sample closet is already in your closet.');
  } catch (err) {
    toast(err.message);
  }
});

// ---------- Try-on ----------

function wearablePieces(items) {
  const picked = {};
  for (const item of items) if (item.category in WEARABLE && !picked[item.category]) picked[item.category] = item;
  return Object.entries(picked).map(([slot, item]) => ({ slot, item }));
}

function refreshButtons() {
  for (const btn of document.querySelectorAll('.tryon-btn')) btn.disabled = !!state.rendering;
  updateTrayActions();
}

function beginTryOn(label, steps, sample) {
  const controller = new AbortController();
  state.rendering = { controller };
  const view = (state.render = { label, status: 'running', steps, done: [], image: null, error: null, code: null, sample });
  state.view = 'after';
  state.shownLook = null;
  renderMirror();
  refreshButtons();
  // On a narrow screen the mirror sits above everything, so bring it into view.
  if (matchMedia('(max-width: 900px)').matches) $('mirror').scrollIntoView({ behavior: 'smooth', block: 'start' });
  return { controller, view };
}

function endTryOn(view, label) {
  state.rendering = null;
  if (view.status === 'done' && view.image) {
    state.looks.unshift({ label, image: view.image, sample: !!view.sample });
    state.looks.length = Math.min(state.looks.length, MAX_LOOKS);
  }
  renderMirror();
  refreshButtons();
}

// The pre-generated result for the sample photo, shown with the same progress steps as a live one.
async function runSampleTryOn(label, pieces, url) {
  const steps = Object.keys(WEARABLE).filter((s) => pieces.some((p) => p.slot === s));
  const { controller, view } = beginTryOn(label, steps, true);
  state.lastTry = null; // nothing to retry: a pre-generated result cannot fail
  try {
    for (const slot of steps) {
      await pause(900, controller.signal);
      if (controller.signal.aborted) break;
      view.done.push(slot);
      renderMirror();
    }
    if (controller.signal.aborted) view.status = 'cancelled';
    else {
      view.image = url;
      view.status = 'done';
    }
  } finally {
    endTryOn(view, label);
  }
}

let starting = false; // covers the gaps (asking about shoes, loading samples) before a try-on is running

async function startTryOn(label, items) {
  if (state.rendering || starting) return;
  starting = true;
  try {
    const pieces = wearablePieces(items);
    if (!pieces.length) return void toast('Only tops and shoes can be shown on you for now.');
    if (!state.person) {
      toast('Add your photo first, or use the sample.');
      return void $('mirror').scrollIntoView({ behavior: 'smooth' });
    }

    const sampleUrl = await sampleResultFor(pieces);
    if (sampleUrl) return await runSampleTryOn(label, pieces, sampleUrl);

    if (pieces.some((p) => p.slot === 'shoes') && !state.gender && !(await askFit())) return;
    await runLiveTryOn(label, items, pieces);
  } finally {
    starting = false;
  }
}

async function runLiveTryOn(label, items, pieces) {
  const { controller, view } = beginTryOn(label, pieces.map((p) => p.slot), false);
  state.lastTry = { label, items };

  const onEvent = (evt) => {
    if (evt.type === 'start') view.steps = evt.steps;
    else if (evt.type === 'step') {
      view.done.push(evt.slot);
      view.image = evt.image;
    } else if (evt.type === 'done') view.status = 'done';
    else if (evt.type === 'error') {
      view.status = 'error';
      view.error = evt.message;
      view.code = evt.code;
    }
    renderMirror();
  };

  try {
    await streamRender(
      { person: state.person, gender: state.gender ?? undefined, items: pieces.map((p) => ({ slot: p.slot, image: p.item.image })) },
      onEvent,
      controller.signal,
    );
    if (view.status === 'running') {
      view.status = controller.signal.aborted ? 'cancelled' : 'error';
      if (view.status === 'error') {
        view.error = 'The try-on ended unexpectedly. Try again.';
        view.code = 'network';
      }
    }
  } catch (err) {
    view.status = 'error';
    view.error = err.message;
    view.code = err.status ? 'refused' : 'network'; // only a dropped connection is worth retrying
  } finally {
    endTryOn(view, label);
  }
}

function tryonButton(label, items) {
  const pieces = wearablePieces(items);
  const skipped = items.length - pieces.length;
  const text = pieces.length ? `See it on me (${pieces.length} piece${pieces.length > 1 ? 's' : ''}, about ${pieces.length * SECONDS_PER_PIECE}s)` : null;
  return el(
    'div',
    { class: 'tryon-row' },
    text ? el('button', { class: 'btn small tryon-btn', type: 'button', disabled: !!state.rendering, onclick: () => startTryOn(label, items) }, text) : null,
    skipped > 0 ? el('span', { class: 'hint inline' }, `${pieces.length ? 'The rest' : 'These'} can't be shown on you yet, only tops and shoes.`) : null,
  );
}

// ---------- Tray: pieces you're thinking of buying ----------

function selectPiece(id) {
  state.activeId = id;
  renderTray();
  renderDetail();
  // The tray was rebuilt, so put keyboard focus back on the card that was just chosen.
  document.querySelector('.tcard.active .tselect')?.focus();
}

function trayCard(c) {
  const wearable = isWearable(c);
  const isActive = c.id === state.activeId;
  return el(
    'article',
    { class: `tcard${isActive ? ' active' : ''}` },
    el(
      'button',
      { class: 'tselect', type: 'button', 'aria-pressed': String(isActive), 'aria-label': `Select ${c.name || c.category}`, onclick: () => selectPiece(c.id) },
      el('div', { class: 'thumb' }, el('img', { src: c.image, alt: '' })),
      el('div', { class: 'tbody' }, el('p', { class: 'tname', 'data-tname': c.id }, c.name || c.category), el('span', { class: 'chip' }, c.category)),
    ),
    wearable
      ? el(
          'label',
          { class: 'check', title: 'Include in a together try-on' },
          el('input', {
            type: 'checkbox',
            checked: !!c.selected,
            'aria-label': `Include ${c.name || 'this piece'} in a together try-on`,
            onchange: (e) => {
              c.selected = e.target.checked;
              updateTrayActions();
            },
          }),
        )
      : null,
    el(
      'div',
      { class: 'trow' },
      wearable
        ? el('button', { class: 'btn small tryon-btn', type: 'button', disabled: !!state.rendering, onclick: () => startTryOn(c.name || c.category, [c]) }, 'Try on')
        : el('span'),
      el('button', { class: 'link', type: 'button', onclick: () => removeCandidate(c.id) }, 'Remove'),
    ),
  );
}

function renderTray() {
  const pendingCards = state.trayPending.map((p) => el('article', { class: 'tcard card pending' }, el('div', { class: 'thumb' }, el('img', { src: p.image, alt: '' }))));
  $('tray').replaceChildren(...state.tray.map(trayCard), ...pendingCards);
  $('tray-empty').hidden = state.tray.length + state.trayPending.length > 0;
  updateTrayActions();
}

function updateTrayActions() {
  const chosen = state.tray.filter((c) => c.selected && isWearable(c));
  $('tray-actions').hidden = state.tray.filter(isWearable).length < 2;
  $('tray-together').disabled = !!state.rendering || chosen.length === 0;
  $('tray-together').textContent = chosen.length ? `Try ${chosen.length} selected together` : 'Try selected together';
}

$('tray-together').addEventListener('click', () => {
  const chosen = state.tray.filter((c) => c.selected && isWearable(c));
  const used = wearablePieces(chosen);
  if (used.length < chosen.length) toast('Only one top and one pair of shoes can be worn at once, so the first of each is used.');
  startTryOn(used.map((p) => p.item.name || p.item.category).join(' + '), chosen);
});

async function addCandidates(files) {
  for (const file of files) {
    if (state.tray.length + state.trayPending.length >= MAX_TRAY) {
      toast(`You can compare up to ${MAX_TRAY} pieces at once. Remove one first.`);
      break;
    }
    let preview;
    try {
      preview = await fileToDataUrl(file);
    } catch (err) {
      toast(`${file.name}: ${err.message}`);
      continue;
    }
    const pending = { image: preview };
    state.trayPending.push(pending);
    renderTray();
    let item;
    try {
      item = await readItem(file);
    } finally {
      state.trayPending = state.trayPending.filter((p) => p !== pending);
    }
    state.tray.push(item);
    state.activeId = item.id;
    renderTray();
    renderDetail();
  }
}

$('tray-file').addEventListener('change', (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (files.length) addCandidates(files);
});
$('tray-camera').addEventListener('click', async () => {
  const file = await capture('environment', 'Photograph the piece on a plain background.');
  if (file) addCandidates([file]);
});
$('tray-sample').addEventListener('click', async () => {
  try {
    const manifest = await loadSampleManifest();
    let added = 0;
    for (const sample of manifest.candidates) {
      if (state.tray.some((c) => c.sampleFile === sample.file)) continue;
      if (state.tray.length >= MAX_TRAY) break;
      const { file, ...tags } = sample;
      const item = newItem(await loadSampleImage(file), { ...tags, sampleFile: file, sampleSig: tagSignature(tags) });
      state.tray.push(item);
      state.activeId = item.id;
      added++;
    }
    renderTray();
    renderDetail();
    if (!added) toast('The sample piece is already here.');
  } catch (err) {
    toast(err.message);
  }
});

function removeCandidate(id) {
  state.tray = state.tray.filter((c) => c.id !== id);
  delete state.advices[id];
  if (state.activeId === id) state.activeId = state.tray.at(-1)?.id ?? null;
  renderTray();
  renderDetail();
}

// ---------- Selected piece: details and advice ----------

function renderDetail() {
  const c = active();
  $('detail').hidden = !c;
  if (!c) return;
  $('detail-title').textContent = c.name || 'Selected piece';
  $('detail-fields').replaceChildren(
    ...fieldsFor(c, (rerender) => {
      delete state.advices[c.id];
      const label = document.querySelector(`[data-tname="${c.id}"]`);
      if (label) label.textContent = c.name || c.category;
      $('detail-title').textContent = c.name || 'Selected piece';
      renderAdvice();
      updateAdviseControls();
      if (rerender) {
        renderTray();
        renderDetail();
      }
    }),
  );
  renderAdvice();
  updateAdviseControls();
}

function updateAdviseControls() {
  const c = active();
  if (!c) return;
  const noCloset = state.items.length === 0;
  const btn = $('advise-btn');
  btn.disabled = noCloset || state.advising;
  btn.textContent = state.advising ? 'Styling…' : state.advices[c.id] ? 'Style it again' : 'Style it with my closet';
  $('advise-note').textContent = noCloset ? 'Add some of your own clothes, or load the sample closet, to style this piece.' : '';
  $('detail-try').hidden = !isWearable(c);
  $('detail-try').disabled = !!state.rendering;
}

$('detail-try').addEventListener('click', () => {
  const c = active();
  if (c) startTryOn(c.name || c.category, [c]);
});

$('advise-btn').addEventListener('click', async () => {
  const c = active();
  if (!c || state.advising) return;
  state.advising = true;
  delete state.advices[c.id];
  renderAdvice();
  updateAdviseControls();
  try {
    const pre = await sampleAdviceFor(c);
    if (pre) {
      await pause(800); // a short beat, so it reads as an answer rather than a flicker
      state.advices[c.id] = pre;
    } else {
      const { id, ...candidate } = slim(c);
      const body = await postJson('/api/advise', { closet: state.items.map(slim), candidate });
      state.advices[c.id] = body.advice;
    }
  } catch (err) {
    toast(err.message);
  } finally {
    state.advising = false;
    renderAdvice();
    updateAdviseControls();
  }
});

function piece(item, { isNew = false } = {}) {
  return el(
    'figure',
    { class: `piece${isNew ? ' is-new' : ''}` },
    el('img', { src: item.image, alt: item.name || item.category }),
    el('figcaption', {}, isNew ? el('span', { class: 'badge' }, 'New') : null, el('span', {}, item.name || item.category)),
  );
}

function renderAdvice() {
  const box = $('advice');
  const c = active();
  const advice = c ? state.advices[c.id] : null;
  box.hidden = !advice;
  if (!advice) return void box.replaceChildren();

  const byId = new Map(state.items.map((i) => [i.id, i]));
  const children = [
    el('p', { class: 'verdict' }, advice.verdict),
    advice.gap ? el('p', { class: 'gap' }, advice.gap) : null,
    advice.sample ? el('p', { class: 'hint' }, 'Sample advice, pre-generated with Claude.') : null,
  ];

  const dupes = advice.duplicates.filter((d) => byId.has(d.itemId));
  if (dupes.length) {
    children.push(
      el('h3', {}, 'You may already own something like this'),
      el('div', { class: 'dupes' }, ...dupes.map((d) => el('div', { class: 'dupe' }, piece(byId.get(d.itemId)), el('p', {}, d.reason)))),
    );
  }

  const outfits = advice.outfits.filter((o) => o.itemIds.some((id) => byId.has(id)));
  if (outfits.length) {
    children.push(
      el('h3', {}, 'Outfits with what you own'),
      el(
        'div',
        { class: 'outfits' },
        ...outfits.map((o) => {
          const items = [c, ...o.itemIds.map((id) => byId.get(id)).filter(Boolean)];
          return el(
            'article',
            { class: 'outfit' },
            el('h4', {}, o.name),
            el('p', { class: 'reason' }, o.reason),
            el('div', { class: 'strip' }, piece(c, { isNew: true }), ...items.slice(1).map((i) => piece(i))),
            tryonButton(o.name, items),
          );
        }),
      ),
    );
  } else {
    children.push(el('p', { class: 'hint' }, 'Nothing in your closet pairs well with this yet, so there are no outfits to show.'));
  }

  children.push(
    el(
      'div',
      { class: 'row' },
      el(
        'button',
        {
          class: 'btn ghost small',
          type: 'button',
          onclick: async () => {
            const copy = { ...c, id: crypto.randomUUID(), addedAt: Date.now(), selected: undefined };
            state.items.push(copy);
            await putItem(copy);
            state.advices = {};
            removeCandidate(c.id);
            renderCloset();
            toast('Added to your closet.');
          },
        },
        'I bought it: add to my closet',
      ),
    ),
  );
  box.replaceChildren(...children);
}

// ---------- Retry, enlarge, and the info dialog ----------

$('retry-btn').addEventListener('click', () => {
  if (state.lastTry) startTryOn(state.lastTry.label, state.lastTry.items);
});

function openZoom() {
  const result = liveResult();
  if (!result) return;
  const dialog = $('zoom-dialog');
  dialog.querySelector('img').src = result.image;
  dialog.showModal();
}
$('zoom-btn').addEventListener('click', openZoom);
$('stage-img').addEventListener('click', () => {
  if ($('stage-img').classList.contains('zoomable')) openZoom();
});

$('how-btn').addEventListener('click', () => $('how-dialog').showModal());
for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => button.closest('dialog').close());
// Reading dialogs close on a click anywhere outside the text; the camera and shoe dialogs stay put.
$('how-dialog').addEventListener('click', (e) => e.target === e.currentTarget && e.currentTarget.close());
$('zoom-dialog').addEventListener('click', (e) => e.currentTarget.close());

// ---------- Privacy ----------

$('clear-data').addEventListener('click', async () => {
  if (!confirm('Remove your photo, closet and saved choices from this browser?')) return;
  await clearAll();
  location.reload();
});

// ---------- Start ----------

async function init() {
  applyThemeButton();
  state.items = await listItems();
  state.person = (await getMeta('person')) ?? null;
  state.personIsSample = !!(await getMeta('personSample'));
  state.personFile = (await getMeta('personSampleFile')) ?? (state.personIsSample ? 'person.jpg' : null);
  // Sample pieces saved before pre-generated samples existed have no signature yet. Give one to those still unedited.
  const manifest = await loadSampleManifest().catch(() => null);
  if (manifest) {
    const originals = [...manifest.closet, ...manifest.candidates];
    for (const item of state.items) {
      const original = item.sampleFile && !item.sampleSig && originals.find((s) => s.file === item.sampleFile);
      if (original && tagSignature(original) === tagSignature(item)) {
        item.sampleSig = tagSignature(original);
        await putItem(item);
      }
    }
  }
  state.gender = (await getMeta('gender')) ?? null;
  state.view = 'before';
  $('storage-notice').hidden = persistent;
  renderMirror();
  renderCloset();
  renderTray();
  renderDetail();
}
init();
