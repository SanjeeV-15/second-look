import { deleteItem, getMeta, listItems, persistent, putItem, setMeta } from './closet.js';
import { fileToDataUrl, postJson, tagImage } from './image.js';

const CATEGORIES = ['top', 'bottom', 'shoes', 'outerwear', 'accessory'];
const MAX_ITEMS = 40;

const $ = (id) => document.getElementById(id);
const state = { items: [], pending: [], person: null, gender: null, candidate: null, advice: null, advising: false };

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

function renderCandidate() {
  const c = state.candidate;
  $('candidate').hidden = !c;
  $('candidate-empty').hidden = !!c;
  if (!c) return;
  $('candidate-card').replaceChildren(
    itemCard(c, {
      onEdit: (rerender) => {
        state.advice = null;
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
}

$('candidate-file').addEventListener('change', async (event) => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  $('candidate-empty').textContent = 'Reading the item…';
  try {
    state.candidate = await readItem(file);
    state.advice = null;
  } catch (err) {
    toast(err.message);
  }
  $('candidate-empty').textContent = 'Nothing here yet.';
  renderCandidate();
});

$('candidate-clear').addEventListener('click', () => {
  state.candidate = null;
  state.advice = null;
  renderCandidate();
});

const slim = ({ id, name, category, color, style, formality, notes }) => ({ id, name, category, color, style, formality, notes });

$('advise-btn').addEventListener('click', async () => {
  if (!state.candidate || state.advising) return;
  state.advising = true;
  state.advice = null;
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
        ...advice.outfits.map((o) =>
          el(
            'article',
            { class: 'outfit' },
            el('h4', {}, o.name),
            el('p', { class: 'reason' }, o.reason),
            el('div', { class: 'strip' }, piece(state.candidate, { isNew: true }), ...o.itemIds.map((id) => byId.get(id)).filter(Boolean).map((i) => piece(i))),
          ),
        ),
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
