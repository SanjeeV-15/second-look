import { deleteItem, getMeta, listItems, persistent, putItem, setMeta } from './closet.js';
import { fileToDataUrl, postJson, streamRender, tagImage } from './image.js';

const CATEGORIES = ['top', 'bottom', 'shoes', 'outerwear', 'hat', 'bag', 'accessory'];
const MAX_ITEMS = 40;
// Only these can be shown on the person today. Everything else is a text suggestion.
const WEARABLE = { top: 'Top', shoes: 'Shoes' };
const SECONDS_PER_PIECE = 20;

const $ = (id) => document.getElementById(id);
const state = {
  items: [],
  pending: [],
  person: null,
  gender: null,
  candidate: null,
  advice: null,
  advising: false,
  renders: {}, // key -> { status, steps, done, image, error }
  rendering: null, // { key, controller } while a try-on is running
};

let toastTimer;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (node.hidden = true), 5000);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
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

// ---------- You ----------

function renderYou() {
  const img = $('you-img');
  img.hidden = !state.person;
  $('you-empty').hidden = !!state.person;
  if (state.person) img.src = state.person;
  for (const radio of document.querySelectorAll('input[name="gender"]')) {
    radio.checked = radio.value === state.gender;
  }
}

$('you-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    state.person = await fileToDataUrl(file);
    await setMeta('person', state.person);
    renderYou();
  } catch (err) {
    toast(err.message);
  }
});

for (const radio of document.querySelectorAll('input[name="gender"]')) {
  radio.addEventListener('change', async () => {
    state.gender = radio.value;
    await setMeta('gender', state.gender);
  });
}

// ---------- Item cards (closet and candidate share them) ----------

function itemCard(item, { onEdit, onRemove, removeLabel = 'Remove' }) {
  const field = (key, label) =>
    el('input', {
      value: item[key] ?? '',
      placeholder: label,
      ariaLabel: label,
      oninput: (e) => {
        item[key] = e.target.value;
        onEdit();
      },
    });

  const select = el(
    'select',
    {
      ariaLabel: 'Category',
      onchange: (e) => {
        item.category = e.target.value;
        item.needsReview = false;
        onEdit(true);
      },
    },
    ...CATEGORIES.map((c) => el('option', { value: c, selected: c === item.category }, c)),
  );

  const name = field('name', 'Name');
  name.classList.add('name');

  return el(
    'article',
    { class: `card${item.needsReview ? ' review' : ''}` },
    el('div', { class: 'thumb' }, el('img', { src: item.image, alt: item.name || 'Clothing item' })),
    el(
      'div',
      { class: 'body' },
      name,
      select,
      field('color', 'Colour'),
      field('style', 'Style'),
      item.needsReview ? el('p', { class: 'flag' }, 'Check these details') : null,
      onRemove ? el('div', { class: 'actions' }, el('button', { class: 'remove', type: 'button', onclick: onRemove }, removeLabel)) : null,
    ),
  );
}

// ---------- Closet ----------

function renderCloset() {
  const total = state.items.length;
  $('count').textContent = total ? `(${total})` : '';
  $('closet-empty').hidden = total + state.pending.length > 0;
  const cards = state.items.map((item) =>
    itemCard(item, {
      onEdit: (rerender) => {
        putItem(item);
        if (rerender) renderCloset();
        renderAdviseControls();
      },
      onRemove: () => removeItem(item.id),
    }),
  );
  const pending = state.pending.map((p) => el('article', { class: 'card pending' }, el('div', { class: 'thumb' }, el('img', { src: p.image, alt: '' }))));
  $('grid').replaceChildren(...cards, ...pending);
  renderAdviseControls();
}

async function removeItem(id) {
  state.items = state.items.filter((i) => i.id !== id);
  await deleteItem(id);
  renderCloset();
  if (state.advice) {
    state.advice = null;
    resetRenders('outfit-');
    renderAdvice();
  }
}

// Read one photo: shrink it, ask Claude for the details, and fall back to a blank item if Claude can't.
async function readItem(file) {
  const image = await fileToDataUrl(file);
  try {
    return newItem(image, await tagImage(image));
  } catch (err) {
    toast(`${err.message} Saved without details.`);
    return newItem(image, { name: file.name.replace(/\.[^.]+$/, ''), needsReview: true });
  }
}

async function addFiles(files) {
  for (const file of files) {
    if (state.items.length + state.pending.length >= MAX_ITEMS) {
      toast(`Your closet is full (${MAX_ITEMS} items). Remove something first.`);
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
    renderCloset();
  }
}

$('closet-file').addEventListener('change', (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (files.length) addFiles(files);
});

// ---------- Candidate and advice ----------

// ---------- Try-on ----------

function wearablePieces(items) {
  const picked = {};
  for (const item of items) if (item.category in WEARABLE && !picked[item.category]) picked[item.category] = item;
  return Object.entries(picked).map(([slot, item]) => ({ slot, item }));
}

// Forget try-on results whose key starts with the prefix (all of them by default), stopping one that is running.
function resetRenders(prefix = '') {
  if (state.rendering?.key.startsWith(prefix)) state.rendering.controller.abort();
  for (const key of Object.keys(state.renders)) if (key.startsWith(prefix)) delete state.renders[key];
  for (const node of document.querySelectorAll('[data-tryon]')) refreshTryon(node.dataset.tryon);
}

function refreshButtons() {
  for (const btn of document.querySelectorAll('.tryon-btn')) btn.disabled = !!state.rendering;
}

function tryonView(view) {
  const parts = [];
  if (view.steps.length) {
    parts.push(
      el('ol', { class: 'steps' }, ...view.steps.map((s) => el('li', { class: view.done.includes(s) ? 'done' : '' }, WEARABLE[s]))),
    );
  }
  if (view.status === 'running') {
    parts.push(
      el(
        'div',
        { class: 'row' },
        el('span', { class: 'spinner', ariaHidden: 'true' }),
        el('span', { class: 'hint inline' }, 'Putting it on you…'),
        el('button', { class: 'btn ghost small', type: 'button', onclick: () => state.rendering?.controller.abort() }, 'Cancel'),
      ),
    );
  }
  if (view.status === 'done' && view.image) {
    parts.push(
      el(
        'div',
        { class: 'compare' },
        el('figure', {}, el('img', { src: state.person, alt: 'You' }), el('figcaption', {}, 'You')),
        el('figure', {}, el('img', { src: view.image, alt: 'You with the outfit' }), el('figcaption', {}, 'With this outfit')),
      ),
      el('a', { class: 'btn ghost small', href: view.image, download: 'try-on.jpg' }, 'Download'),
    );
  } else if (view.image) {
    parts.push(el('figure', { class: 'partial' }, el('img', { src: view.image, alt: 'Try-on so far' }), el('figcaption', {}, view.status === 'running' ? 'So far…' : 'The steps that finished')));
  }
  if (view.status === 'cancelled') parts.push(el('p', { class: 'hint' }, 'Cancelled.'));
  if (view.error) parts.push(el('p', { class: 'error' }, view.error));
  return parts;
}

function refreshTryon(key) {
  const node = document.querySelector(`[data-tryon="${key}"]`);
  if (!node) return;
  const view = state.renders[key];
  node.hidden = !view;
  node.replaceChildren(...(view ? tryonView(view) : []));
}

async function startTryOn(key, items) {
  if (state.rendering) return;
  const pieces = wearablePieces(items);
  if (!pieces.length) return void toast('Only tops and shoes can be shown on you for now.');
  if (!state.person) {
    toast('Add your photo first.');
    return void $('you-h').scrollIntoView({ behavior: 'smooth' });
  }
  if (pieces.some((p) => p.slot === 'shoes') && !state.gender) {
    toast("Choose Men's or Women's shoe fit first.");
    return void $('you-h').scrollIntoView({ behavior: 'smooth' });
  }

  const controller = new AbortController();
  state.rendering = { key, controller };
  const view = (state.renders[key] = { status: 'running', steps: pieces.map((p) => p.slot), done: [], image: null, error: null });
  refreshTryon(key);
  refreshButtons();

  const onEvent = (evt) => {
    if (evt.type === 'start') view.steps = evt.steps;
    else if (evt.type === 'step') {
      view.done.push(evt.slot);
      view.image = evt.image;
    } else if (evt.type === 'done') view.status = 'done';
    else if (evt.type === 'error') {
      view.status = 'error';
      view.error = evt.message;
    }
    refreshTryon(key);
  };

  try {
    await streamRender(
      { person: state.person, gender: state.gender ?? undefined, items: pieces.map((p) => ({ slot: p.slot, image: p.item.image })) },
      onEvent,
      controller.signal,
    );
    if (view.status === 'running') {
      view.status = controller.signal.aborted ? 'cancelled' : 'error';
      if (view.status === 'error') view.error = 'The try-on ended unexpectedly. Try again.';
    }
  } catch (err) {
    view.status = 'error';
    view.error = err.message;
  } finally {
    state.rendering = null;
    refreshTryon(key);
    refreshButtons();
  }
}

function tryonButton(key, items) {
  const pieces = wearablePieces(items);
  const skipped = items.length - pieces.length;
  const label = pieces.length ? `See it on me (${pieces.length} piece${pieces.length > 1 ? 's' : ''}, about ${pieces.length * SECONDS_PER_PIECE}s)` : null;
  return el(
    'div',
    { class: 'tryon-row' },
    label ? el('button', { class: 'btn small tryon-btn', type: 'button', disabled: !!state.rendering, onclick: () => startTryOn(key, items) }, label) : null,
    skipped > 0 ? el('span', { class: 'hint inline' }, `${pieces.length ? 'The rest' : 'These'} can't be shown on you yet, only tops and shoes.`) : null,
  );
}

// ---------- Candidate ----------

function renderCandidate() {
  const c = state.candidate;
  $('candidate').hidden = !c;
  $('candidate-empty').hidden = !!c;
  if (!c) return;
  $('candidate-card').replaceChildren(
    itemCard(c, {
      onEdit: (rerender) => {
        state.advice = null;
        resetRenders();
        renderAdvice();
        if (rerender) renderCandidate();
        renderAdviseControls();
      },
    }),
  );
  renderAdviseControls();
  renderAdvice();
}

function renderAdviseControls() {
  const btn = $('advise-btn');
  const note = $('advise-note');
  if (!state.candidate) return;
  const noCloset = state.items.length === 0;
  btn.disabled = noCloset || state.advising;
  btn.textContent = state.advising ? 'Styling…' : state.advice ? 'Style it again' : 'Style it with my closet';
  note.textContent = noCloset ? 'Add some of your own clothes to the closet first.' : '';

  const solo = $('candidate-tryon-btn');
  const wearable = state.candidate.category in WEARABLE;
  solo.hidden = !wearable;
  solo.disabled = !!state.rendering;
  solo.classList.toggle('tryon-btn', wearable);
}

$('candidate-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  $('candidate-empty').textContent = 'Reading the item…';
  try {
    state.candidate = await readItem(file);
    state.advice = null;
    resetRenders();
  } catch (err) {
    toast(err.message);
  }
  $('candidate-empty').textContent = 'Nothing here yet.';
  renderCandidate();
});

$('candidate-clear').addEventListener('click', () => {
  resetRenders();
  state.candidate = null;
  state.advice = null;
  renderCandidate();
});

$('candidate-tryon-btn').addEventListener('click', () => {
  if (state.candidate) startTryOn('candidate', [state.candidate]);
});

const slim = ({ id, name, category, color, style, formality, notes }) => ({ id, name, category, color, style, formality, notes });

$('advise-btn').addEventListener('click', async () => {
  if (!state.candidate || state.advising) return;
  state.advising = true;
  state.advice = null;
  resetRenders('outfit-');
  renderAdvice();
  renderAdviseControls();
  try {
    const { id, ...candidate } = slim(state.candidate);
    const body = await postJson('/api/advise', { closet: state.items.map(slim), candidate });
    state.advice = body.advice;
  } catch (err) {
    toast(err.message);
  } finally {
    state.advising = false;
    renderAdviseControls();
    renderAdvice();
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
  const advice = state.advice;
  box.hidden = !advice;
  if (!advice) return void box.replaceChildren();

  const byId = new Map(state.items.map((i) => [i.id, i]));
  const children = [
    el('p', { class: 'verdict' }, advice.verdict),
    advice.gap ? el('p', { class: 'gap' }, advice.gap) : null,
  ];

  const dupes = advice.duplicates.filter((d) => byId.has(d.itemId));
  if (dupes.length) {
    children.push(
      el('h3', {}, 'You may already own something like this'),
      el(
        'div',
        { class: 'dupes' },
        ...dupes.map((d) => el('div', { class: 'dupe' }, piece(byId.get(d.itemId)), el('p', {}, d.reason))),
      ),
    );
  }

  if (advice.outfits.length) {
    children.push(
      el('h3', {}, 'Outfits with what you own'),
      el(
        'div',
        { class: 'outfits' },
        ...advice.outfits.map((o, index) => {
          const items = [state.candidate, ...o.itemIds.map((id) => byId.get(id)).filter(Boolean)];
          const tryon = el('div', { class: 'tryon', hidden: true });
          tryon.dataset.tryon = `outfit-${index}`;
          return el(
            'article',
            { class: 'outfit' },
            el('h4', {}, o.name),
            el('p', { class: 'reason' }, o.reason),
            el('div', { class: 'strip' }, piece(state.candidate, { isNew: true }), ...items.slice(1).map((i) => piece(i))),
            tryonButton(`outfit-${index}`, items),
            tryon,
          );
        }),
      ),
    );
  } else {
    children.push(el('p', { class: 'hint' }, "Nothing in your closet pairs well with this yet, so there are no outfits to show."));
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
            const copy = { ...state.candidate, id: crypto.randomUUID(), addedAt: Date.now() };
            state.items.push(copy);
            await putItem(copy);
            renderCloset();
            toast('Added to your closet.');
          },
        },
        'I bought it: add to my closet',
      ),
    ),
  );
  box.replaceChildren(...children);
  // Rebuilding the advice must not lose a try-on that is running or finished.
  for (const node of box.querySelectorAll('[data-tryon]')) refreshTryon(node.dataset.tryon);
}

// ---------- Start ----------

async function init() {
  state.items = await listItems();
  state.person = (await getMeta('person')) ?? null;
  state.gender = (await getMeta('gender')) ?? null;
  $('storage-notice').hidden = persistent;
  renderYou();
  renderCloset();
  renderCandidate();
}
init();
