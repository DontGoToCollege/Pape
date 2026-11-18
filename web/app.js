// Pape library window. Talks to the program (Engine.cs) through chrome.webview messages:
//   in:  state {config, items, displays, ...}, status {...}, folder {path}, nav {page}
//   out: ready, config {config}, rescan, cmd {name, arg}, pickFolder, open {path}, devtools {display}, reset
const VERSION='0.4.0';

const wv = window.chrome && window.chrome.webview;
const send = m => wv && wv.postMessage(m);
window.__errors = [];
addEventListener('error', e => window.__errors.push(String(e.message)));

let cfg = null, items = [], byId = new Map(), displays = [], status = {}, info = {};
let tab = 'wallpapers', selId = null, curDisp = null, editPl = null;
const filters = { q: '', types: new Set(), fav: false };

const TYPES = { image: 'Image', video: 'Video', web: 'Web', scene: 'Scene', application: 'App' };
const ACTIONS = { keep: 'Keep running', mute: 'Mute', pause: 'Pause', stop: 'Stop (free memory)' };
const THEMES = { slate: 'Slate', midnight: 'Midnight', ember: 'Ember', rose: 'Rose', moss: 'Moss', paper: 'Paper (light)' };

const $ = s => document.querySelector(s);

/** Small element builder: h('div', {class: 'x', onclick: fn}, child, 'text', [more]) */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && !k.includes('-')) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}

let saveTimer = 0;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => send({ type: 'config', config: cfg }), 120);
}

/* ---------------- messages from Pape ---------------- */

function onMessage(m) {
  if (m.type === 'state') {
    cfg = m.config; items = m.items; displays = m.displays;
    info = { version: m.version, dataDir: m.dataDir, weInstall: m.weInstall };
    byId = new Map(items.map(i => [i.id, i]));
    if (!displays.some(d => d.key === curDisp)) curDisp = (displays.find(d => d.primary) || displays[0] || {}).key;
    document.documentElement.dataset.theme = cfg.settings?.theme || 'slate';
    renderAll();
  } else if (m.type === 'status') {
    status = m;
    renderStatus();
    if (tab === 'displays') renderDisplays();
    if (tab === 'wallpapers') markLive();
  } else if (m.type === 'folder') {
    if (!cfg.sources.some(s => s.toLowerCase() === m.path.toLowerCase())) { cfg.sources.push(m.path); save(); }
    renderSettings();
  } else if (m.type === 'nav') {
    showTab(m.page);
  }
}
// Inside Pape messages come from the program; in a plain browser (layout testing) call window.__papeMessage(m).
if (wv) wv.addEventListener('message', e => onMessage(e.data));
else window.__papeMessage = onMessage;

/* ---------------- shared helpers ---------------- */

const slotKey = () => (cfg.layout || 'per') === 'per' ? curDisp : '*';
const slot = (key = slotKey()) => (cfg.displays[key] ??= {});
const P = (id = selId) => (cfg.props[id] ??= {});
const isFav = id => cfg.favorites.includes(id);
const displayName = key => key === '*' ? 'All displays' : (displays.find(d => d.key === key) || {}).name || key;

function fmtSize(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB']; let i = 0;
  while (n >= 1024 && i < 3) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

function thumb(it, cls = 'thumb') {
  if (!it) return h('div', { class: cls + ' none' });
  if (it.preview) return h('img', { class: cls, src: it.preview, loading: 'lazy', draggable: false, alt: '' });
  if (it.type === 'video' && it.url) return h('video', { class: cls, src: it.url + '#t=1', muted: true, preload: 'metadata' });
  return h('div', { class: cls + ' none' }, TYPES[it.type] || '?');
}

function applyItem(id) {
  const s = slot();
  s.item = id;
  s.playlist = null;
  save();
}

function niceLabel(text) {
  let t = String(text || '').replace(/<[^>]*>/g, '').trim();
  if (/^ui_[a-z0-9_]+$/.test(t)) {
    t = t.replace(/^ui_(browse|editor)_properties_/, '').replace(/^ui_/, '').replace(/_/g, ' ');
    t = t.charAt(0).toUpperCase() + t.slice(1);
  }
  return t;
}

// Wallpaper Engine stores colours as "r g b" with 0..1 floats.
function weToHex(v) {
  const p = String(v || '0 0 0').trim().split(/\s+/).map(Number);
  return '#' + [0, 1, 2].map(i => Math.round(Math.max(0, Math.min(1, p[i] || 0)) * 255).toString(16).padStart(2, '0')).join('');
}
const hexToWe = hex => [1, 3, 5].map(i => +(parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(5)).join(' ');

const row = (label, ...ctl) => h('label', { class: 'row' }, h('span', { class: 'lab' }, label), ...ctl);

function range(min, max, step, value, onInput, fmt = v => v) {
  const out = h('span', { class: 'val' }, fmt(value));
  const input = h('input', { type: 'range', min, max, step, value, oninput: e => { const v = +e.target.value; out.textContent = fmt(v); onInput(v); } });
  return [input, out];
}

function select(options, value, onChange) {
  const el = h('select', { onchange: e => onChange(e.target.value) },
    Object.entries(options).map(([v, label]) => h('option', { value: v }, label)));
  el.value = value;
  return el;
}

/* ---------------- tabs ---------------- */

function showTab(name) {
  if (!document.getElementById('tab-' + name)) name = 'wallpapers';
  tab = name;
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('on', s.id === 'tab-' + name));
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  if (cfg) renderTab();
}
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));

function renderTab() {
  if (tab === 'wallpapers') { renderGrid(); renderPanel(); }
  else if (tab === 'displays') renderDisplays();
  else if (tab === 'playlists') renderPlaylists();
  else renderSettings();
}

function renderAll() {
  renderHeader();
  renderChips();
  renderTab();
  renderStatus();
}

/* ---------------- header ---------------- */

function renderHeader() {
  const sel = $('#dispSel');
  sel.replaceChildren();
  if ((cfg.layout || 'per') === 'per') {
    for (const d of displays) sel.append(h('option', { value: d.key }, d.name + (d.primary ? ' (main)' : '')));
    sel.value = curDisp;
    sel.disabled = false;
  } else {
    sel.append(h('option', { value: '*' }, cfg.layout === 'stretch' ? 'All displays (stretched)' : 'All displays (same wallpaper)'));
    sel.disabled = true;
  }
}
$('#dispSel').addEventListener('change', e => { curDisp = e.target.value; renderTab(); });
$('#qPause').addEventListener('click', () => send({ type: 'cmd', name: 'pause' }));
$('#qMute').addEventListener('click', () => send({ type: 'cmd', name: 'mute' }));
$('#qStop').addEventListener('click', () => send({ type: 'cmd', name: 'stop' }));

function renderStatus() {
  $('#qPause').classList.toggle('on', !!status.paused);
  $('#qMute').classList.toggle('on', !!status.muted);
  $('#qStop').classList.toggle('on', !!status.stopped);
  if (!cfg) return;
  const parts = [];
  const keys = (cfg.layout || 'per') === 'stretch' ? ['*'] : displays.map(d => d.key);
  for (const key of keys) {
    const id = (status.playing || {})[key];
    const why = (status.reasons || {})[key];
    const what = id ? (byId.get(id) || { title: id }).title : 'Windows wallpaper';
    parts.push(h('span', { class: 'st' + (why ? ' warn' : '') }, h('b', null, displayName(key) + ': '), what, why ? ' · ' + why : ''));
  }
  $('#status').replaceChildren(...parts);
}

/* ---------------- wallpapers ---------------- */

function renderChips() {
  const present = new Set(items.map(i => i.type));
  $('#typeChips').replaceChildren(...Object.entries(TYPES).filter(([t]) => present.has(t)).map(([t, label]) =>
    h('button', { class: 'chip' + (filters.types.has(t) ? ' on' : ''), onclick: () => {
      filters.types.has(t) ? filters.types.delete(t) : filters.types.add(t);
      renderChips(); renderGrid();
    } }, label)));
  $('#sort').value = cfg.settings.sort || 'name';
}
$('#search').addEventListener('input', e => { filters.q = e.target.value.trim().toLowerCase(); renderGrid(); });
$('#favOnly').addEventListener('change', e => { filters.fav = e.target.checked; renderGrid(); });
$('#sort').addEventListener('change', e => { cfg.settings.sort = e.target.value; save(); renderGrid(); });
$('#rescan').addEventListener('click', () => send({ type: 'rescan' }));
$('#addUrl').addEventListener('click', () => {
  const url = prompt('Web page to use as a wallpaper (https://…):', 'https://');
  if (!url || !/^https?:\/\/\S+/i.test(url)) return;
  const title = prompt('Name for this wallpaper:', new URL(url).hostname) || url;
  const id = 'url:' + Date.now();
  cfg.urls.push({ id, url, title });
  selId = id;
  applyItem(id);
});

function visibleItems() {
  const q = filters.q;
  let list = items.filter(it =>
    (!filters.types.size || filters.types.has(it.type)) &&
    (!filters.fav || isFav(it.id)) &&
    (!q || it.title.toLowerCase().includes(q) || (it.tags || []).some(t => String(t).toLowerCase().includes(q))));
  const byName = (a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' });
  const sort = cfg.settings.sort || 'name';
  if (sort === 'recent') list.sort((a, b) => String(b.modified || '').localeCompare(String(a.modified || '')) || byName(a, b));
  else if (sort === 'size') list.sort((a, b) => (b.size || 0) - (a.size || 0) || byName(a, b));
  else if (sort === 'fav') list.sort((a, b) => isFav(b.id) - isFav(a.id) || byName(a, b));
  else list.sort(byName);
  return list;
}

function renderGrid() {
  const list = visibleItems();
  const grid = $('#grid');
  grid.replaceChildren(...list.map(it => h('div', {
    class: 'card' + (it.id === selId ? ' sel' : '') + (it.supported ? '' : ' dim'),
    'data-type': it.type, 'data-id': it.id, title: it.title,
    onclick: () => pick(it.id),
  },
    thumb(it),
    h('button', { class: 'star' + (isFav(it.id) ? ' on' : ''), title: 'Favourite', onclick: e => { e.stopPropagation(); toggleFav(it.id); } }, '★'),
    h('div', { class: 'cap' }, h('span', { class: 't' }, it.title), h('span', { class: 'badge ' + it.type }, TYPES[it.type] || it.type)))));
  const empty = $('#empty');
  if (list.length) empty.replaceChildren();
  else if (items.length) empty.replaceChildren(h('p', null, 'Nothing matches. Clear the search or the filters.'));
  else empty.replaceChildren(h('p', null, 'No wallpapers found yet.'),
    h('p', null, 'Add a folder with pictures, videos or Wallpaper Engine wallpapers in ', h('a', { href: '#', onclick: e => { e.preventDefault(); showTab('settings'); } }, 'Settings'), '.'));
  markLive();
}

function markLive() {
  const live = new Set(Object.values(status.playing || {}));
  document.querySelectorAll('#grid .card').forEach(c => c.classList.toggle('live', live.has(c.dataset.id)));
}

function pick(id) {
  selId = id;
  const it = byId.get(id);
  if (it && it.supported) applyItem(id);
  document.querySelectorAll('#grid .card').forEach(c => c.classList.toggle('sel', c.dataset.id === id));
  renderPanel();
}

function toggleFav(id) {
  const i = cfg.favorites.indexOf(id);
  i >= 0 ? cfg.favorites.splice(i, 1) : cfg.favorites.push(id);
  save();
  renderGrid();
  if (id === selId) renderPanel();
}

function renderPanel() {
  const panel = $('#panel');
  const it = byId.get(selId);
  if (!it) {
    const cur = byId.get(slot().item);
    panel.replaceChildren(h('div', { class: 'hint' },
      h('h2', null, 'Pick a wallpaper'),
      h('p', null, 'Click any wallpaper to put it on ', h('b', null, displayName(slotKey())), '. Its settings appear here.'),
      cur ? h('p', null, 'Now showing: ', h('a', { href: '#', onclick: e => { e.preventDefault(); pick(cur.id); } }, cur.title)) : null));
    return;
  }
  const playlists = Object.keys(cfg.playlists);
  const plSel = h('select', { onchange: e => {
    let name = e.target.value;
    e.target.value = '';
    if (name === '\u0001new') { name = (prompt('Name for the new playlist:') || '').trim(); if (!name) return; cfg.playlists[name] ??= { items: [], order: 'sorted', minutes: 15, fade: true }; }
    const pl = cfg.playlists[name];
    if (pl && !pl.items.includes(it.id)) pl.items.push(it.id);
    save();
    toast(`Added to “${name}”`);
  } }, h('option', { value: '' }, 'Add to playlist…'), playlists.map(n => h('option', { value: n }, n)), h('option', { value: '\u0001new' }, 'New playlist…'));

  panel.replaceChildren(
    h('div', { class: 'pv' }, thumb(it, 'big')),
    h('h2', null, it.title),
    h('div', { class: 'meta' }, [TYPES[it.type] || it.type, fmtSize(it.size), it.rating].filter(Boolean).join(' · ')),
    h('div', { class: 'acts' },
      it.supported ? h('button', { class: 'primary', onclick: () => applyItem(it.id) }, 'Show on ' + displayName(slotKey())) : null,
      h('button', { class: isFav(it.id) ? 'on' : '', onclick: () => toggleFav(it.id) }, isFav(it.id) ? '★ Favourite' : '☆ Favourite'),
      it.supported ? plSel : null,
      it.source !== 'url' ? h('button', { onclick: () => send({ type: 'open', path: it.path }) }, 'Show in folder') : null,
      it.source === 'url' ? h('button', { onclick: () => removeUrl(it.id) }, 'Remove') : null),
    it.note ? h('div', { class: 'notice' }, it.note) : null,
    it.type === 'scene' && it.supported && !it.assets ? h('div', { class: 'notice' }, 'Wallpaper Engine isn’t installed here, so scenes that use its effects show their preview picture.') : null,
    it.supported ? propsPanel(it) : h('div', { class: 'notice' },
      it.type === 'scene' ? 'This scene’s files are missing (no scene.json or scene.pkg in its folder).'
        : 'Application wallpapers aren’t supported yet.'));
}

function removeUrl(id) {
  cfg.urls = cfg.urls.filter(u => u.id !== id);
  for (const s of Object.values(cfg.displays)) if (s.item === id) s.item = null;
  delete cfg.props[id];
  selId = null;
  save();
}

function propsPanel(it) {
  const p = P(it.id);
  const media = it.type === 'image' || it.type === 'video';
  const set = (k, v) => { p[k] = v; save(); };
  const pct = v => Math.round(v * 100) + '%';
  const look = [];
  if (media) {
    look.push(row('Alignment', select({ cover: 'Cover (fill, crop edges)', fit: 'Fit (show all)', stretch: 'Stretch', center: 'Centre (actual size)' }, p.align || 'cover', v => set('align', v))));
    look.push(row('Horizontal', ...range(0, 100, 1, p.x ?? 50, v => set('x', v), v => v + '%')));
    look.push(row('Vertical', ...range(0, 100, 1, p.y ?? 50, v => set('y', v), v => v + '%')));
    look.push(row('Zoom', ...range(1, 3, 0.01, p.zoom ?? 1, v => set('zoom', v), pct)));
    look.push(row('Flip', h('input', { type: 'checkbox', checked: !!p.flip, onchange: e => set('flip', e.target.checked) })));
    if (it.type === 'image') look.push(row('Pixel art', h('input', { type: 'checkbox', checked: !!p.pixel, onchange: e => set('pixel', e.target.checked) })));
  }
  look.push(row('Brightness', ...range(0, 2, 0.01, p.brightness ?? 1, v => set('brightness', v), pct)));
  look.push(row('Contrast', ...range(0, 2, 0.01, p.contrast ?? 1, v => set('contrast', v), pct)));
  look.push(row('Saturation', ...range(0, 2, 0.01, p.saturation ?? 1, v => set('saturation', v), pct)));
  look.push(row('Hue shift', ...range(-180, 180, 1, p.hue ?? 0, v => set('hue', v), v => v + '°')));
  if (it.type === 'video') {
    look.push(row('Speed', ...range(0.25, 2, 0.05, p.rate ?? 1, v => set('rate', v), v => v.toFixed(2) + '×')));
    look.push(row('Volume', ...range(0, 100, 1, p.volume ?? 50, v => set('volume', v), v => v + '%')));
  }

  const user = userRows(it);
  const presets = cfg.presets[it.id] || {};
  const presetSel = h('select', null, h('option', { value: '' }, 'Choose a preset…'), Object.keys(presets).map(n => h('option', { value: n }, n)));
  return h('div', { class: 'props' },
    user.length ? h('section', null, h('h3', null, 'Wallpaper settings'), user) : null,
    h('section', null, h('h3', null, 'Look'), look),
    h('section', null, h('h3', null, 'Presets'),
      h('div', { class: 'acts' }, presetSel,
        h('button', { onclick: () => { const n = presetSel.value; if (!n) return; cfg.props[it.id] = structuredClone(presets[n]); save(); renderPanel(); } }, 'Use'),
        h('button', { onclick: () => {
          const n = (prompt('Save these settings as a preset named:') || '').trim();
          if (!n) return;
          (cfg.presets[it.id] ??= {})[n] = structuredClone(P(it.id));
          save(); renderPanel();
        } }, 'Save as…'),
        h('button', { onclick: () => { const n = presetSel.value; if (!n || !confirm(`Delete the preset “${n}”?`)) return; delete presets[n]; save(); renderPanel(); } }, 'Delete'),
        h('button', { onclick: () => { delete cfg.props[it.id]; save(); renderPanel(); } }, 'Reset all'))));
}

function userRows(it) {
  const defs = it.properties || {};
  const p = P(it.id);
  const user = (p.user ??= {});
  return Object.entries(defs)
    .filter(([, d]) => d && typeof d === 'object')
    .sort((a, b) => (a[1].order ?? 0) - (b[1].order ?? 0))
    .map(([key, d]) => {
      const cur = key in user ? user[key] : d.value;
      const set = v => { user[key] = v; save(); };
      const label = niceLabel(d.text || key);
      switch (d.type) {
        case 'color':
          return row(label, h('input', { type: 'color', value: weToHex(cur), oninput: e => set(hexToWe(e.target.value)) }));
        case 'slider': {
          const step = d.step ?? (d.fraction === false ? 1 : 0.01);
          const digits = (String(step).split('.')[1] || '').length;
          return row(label, ...range(d.min ?? 0, d.max ?? 100, step, Number(cur) || 0, set, v => Number(v).toFixed(digits)));
        }
        case 'bool':
          return row(label, h('input', { type: 'checkbox', checked: !!cur, onchange: e => set(e.target.checked) }));
        case 'combo': {
          const opts = d.options || [];
          const el = h('select', { onchange: e => set(opts[+e.target.value]?.value) },
            opts.map((o, i) => h('option', { value: i }, niceLabel(o.label ?? o.value))));
          el.value = String(Math.max(0, opts.findIndex(o => String(o.value) === String(cur))));
          return row(label, el);
        }
        case 'textinput':
          return row(label, h('input', { type: 'text', value: cur ?? '', onchange: e => set(e.target.value) }));
        case 'text':
          return label ? h('div', { class: 'note' }, label) : null;
        default:
          return null;
      }
    })
    .filter(Boolean);
}

/* ---------------- displays ---------------- */

function renderDisplays() {
  const root = $('#tab-displays');
  if (!displays.length) { root.replaceChildren(h('p', { class: 'pad' }, 'No displays reported.')); return; }
  const layout = cfg.layout || 'per';
  const minX = Math.min(...displays.map(d => d.x)), minY = Math.min(...displays.map(d => d.y));
  const maxX = Math.max(...displays.map(d => d.x + d.w)), maxY = Math.max(...displays.map(d => d.y + d.h));
  const scale = Math.min(620 / (maxX - minX), 320 / (maxY - minY));
  const boxes = displays.map(d => {
    const key = layout === 'per' ? d.key : '*';
    const id = (status.playing || {})[layout === 'stretch' ? '*' : d.key] || slot(key).item;
    return h('div', {
      class: 'mon' + (layout !== 'per' || d.key === curDisp ? ' sel' : ''),
      style: `left:${(d.x - minX) * scale}px;top:${(d.y - minY) * scale}px;width:${d.w * scale - 6}px;height:${d.h * scale - 6}px`,
      onclick: () => { curDisp = d.key; renderHeader(); renderDisplays(); },
    }, thumb(byId.get(id), 'mthumb'), h('span', { class: 'mlabel' }, d.name + (d.primary ? ' · main' : ''), h('small', null, `${d.w}×${d.h}`)));
  });

  const key = slotKey();
  const s = slot(key);
  const cur = byId.get(s.item);
  const why = (status.reasons || {})[layout === 'per' ? key : (layout === 'stretch' ? '*' : curDisp)];
  const profiles = Object.keys(cfg.profiles);
  const nameInput = h('input', { type: 'text', placeholder: 'Profile name' });

  root.replaceChildren(h('div', { class: 'cols' },
    h('div', { class: 'box grow' },
      h('h3', null, 'Layout'),
      h('div', { class: 'seg' }, Object.entries({ per: 'A wallpaper per display', stretch: 'Stretch one across all', clone: 'Same wallpaper on each' }).map(([v, label]) =>
        h('button', { class: layout === v ? 'on' : '', onclick: () => { cfg.layout = v; save(); renderHeader(); renderDisplays(); } }, label))),
      h('div', { class: 'mons', style: `height:${(maxY - minY) * scale + 8}px;width:${(maxX - minX) * scale + 8}px` }, boxes),
      h('p', { class: 'dim' }, layout === 'per' ? 'Click a display to choose it, then pick its wallpaper on the Wallpapers tab.' : 'Every display shows the same wallpaper.')),
    h('div', { class: 'box side' },
      h('h3', null, displayName(key)),
      h('p', null, h('b', null, 'Wallpaper: '), cur ? cur.title : 'none (Windows wallpaper shows)'),
      s.playlist ? h('p', null, h('b', null, 'Playlist: '), s.playlist) : null,
      why ? h('p', { class: 'warn' }, why) : null,
      h('div', { class: 'acts' },
        h('button', { class: 'primary', onclick: () => showTab('wallpapers') }, 'Choose wallpaper'),
        h('button', { class: s.muted ? 'on' : '', onclick: () => { s.muted = !s.muted; save(); renderDisplays(); } }, s.muted ? 'Unmute' : 'Mute'),
        h('button', { onclick: () => { s.item = null; s.playlist = null; save(); renderDisplays(); } }, 'Remove wallpaper'),
        cur && cur.type === 'web' ? h('button', { title: 'Developer tools for this web wallpaper', onclick: () => send({ type: 'devtools', display: layout === 'stretch' ? '*' : (layout === 'per' ? key : curDisp) }) }, 'Web devtools') : null),
      h('h3', null, 'Profiles'),
      h('p', { class: 'dim' }, 'A profile remembers the layout and what every display shows.'),
      h('div', { class: 'acts' }, nameInput, h('button', { onclick: () => {
        const n = nameInput.value.trim(); if (!n) return;
        cfg.profiles[n] = { layout: cfg.layout, displays: structuredClone(cfg.displays) };
        save(); renderDisplays();
      } }, 'Save')),
      h('ul', { class: 'list' }, profiles.length ? profiles.map(n => h('li', null, h('span', null, n),
        h('button', { onclick: () => { const pr = cfg.profiles[n]; cfg.layout = pr.layout; cfg.displays = structuredClone(pr.displays); save(); renderHeader(); renderDisplays(); } }, 'Load'),
        h('button', { onclick: () => { if (confirm(`Delete the profile “${n}”?`)) { delete cfg.profiles[n]; save(); renderDisplays(); } } }, 'Delete'))) : h('li', { class: 'dim' }, 'No profiles yet.')))));
}

/* ---------------- playlists ---------------- */

function renderPlaylists() {
  const root = $('#tab-playlists');
  const names = Object.keys(cfg.playlists);
  if (!names.includes(editPl)) editPl = names[0] || null;
  const list = h('div', { class: 'box narrow' },
    h('h3', null, 'Playlists'),
    h('ul', { class: 'list pick' }, names.map(n => h('li', { class: n === editPl ? 'on' : '', onclick: () => { editPl = n; renderPlaylists(); } },
      h('span', null, n), h('small', null, cfg.playlists[n].items.length)))),
    h('button', { onclick: () => {
      const n = (prompt('Name for the new playlist:') || '').trim();
      if (!n) return;
      cfg.playlists[n] ??= { items: [], order: 'sorted', minutes: 15, fade: true };
      editPl = n; save(); renderPlaylists();
    } }, '+ New playlist'));
  if (!editPl) {
    root.replaceChildren(h('div', { class: 'cols' }, list, h('div', { class: 'box grow' },
      h('h3', null, 'No playlists yet'),
      h('p', null, 'A playlist changes the wallpaper on a timer. Make one here, then add wallpapers to it from the Wallpapers tab.'))));
    return;
  }
  const pl = cfg.playlists[editPl];
  const name = editPl;
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= pl.items.length) return; [pl.items[i], pl.items[j]] = [pl.items[j], pl.items[i]]; save(); renderPlaylists(); };
  root.replaceChildren(h('div', { class: 'cols' }, list, h('div', { class: 'box grow' },
    h('h3', null, name),
    h('div', { class: 'opts' },
      row('Order', select({ sorted: 'In order', random: 'Shuffle' }, pl.order || 'sorted', v => { pl.order = v; save(); })),
      row('Change every', h('input', { type: 'number', min: 1, max: 1440, value: pl.minutes ?? 15, onchange: e => { pl.minutes = Math.max(1, +e.target.value || 15); save(); } }), h('span', { class: 'val' }, 'minutes')),
      row('Fade between', h('input', { type: 'checkbox', checked: pl.fade !== false, onchange: e => { pl.fade = e.target.checked; save(); } }))),
    h('div', { class: 'acts' },
      h('button', { class: 'primary', disabled: !pl.items.length, onclick: () => { const s = slot(); s.playlist = name; save(); toast(`Playing “${name}” on ${displayName(slotKey())}`); } }, 'Play on ' + displayName(slotKey())),
      h('button', { onclick: () => {
        const n = (prompt('Rename playlist to:', name) || '').trim();
        if (!n || n === name || cfg.playlists[n]) return;
        cfg.playlists[n] = pl; delete cfg.playlists[name];
        for (const s of Object.values(cfg.displays)) if (s.playlist === name) s.playlist = n;
        editPl = n; save(); renderPlaylists();
      } }, 'Rename'),
      h('button', { onclick: () => {
        if (!confirm(`Delete the playlist “${name}”? The wallpapers themselves stay.`)) return;
        delete cfg.playlists[name];
        for (const s of Object.values(cfg.displays)) if (s.playlist === name) s.playlist = null;
        save(); renderPlaylists();
      } }, 'Delete')),
    pl.items.length ? h('ol', { class: 'plitems' }, pl.items.map((id, i) => {
      const it = byId.get(id);
      return h('li', null, thumb(it, 'pthumb'), h('span', { class: 't' }, it ? it.title : 'Missing: ' + id),
        h('button', { title: 'Move up', onclick: () => move(i, -1) }, '↑'),
        h('button', { title: 'Move down', onclick: () => move(i, 1) }, '↓'),
        h('button', { title: 'Remove from playlist', onclick: () => { pl.items.splice(i, 1); save(); renderPlaylists(); } }, '✕'));
    })) : h('p', { class: 'dim' }, 'Empty. On the Wallpapers tab, pick a wallpaper and use “Add to playlist”.'))));
}

/* ---------------- settings ---------------- */

const CONDITIONS = [
  ['focused', 'Another app is focused'], ['maximized', 'Another app is maximized'], ['fullscreen', 'Another app is fullscreen'],
  ['audio', 'Another app is playing audio'], ['battery', 'Laptop is on battery'], ['sleep', 'Display is asleep'],
];
const RULE_WHEN = { running: 'is running', focused: 'is focused', maximized: 'is maximized', fullscreen: 'is fullscreen', audio: 'is playing audio' };
const RULE_DO = { ...ACTIONS, wallpaper: 'Show a wallpaper' };
const HOTKEY_ACTIONS = { pause: 'Pause / resume', stop: 'Stop / start', mute: 'Mute / unmute', next: 'Next wallpaper', icons: 'Hide / show desktop icons', browse: 'Open the library', settings: 'Open settings' };
const HOTKEY_PICKS = { wallpaper: 'Show wallpaper', playlist: 'Play playlist', profile: 'Load profile' };

function keyName(e) {
  const c = e.code;
  if (/^Key[A-Z]$/.test(c)) return c.slice(3);
  if (/^Digit\d$/.test(c)) return 'D' + c.slice(5);
  if (/^Numpad\d$/.test(c)) return 'NumPad' + c.slice(6);
  if (/^F\d{1,2}$/.test(c)) return c;
  return { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Home: 'Home', End: 'End',
    PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete', Pause: 'Pause' }[c] || null;
}

function hotkeyInput(entry, onSet) {
  const bad = (status.hotkeyErrors || []).includes(entry.keys);
  return h('input', {
    type: 'text', readOnly: true, class: 'hk' + (bad ? ' bad' : ''), value: entry.keys || '', placeholder: 'Click, then press keys',
    title: bad ? 'Windows refused this combination (another program uses it)' : 'Needs Ctrl, Alt, Shift or Win. Backspace clears it.',
    onkeydown: e => {
      e.preventDefault();
      if (e.key === 'Backspace' || e.key === 'Delete') { onSet(''); return; }
      const k = keyName(e);
      if (!k || !(e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) return;
      const combo = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Win', k].filter(Boolean).join('+');
      const other = cfg.hotkeys.find(x => x !== entry && x.keys === combo);
      if (other && !confirm(`${combo} is already used for “${HOTKEY_ACTIONS[other.action] || HOTKEY_PICKS[other.action]}”. Use it here instead?`)) return;
      if (other) other.keys = '';
      onSet(combo);
    },
  });
}

function renderSettings() {
  const root = $('#tab-settings');
  const st = cfg.settings;
  const set = (k, v) => { st[k] = v; save(); };

  const sources = h('ul', { class: 'list' }, cfg.sources.length ? cfg.sources.map((s, i) => h('li', null,
    h('span', { class: 'path' }, s),
    h('button', { onclick: () => send({ type: 'open', path: s }) }, 'Open'),
    h('button', { onclick: () => { cfg.sources.splice(i, 1); save(); renderSettings(); } }, 'Remove'))) : h('li', { class: 'dim' }, 'No folders yet.'));

  const rules = cfg.rules;
  const playback = CONDITIONS.map(([k, label]) => row(label, select(ACTIONS, rules[k] || 'keep', v => { rules[k] = v; save(); })));

  const supported = items.filter(i => i.supported).sort((a, b) => a.title.localeCompare(b.title));
  const itemOptions = Object.fromEntries([['', 'Choose…'], ...supported.map(i => [i.id, i.title])]);
  const appRules = cfg.appRules.map((r, i) => h('div', { class: 'rule' },
    h('input', { type: 'text', value: r.app || '', placeholder: 'game.exe', onchange: e => { r.app = e.target.value.trim(); save(); } }),
    select(RULE_WHEN, r.when || 'running', v => { r.when = v; save(); }),
    select(RULE_DO, r.action || 'pause', v => { r.action = v; save(); renderSettings(); }),
    r.action === 'wallpaper' ? select(itemOptions, r.arg || '', v => { r.arg = v; save(); }) : null,
    h('button', { title: 'Remove rule', onclick: () => { cfg.appRules.splice(i, 1); save(); renderSettings(); } }, '✕')));

  const fixed = Object.entries(HOTKEY_ACTIONS).map(([action, label]) => {
    let entry = cfg.hotkeys.find(x => x.action === action && !x.arg) || { action, keys: '' };
    return row(label, hotkeyInput(entry, combo => {
      if (!cfg.hotkeys.includes(entry)) cfg.hotkeys.push(entry);
      entry.keys = combo;
      cfg.hotkeys = cfg.hotkeys.filter(x => x.keys || x.arg);
      save(); renderSettings();
    }));
  });
  const pickOptions = action => Object.fromEntries([['', 'Choose…'], ...(action === 'wallpaper' ? supported.map(i => [i.id, i.title])
    : Object.keys(action === 'playlist' ? cfg.playlists : cfg.profiles).map(n => [n, n]))]);
  const custom = cfg.hotkeys.filter(x => HOTKEY_PICKS[x.action]).map(entry => h('div', { class: 'rule' },
    select(HOTKEY_PICKS, entry.action, v => { entry.action = v; entry.arg = ''; save(); renderSettings(); }),
    select(pickOptions(entry.action), entry.arg || '', v => { entry.arg = v; save(); }),
    hotkeyInput(entry, combo => { entry.keys = combo; save(); renderSettings(); }),
    h('button', { title: 'Remove hotkey', onclick: () => { cfg.hotkeys.splice(cfg.hotkeys.indexOf(entry), 1); save(); renderSettings(); } }, '✕')));

  root.replaceChildren(h('div', { class: 'settings' },
    h('div', { class: 'box' }, h('h3', null, 'General'),
      row('Theme', select(THEMES, st.theme || 'slate', v => { set('theme', v); document.documentElement.dataset.theme = v; })),
      row('Start with Windows', h('input', { type: 'checkbox', checked: !!st.startWithWindows, onchange: e => set('startWithWindows', e.target.checked) })),
      row('Master volume', ...range(0, 100, 1, st.volume ?? 100, v => set('volume', v), v => v + '%'))),
    h('div', { class: 'box' }, h('h3', null, 'Wallpaper folders'),
      h('p', { class: 'dim' }, 'Pape shows pictures, videos and Wallpaper Engine wallpapers (folders with a project.json, such as Steam’s Workshop folder) from these folders and their subfolders.'),
      sources,
      h('div', { class: 'acts' },
        h('button', { class: 'primary', onclick: () => send({ type: 'pickFolder' }) }, 'Add folder…'),
        h('button', { onclick: () => send({ type: 'rescan' }) }, 'Rescan')),
      h('p', { class: 'dim' }, info.weInstall ? 'Wallpaper Engine found at ' + info.weInstall : 'Wallpaper Engine isn’t installed on this PC.')),
    h('div', { class: 'box' }, h('h3', null, 'Playback'),
      h('p', { class: 'dim' }, 'What wallpapers do while you use other programs. Focused, maximized and fullscreen only affect the display that app is on.'),
      playback),
    h('div', { class: 'box' }, h('h3', null, 'Application rules'),
      h('p', { class: 'dim' }, 'Do something while a particular program runs. Use the program’s file name, such as chrome.exe.'),
      appRules,
      h('button', { onclick: () => { cfg.appRules.push({ app: '', when: 'running', action: 'pause' }); save(); renderSettings(); } }, '+ Add rule')),
    h('div', { class: 'box' }, h('h3', null, 'Hotkeys'),
      h('p', { class: 'dim' }, 'Click a box and press a key combination that includes Ctrl, Alt, Shift or Win. Backspace clears it.'),
      fixed,
      h('h4', null, 'Hotkeys for a wallpaper, playlist or profile'),
      custom,
      h('button', { onclick: () => { cfg.hotkeys.push({ action: 'wallpaper', arg: '', keys: '' }); renderSettings(); } }, '+ Add hotkey')),
    h('div', { class: 'box' }, h('h3', null, 'Advanced'),
      h('div', { class: 'acts' },
        h('button', { onclick: () => send({ type: 'open', path: info.dataDir }) }, 'Open data folder'),
        h('button', { onclick: () => { if (confirm('Reset Pape completely? All settings, playlists, presets and profiles are cleared. Your wallpaper files are not touched.')) send({ type: 'reset' }); } }, 'Reset everything'),
        h('button', { onclick: () => send({ type: 'exit' }) }, 'Quit Pape')),
      h('p', { class: 'dim' }, `Desktop: ${status.desktop || 'not attached yet'}. Data: ${info.dataDir || ''}`)),
    h('div', { class: 'box about' }, h('h3', null, 'About'),
      h('p', null, h('b', null, 'Pape ' + VERSION), ' · offline live wallpapers for Windows.'),
      h('p', { class: 'dim' }, 'Pape is an independent personal project. It can play wallpapers made for Wallpaper Engine but is not made by or connected to its developers.'),
      h('p', { class: 'dim' }, 'Copyright © 2026 DontGoToCollege. MIT licence.'))));
}

/* ---------------- toast ---------------- */

function toast(text) {
  const t = h('div', { class: 'toast' }, text);
  document.body.append(t);
  setTimeout(() => t.classList.add('gone'), 2200);
  setTimeout(() => t.remove(), 2700);
}

/* ---------------- start ---------------- */

showTab((location.hash || '#wallpapers').slice(1));
send({ type: 'ready' });
