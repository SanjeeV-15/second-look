import { deleteItem, getMeta, listItems, persistent, putItem, setMeta } from './closet.js';
import { fileToDataUrl, tagImage } from './image.js';

const CATEGORIES = ['top', 'bottom', 'shoes', 'outerwear', 'accessory'];
const MAX_ITEMS = 40;

const $ = (id) => document.getElementById(id);
const state = { items: [], pending: [], person: null, gender: null };

let toastTimer;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 5000);
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== undefined && value !== null) node[key] = value;
  }
  node.append(...children);
  return node;
}

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

// ---------- Closet ----------

function itemCard(item) {
  const save = () => putItem(item);
  const field = (key, placeholder) =>
    el('input', {
      value: item[key] ?? '',
      placeholder,
      ariaLabel: placeholder,
      oninput: (e) => {
        item[key] = e.target.value;
        save();
      },
    });

  const select = el(
    'select',
    {
      ariaLabel: 'Category',
      onchange: (e) => {
        item.category = e.target.value;
        item.needsReview = false;
        save();
        render();
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
      el('div', { class: 'actions' }, el('button', { class: 'remove', type: 'button', onclick: () => remove(item.id) }, 'Remove')),
    ),
  );
}

function pendingCard(p) {
  return el('article', { class: 'card pending' }, el('div', { class: 'thumb' }, el('img', { src: p.image, alt: '' })));
}

function render() {
  const total = state.items.length;
  $('count').textContent = total ? `(${total})` : '';
  $('closet-empty').hidden = total + state.pending.length > 0;
  const grid = $('grid');
  grid.replaceChildren(...state.items.map(itemCard), ...state.pending.map(pendingCard));
}

async function remove(id) {
  state.items = state.items.filter((i) => i.id !== id);
  await deleteItem(id);
  render();
}

async function addFiles(files) {
  for (const file of files) {
    if (state.items.length + state.pending.length >= MAX_ITEMS) {
      toast(`Your closet is full (${MAX_ITEMS} items). Remove something first.`);
      break;
    }
    let image;
    try {
      image = await fileToDataUrl(file);
    } catch (err) {
      toast(`${file.name}: ${err.message}`);
      continue;
    }

    const pending = { image };
    state.pending.push(pending);
    render();

    const item = { id: crypto.randomUUID(), image, addedAt: Date.now(), name: '', category: 'top', color: '', style: '', formality: 'casual', notes: '' };
    try {
      Object.assign(item, await tagImage(image), { needsReview: false });
    } catch (err) {
      // Never block the closet on Claude: keep the item and let the user fill the details in.
      item.name = file.name.replace(/\.[^.]+$/, '');
      item.needsReview = true;
      toast(`${err.message} Saved without details.`);
    }
    state.pending = state.pending.filter((p) => p !== pending);
    state.items.push(item);
    await putItem(item);
    render();
  }
}

$('closet-file').addEventListener('change', (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  if (files.length) addFiles(files);
});

// ---------- Start ----------

async function init() {
  state.items = await listItems();
  state.person = (await getMeta('person')) ?? null;
  state.gender = (await getMeta('gender')) ?? null;
  $('storage-notice').hidden = persistent;
  renderYou();
  render();
}
init();
