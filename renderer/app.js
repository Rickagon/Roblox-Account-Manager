const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

const AGING_DAYS = 20;

const state = {
  accounts: [],
  presence: {},
  settings: {},
  selected: new Set(),
  lastClicked: null,
  collapsed: new Set(JSON.parse(safeGet('collapsedGroups') || '[]')),
  filter: '',
  sort: JSON.parse(safeGet('sort') || 'null'),
};

function safeGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSet(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null) n.append(c);
  return n;
}

async function api(promise) {
  const r = await promise;
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
const run = fn => (...a) => Promise.resolve(fn(...a)).catch(e => log(e.message, 'error'));

let statusTimer;
function log(msg, level = 'info') {
  (level === 'error' ? console.error : console.log)(msg);
  const bar = $('#status');
  if (!bar) return;
  bar.textContent = msg;
  bar.className = `status ${level}`;
  clearTimeout(statusTimer);
  if (level !== 'error') statusTimer = setTimeout(() => { bar.textContent = ''; }, 6000);
}

// ---------- account table ----------

const PRESENCE = {
  0: { cls: 'offline', label: 'Offline' },
  1: { cls: 'online', label: 'Online' },
  2: { cls: 'ingame', label: 'In game' },
  3: { cls: 'studio', label: 'In Studio' },
};

const accountById = id => state.accounts.find(a => a.id === id);
const selectedAccounts = () => [...state.selected].map(accountById).filter(Boolean);
const groupNames = () => [...new Set(state.accounts.map(a => a.group || 'Default'))];

function isAging(a) {
  if (state.settings.agingAlert === false) return false;
  const last = Date.parse(a.lastUse || a.addedAt || 0) || 0;
  return Date.now() - last > AGING_DAYS * 86400000;
}

function visibleAccounts() {
  const f = state.filter.toLowerCase().trim();
  const list = !f ? state.accounts : state.accounts.filter(a =>
    [a.username, a.displayName, a.alias, a.group].some(v => (v || '').toLowerCase().includes(f)));
  return list;
}

function renderAccounts() {
  const list = $('#account-list');
  list.replaceChildren();

  $('#empty').classList.toggle('hidden', state.accounts.length > 0);
  const dead = state.accounts.filter(a => !a.valid).length;
  $('#count').textContent = `${state.accounts.length} accounts${dead ? ` · ${dead} need login` : ''}`;

  $('#group-list').replaceChildren(...groupNames().map(g => el('option', { value: g })));

  const groups = new Map();
  for (const a of visibleAccounts()) {
    const g = a.group || 'Default';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(a);
  }
  const showHeads = groups.size > 1;

  for (const [group, accs] of groups) {
    const collapsed = showHeads && state.collapsed.has(group);
    if (showHeads) {
      list.append(el('div', {
        class: `group-head${collapsed ? ' collapsed' : ''}`,
        onclick: () => {
          collapsed ? state.collapsed.delete(group) : state.collapsed.add(group);
          safeSet('collapsedGroups', JSON.stringify([...state.collapsed]));
          renderAccounts();
        },
      }, el('span', { class: 'caret' }, '▾'), `${group} (${accs.length})`));
    }
    if (!collapsed) for (const a of accs) list.append(accountRow(a));
  }
  applyPresence();
}

function accountRow(a) {
  const row = el('div', {
    class: `trow${state.selected.has(a.id) ? ' selected' : ''}`,
    'data-id': a.id,
    onclick: e => onRowClick(e, a.id),
    oncontextmenu: e => onRowContext(e, a.id),
  },
    el('div', { class: 'col-user' },
      el('div', { class: 'mini-avatar' }, a.avatarUrl ? el('img', { src: a.avatarUrl, alt: '' }) : null),
      el('span', { class: 'sdot', 'data-uid': a.userId, 'data-valid': a.valid ? '1' : '0' }),
      el('span', { class: 'uname', title: a.username }, a.username),
      isAging(a) ? el('span', { class: 'aging', title: `Not launched in ${AGING_DAYS}+ days` }, '⏱') : null),
    el('div', { class: 'col-alias', title: a.alias || '' }, a.alias || ''),
    el('div', { class: 'col-status' },
      !a.valid ? el('span', { class: 'badge bad' }, 'expired')
        : !a.hasPassword ? el('span', { class: 'badge nopw', title: 'No password saved' }, 'no pw') : null));
  return row;
}

let suppressClick = false;
// A plain click on a row that's already part of a multi-selection waits briefly
// before collapsing to that row, in case it's the first half of a
// double-click-and-hold (which drags the whole selection).
let pendingCollapse = null;
function cancelPendingCollapse() { clearTimeout(pendingCollapse); pendingCollapse = null; }
function onRowClick(e, id) {
  if (suppressClick) { suppressClick = false; return; }
  if (e.detail >= 2) return; // second click of a double-click: leave selection alone
  if (!e.shiftKey && !e.ctrlKey && !e.metaKey && state.selected.has(id) && state.selected.size > 1) {
    cancelPendingCollapse();
    pendingCollapse = setTimeout(() => {
      pendingCollapse = null;
      state.selected = new Set([id]); state.lastClicked = id;
      renderAccounts(); renderEditor();
    }, 300);
    return;
  }
  const ids = visibleAccounts().map(a => a.id);
  if (e.shiftKey && state.lastClicked) {
    const from = ids.indexOf(state.lastClicked), to = ids.indexOf(id);
    if (from !== -1 && to !== -1) {
      const [lo, hi] = from < to ? [from, to] : [to, from];
      if (!(e.ctrlKey || e.metaKey)) state.selected.clear();
      for (let i = lo; i <= hi; i++) state.selected.add(ids[i]);
    }
  } else if (e.ctrlKey || e.metaKey) {
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    state.lastClicked = id;
  } else {
    state.selected.clear();
    state.selected.add(id);
    state.lastClicked = id;
  }
  renderAccounts();
  renderEditor();
}

function applyPresence() {
  for (const dot of $$('.sdot')) {
    if (dot.dataset.valid === '0') { dot.className = 'sdot expired'; dot.title = 'Logged out: session expired. Use "Log in again".'; continue; }
    const p = state.presence[dot.dataset.uid];
    const info = PRESENCE[p?.userPresenceType ?? 0] || PRESENCE[0];
    dot.className = `sdot ${info.cls}`;
    dot.title = p?.userPresenceType === 2 && p.lastLocation ? `In game: ${p.lastLocation}` : info.label;
  }
}

// ---------- drag (marquee) selection ----------

// While a drag is in progress the account list must not be rebuilt from under
// it (presence/keepalive pushes), or the drag stutters. Freeze and apply later.
let isDragging = false;
let pendingAccounts = null;
function setDragging(v) {
  isDragging = v;
  if (!v) {
    if (pendingAccounts) { state.accounts = pendingAccounts; pendingAccounts = null; renderAccounts(); renderEditor(); }
    applyPresence();
  }
}

function setupMarquee() {
  const list = $('#account-list');
  let curX = 0, curY = 0, raf = null, dragRows = null, scrollTimer = null;
  // marquee
  let mActive = false, startX = null, startContentY = 0, box = null, base = null;
  // reorder
  let reFrom = null, reActive = false, dropTarget = null, dropAfter = false;

  const lrect = () => list.getBoundingClientRect();
  const rows = () => dragRows || [...list.querySelectorAll('.trow')];
  const clearDrop = () => { if (dropTarget) dropTarget.classList.remove('drop-above', 'drop-below'); };

  // One update per animation frame, using the latest mouse position.
  const schedule = () => { if (raf == null) raf = requestAnimationFrame(frame); };
  function frame() { raf = null; if (mActive) doMarquee(); else if (reActive) doReorder(); }

  function doMarquee() {
    const lr = lrect();
    const startVpTop = startContentY - list.scrollTop + lr.top;
    // Visual box (viewport space, clamped to the list).
    const x = Math.max(lr.left, Math.min(startX, curX));
    const right = Math.min(lr.right, Math.max(startX, curX));
    const top = Math.max(lr.top, Math.min(startVpTop, curY));
    const bottom = Math.min(lr.bottom, Math.max(startVpTop, curY));
    Object.assign(box.style, { left: x + 'px', top: top + 'px', width: Math.max(0, right - x) + 'px', height: Math.max(0, bottom - top) + 'px' });
    // Selection band computed in the list's own coordinates, so scrolling
    // extends it and moving back up shrinks it. Exact, not add-only.
    const curContentY = curY - lr.top + list.scrollTop;
    const lo = Math.min(startContentY, curContentY), hi = Math.max(startContentY, curContentY);
    const sel = new Set(base);
    for (const r of rows()) { const t = r.offsetTop; if (t < hi && t + r.offsetHeight > lo) sel.add(r.dataset.id); }
    state.selected = sel;
    for (const r of rows()) r.classList.toggle('selected', sel.has(r.dataset.id));
  }

  function doReorder() {
    document.body.style.cursor = 'grabbing';
    clearDrop();
    dropTarget = null;
    for (const r of rows()) {
      const b = r.getBoundingClientRect();
      if (curY < b.top + b.height / 2) { dropTarget = r; dropAfter = false; break; }
      dropTarget = r; dropAfter = true;
    }
    if (dropTarget) dropTarget.classList.add(dropAfter ? 'drop-below' : 'drop-above');
  }

  const startAutoScroll = () => {
    if (scrollTimer) return;
    scrollTimer = setInterval(() => {
      const b = lrect(); let dy = 0;
      if (curY > b.bottom - 30) dy = 18; else if (curY < b.top + 30) dy = -18;
      if (dy) { const before = list.scrollTop; list.scrollTop += dy; if (list.scrollTop !== before) schedule(); }
    }, 30);
  };
  const stopAutoScroll = () => { clearInterval(scrollTimer); scrollTimer = null; };

  list.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('button, input, a')) return;
    startX = null;
    curX = e.clientX; curY = e.clientY;
    dragRows = [...list.querySelectorAll('.trow')]; // cache rows for the whole drag
    const row = e.target.closest('.trow');
    if (row && e.detail >= 2 && !state.filter) {
      // Double-click and hold: move. Keep the selection if this row is in it,
      // otherwise move just this row.
      cancelPendingCollapse();
      if (!state.selected.has(row.dataset.id)) {
        state.selected = new Set([row.dataset.id]); state.lastClicked = row.dataset.id;
        for (const r of dragRows) r.classList.toggle('selected', r === row);
      }
      reFrom = { x: e.clientX, y: e.clientY }; reActive = false;
      return;
    }
    $$('.marquee').forEach(m => m.remove());
    const lr = lrect();
    startX = e.clientX;
    startContentY = e.clientY - lr.top + list.scrollTop;
    base = (e.ctrlKey || e.metaKey) ? new Set(state.selected) : new Set();
    mActive = false;
  });

  document.addEventListener('mousemove', e => {
    curX = e.clientX; curY = e.clientY;
    if (reFrom) {
      if (!reActive) {
        if (Math.hypot(curX - reFrom.x, curY - reFrom.y) < 5) return;
        reActive = true; setDragging(true); startAutoScroll();
      }
      schedule();
      return;
    }
    if (startX == null) return;
    if (!mActive) {
      const startVp = startContentY - list.scrollTop + lrect().top;
      if (Math.hypot(curX - startX, curY - startVp) < 5) return;
      mActive = true; setDragging(true);
      box = el('div', { class: 'marquee' }); document.body.append(box);
      startAutoScroll();
    }
    schedule();
  });

  const finish = () => {
    stopAutoScroll();
    if (raf != null) { cancelAnimationFrame(raf); raf = null; }
    if (reFrom) {
      const was = reActive, target = dropTarget, after = dropAfter;
      document.body.style.cursor = ''; clearDrop();
      reFrom = null; reActive = false; dropTarget = null; dragRows = null;
      if (was) { setDragging(false); if (target) { suppressClick = true; run(reorderTo)(target.dataset.id, after); } }
      return;
    }
    if (startX == null) return;
    const was = mActive;
    if (box) { box.remove(); box = null; }
    startX = null; mActive = false; dragRows = null;
    if (was) { setDragging(false); suppressClick = true; renderEditor(); }
  };
  document.addEventListener('mouseup', finish);
  window.addEventListener('blur', finish);
}

// Move all selected accounts to just before/after the target row, then persist.
async function reorderTo(targetId, after) {
  if (state.selected.has(targetId)) return; // dropped onto the selection itself
  const ids = state.accounts.map(a => a.id);
  const moving = ids.filter(i => state.selected.has(i));
  if (!moving.length) return;
  const rest = ids.filter(i => !moving.includes(i));
  let at = rest.indexOf(targetId);
  if (at === -1) return;
  if (after) at += 1;
  await api(window.ram.reorder([...rest.slice(0, at), ...moving, ...rest.slice(at)]));
}

// ---------- right-click context menu ----------

function onRowContext(e, id) {
  e.preventDefault();
  if (!state.selected.has(id)) { state.selected.clear(); state.selected.add(id); state.lastClicked = id; renderAccounts(); renderEditor(); }
  showContextMenu(e.clientX, e.clientY);
}

function closeContext() { $('#ctx-menu').classList.add('hidden'); }

function showContextMenu(x, y) {
  const menu = $('#ctx-menu');
  const n = state.selected.size;
  const one = n === 1;
  menu.replaceChildren();

  const item = (label, fn, cls) => menu.append(el('button', { class: cls || '', onclick: () => { closeContext(); run(fn)(); } }, label));
  const sub = (label, entries) => {
    const wrap = el('div', { class: 'sub' }, el('button', {}, label),
      el('div', { class: 'submenu' }, ...entries.map(([t, f]) => el('button', { onclick: () => { closeContext(); run(f)(); } }, t))));
    menu.append(wrap);
  };

  menu.append(el('div', { class: 'label' }, one ? accountById([...state.selected][0]).username : `${n} accounts`));
  sub('Open browser', BROWSER_TARGETS.map(([t, u]) => [t, () => openBrowserAt(u)]));
  sub('Copy', [
    ['Username', () => copyField('username')],
    ['Password', () => copyField('password')],
    ['User:Pass combo', () => copyField('combo')],
    ['Cookie', () => copyField('cookie')],
    ['User ID', () => copyField('userId')],
  ]);
  menu.append(el('div', { class: 'sep' }));
  item(one ? 'Account Utilities…' : `Account Utilities (${n})…`, openUtils);
  if (one && !accountById([...state.selected][0]).valid) item('Log in again', reloginSelected); // only for expired (red) accounts
  menu.append(el('div', { class: 'sep' }));
  item('Remove', removeSelected, 'danger');

  menu.classList.remove('hidden');
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
  menu.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
}

const BROWSER_TARGETS = [
  ['Home', 'https://www.roblox.com/home'],
  ['Profile', 'profile'],
  ['Friends', 'https://www.roblox.com/users/friends'],
  ['Avatar editor', 'https://www.roblox.com/my/avatar'],
  ['Account settings', 'https://www.roblox.com/my/account'],
  ['Current place page', 'place'],
];

// ---------- editor / detail ----------

let editorFor = '';
function renderEditor() {
  const accs = selectedAccounts();
  const key = accs.map(a => a.id).join(',');
  if (key !== editorFor) {
    editorFor = key;
    const one = accs.length === 1 ? accs[0] : null;
    $('#f-alias').value = one?.alias || '';
    $('#f-group').value = one ? (one.group || 'Default') : '';
  }
  $('#edit-target').textContent = !accs.length ? 'Select accounts to edit'
    : accs.length === 1 ? `Editing ${accs[0].username}` : `Editing ${accs.length} accounts`;

  $('#detail-title').textContent = !accs.length ? 'No account selected'
    : accs.length === 1 ? '1 account selected' : `${accs.length} accounts selected`;

  $('#selected-list').replaceChildren(...accs.map(a => el('div', { class: 'sel-row' },
    el('span', { class: `sdot ${a.valid ? '' : 'expired'}`, 'data-uid': a.userId, 'data-valid': a.valid ? '1' : '0' }),
    el('span', { class: 'sel-name', title: a.alias || a.username }, a.username))));
  applyPresence();
}

async function setField(field, value) {
  const ids = [...state.selected];
  if (!ids.length) return log('Select one or more accounts first');
  await api(window.ram.updateMany(ids, { [field]: value }));
  editorFor = '';
  log(`${field[0].toUpperCase() + field.slice(1)} set for ${ids.length} account${ids.length > 1 ? 's' : ''}`);
}

const COPY_LABEL = { username: 'username', password: 'password', combo: 'user:pass combo', cookie: 'cookie', userId: 'user ID' };
async function copyField(what) {
  const ids = [...state.selected];
  if (!ids.length) return;
  if (ids.length === 1) { await api(window.ram.copy(ids[0], what)); log(`Copied ${COPY_LABEL[what]}`); }
  else { const n = await api(window.ram.copyMany(ids, what)); log(`Copied ${COPY_LABEL[what]} for ${n} accounts (one per line)`); }
}

async function removeSelected() {
  if (!state.selected.size) return;
  if (await api(window.ram.removeAccounts([...state.selected]))) { state.selected.clear(); renderEditor(); }
}

async function reloginSelected() {
  const a = selectedAccounts()[0];
  if (!a) return;
  log(`Log in as ${a.username} in the window that opened`);
  await api(window.ram.relogin(a.id));
}

async function setPasswordSelected() {
  const a = selectedAccounts()[0];
  if (!a) return;
  const pw = await prompt(`Password for ${a.username}`, '', 'password');
  if (pw != null) { await api(window.ram.setPassword(a.id, pw)); log('Password saved'); }
}

// ---------- place panel ----------

let placeLookup;
function updatePlaceName() {
  clearTimeout(placeLookup);
  const id = $('#place-id').value.trim().match(/(?:games\/)?(\d{3,})/)?.[1];
  if (!id) { $('#place-name').textContent = '—'; return; }
  $('#place-name').textContent = '…';
  placeLookup = setTimeout(async () => {
    const r = await window.ram.placeInfo(id);
    if ($('#place-id').value.includes(id)) $('#place-name').textContent = r.ok && r.data ? r.data.name : 'Unknown place';
  }, 400);
}

// Remember the Place ID, Job ID / link and follow username across restarts.
let saveTargetsTimer;
function saveTargets(now = false) {
  clearTimeout(saveTargetsTimer);
  const write = () => window.ram.setSettings({
    savedPlaceId: $('#place-id').value.trim(),
    savedJobId: $('#job-id').value.trim(),
    savedFollowUser: $('#follow-user').value.trim(),
  }).then(r => { if (r.ok) state.settings = r.data; });
  if (now) write(); else saveTargetsTimer = setTimeout(write, 300);
}

function updateMultiStatus() {
  const on = state.settings.multiRoblox;
  $('#multi-status').textContent = `Multi-Roblox: ${on ? 'on' : 'off'}`;
  $('#multi-status').classList.toggle('on', on);
}

// ---------- actions ----------

function needSelection() {
  if (state.selected.size) return true;
  log('Select one or more accounts first');
  return false;
}

async function doJoin() {
  if (!needSelection()) return;
  const placeId = $('#place-id').value.trim();
  const jobId = $('#job-id').value.trim();
  if (!placeId && !jobId) return log('Enter a Place ID, or a private/VIP link in the Job ID box');
  await api(window.ram.join({ ids: [...state.selected], placeId, jobId }));
}

async function doFollow() {
  if (!needSelection()) return;
  const followUser = $('#follow-user').value.trim();
  if (!followUser) return log('Enter a username to follow');
  state.settings = await api(window.ram.setSettings({ savedFollowUser: followUser }));
  await api(window.ram.join({ ids: [...state.selected], followUser }));
}

async function openBrowserAt(choice) {
  const accs = selectedAccounts();
  if (!accs.length) return log('Select an account first');
  let url = choice;
  if (choice === 'custom') { url = await prompt('Open which URL?', 'https://www.roblox.com/'); if (!url) return; }
  else if (choice === 'place') {
    const id = $('#place-id').value.trim().match(/(\d{3,})/)?.[1];
    if (!id) return log('Enter a place ID first');
    url = `https://www.roblox.com/games/${id}`;
  }
  for (const a of accs.slice(0, 5)) {
    const u = choice === 'profile' ? `https://www.roblox.com/users/${a.userId}/profile` : url;
    await api(window.ram.openBrowser(a.id, u));
  }
  if (accs.length > 5) log('Opened browsers for the first 5 selected accounts');
}

// ---------- dialogs ----------

function prompt(title, value = '', type = 'text') {
  return new Promise(resolve => {
    const dlg = $('#dlg-prompt'), input = $('#prompt-input');
    $('#prompt-title').textContent = title;
    input.value = value; input.type = type;
    const done = r => { dlg.close(); resolve(r); };
    $('#prompt-ok').onclick = () => done(input.value);
    input.onkeydown = e => { if (e.key === 'Enter') done(input.value); };
    dlg.querySelector('[data-close]').onclick = () => done(null);
    dlg.showModal(); input.focus();
  });
}

function batchDialog(title, hint, placeholder) {
  return new Promise(resolve => {
    const dlg = $('#dlg-batch');
    $('#batch-title').textContent = title;
    $('#batch-hint').textContent = hint;
    $('#batch-input').value = '';
    $('#batch-input').placeholder = placeholder;
    const done = r => { dlg.close(); resolve(r); };
    $('#batch-ok').onclick = () => done($('#batch-input').value);
    dlg.querySelector('[data-close]').onclick = () => done(null);
    dlg.showModal(); $('#batch-input').focus();
  });
}

async function addAccount(kind) {
  if (kind === 'manual') {
    log('Log in to Roblox in the window that opened');
    await api(window.ram.addLogins(''));
  } else if (kind === 'auto') {
    const text = await batchDialog('Auto login', 'One account per line as user:pass. Login windows open tiled across your screen, several at once, with the details filled in. You do the "hold" check in each one.', 'user1:pass1\nuser2:pass2');
    if (text?.trim()) { const r = await api(window.ram.addLogins(text)); log(`Added ${r.added} of ${r.total}`); }
  } else if (kind === 'cookie') {
    const text = await batchDialog('Login with cookie(s)', 'One .ROBLOSECURITY cookie per line.', '_|WARNING:-DO-NOT-SHARE-THIS...');
    if (text?.trim()) { const r = await api(window.ram.addCookies(text)); log(`Added ${r.added} of ${r.total}`); }
  } else if (kind === 'ram') {
    const file = await api(window.ram.pickRamFile());
    if (!file) return;
    const r = await api(window.ram.importRam(file));
    log(`Imported ${r.added} new, updated ${r.updated}`);
  }
}

async function openUtils() {
  const accs = selectedAccounts();
  if (!accs.length) return log('Select an account first');
  const one = accs.length === 1 ? accs[0] : null;
  const dlg = $('#dlg-utils');
  $('#utils-title').textContent = one ? `Account Utilities — ${one.username}` : `Account Utilities — ${accs.length} accounts`;
  $('#u-display').value = one?.displayName || '';
  $('#u-cur').value = ''; $('#u-new').value = '';
  // For a batch, the current-password field is optional (uses saved passwords).
  $('#u-cur').placeholder = one ? 'Current password' : 'Current password (blank = use saved)';
  dlg.showModal();

  if (one) {
    $('#utils-summary').textContent = 'Loading summary…';
    const r = await window.ram.summary(one.id);
    if (r.ok) {
      const s = r.data, fmt = v => v == null ? '—' : v.toLocaleString();
      $('#utils-summary').replaceChildren(
        el('span', {}, `Robux: ${fmt(s.robux)}`),
        el('span', {}, `Friends: ${fmt(s.friends)}`),
        el('span', {}, `Followers: ${fmt(s.followers)}`),
        el('span', {}, `Joined: ${s.created ? new Date(s.created).toLocaleDateString() : '—'}`));
    } else $('#utils-summary').textContent = 'Could not load summary';
  } else {
    $('#utils-summary').textContent = `Changes below apply to all ${accs.length} selected accounts.`;
  }
}

function openGroupDialog() {
  if (!state.selected.size) return log('Select accounts first');
  const dlg = $('#dlg-group');
  const choices = $('#group-choices');
  choices.replaceChildren(...groupNames().map(g =>
    el('button', { onclick: run(async () => { await setField('group', g); dlg.close(); }) }, g)));
  $('#group-new').value = '';
  $('#group-new-btn').onclick = run(async () => {
    const g = $('#group-new').value.trim();
    if (g) { await setField('group', g); dlg.close(); }
  });
  dlg.showModal();
}

async function openServers() {
  const placeId = $('#place-id').value.trim().match(/(\d{3,})/)?.[1];
  if (!placeId) return log('Enter a place ID first');
  const dlg = $('#dlg-servers');
  dlg.dataset.place = placeId; dlg.dataset.cursor = '';
  $('#servers-body').replaceChildren();
  dlg.showModal();
  await loadServers();
}

async function loadServers() {
  const dlg = $('#dlg-servers');
  const data = await api(window.ram.servers(dlg.dataset.place, dlg.dataset.cursor || ''));
  if (data.name) $('#servers-title').textContent = `Servers — ${data.name}`;
  for (const s of data.data || []) {
    $('#servers-body').append(el('tr', {},
      el('td', {}, `${s.playing}/${s.maxPlayers}`),
      el('td', {}, s.ping != null ? `${s.ping} ms` : '—'),
      el('td', {}, s.fps != null ? String(Math.round(s.fps)) : '—'),
      el('td', { class: 'mono' }, s.id),
      el('td', {}, el('button', { class: 'small', onclick: () => { $('#job-id').value = s.id; saveTargets(true); dlg.close(); log('Server chosen, press Join Server'); } }, 'Select'))));
  }
  dlg.dataset.cursor = data.nextPageCursor || '';
  $('#btn-servers-more').disabled = !data.nextPageCursor;
}

// ---------- wiring ----------

// Split button: main button runs the default action, the arrow toggles the menu.
function setupSplit(mainSel, arrowSel, menuSel, onPick, attr, defaultVal) {
  const menu = $(menuSel);
  $(mainSel).onclick = e => { e.stopPropagation(); menu.classList.add('hidden'); run(onPick)(defaultVal); };
  $(arrowSel).onclick = e => {
    e.stopPropagation();
    $$('.menu').forEach(m => m !== menu && m.classList.add('hidden'));
    menu.classList.toggle('hidden');
  };
  for (const b of menu.querySelectorAll(`[${attr}]`)) b.onclick = () => { menu.classList.add('hidden'); run(onPick)(b.getAttribute(attr)); };
}

function bind() {
  document.addEventListener('click', () => { $$('.menu').forEach(m => m.classList.add('hidden')); closeContext(); });
  document.addEventListener('scroll', closeContext, true);
  setupSplit('#btn-add', '#btn-add-arrow', '#menu-add', addAccount, 'data-add', 'manual');
  setupSplit('#btn-browser', '#btn-browser-arrow', '#menu-browser', openBrowserAt, 'data-url', 'https://www.roblox.com/home');
  setupMarquee();

  $('#btn-remove').onclick = run(() => { if (needSelection()) return removeSelected(); });
  $('#hide-usernames').onchange = e => { document.body.classList.toggle('hide-names', e.target.checked); safeSet('hideUsernames', e.target.checked ? '1' : ''); };
  $('#btn-close-roblox').onclick = run(async () => log(`Closed ${await api(window.ram.closeAllRoblox())} Roblox client(s)`));
  $('#search').oninput = e => { state.filter = e.target.value; renderAccounts(); };

  $('#btn-select-all').onclick = () => {
    const vis = visibleAccounts();
    vis.every(a => state.selected.has(a.id)) ? state.selected.clear() : vis.forEach(a => state.selected.add(a.id));
    renderAccounts(); renderEditor();
  };
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'a' && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); $('#btn-select-all').click(); }
    if (e.key === 'Escape') closeContext();
  });

  $('#btn-check').onclick = run(async () => {
    const ids = state.selected.size ? [...state.selected] : state.accounts.map(a => a.id);
    log(`Checking ${ids.length} session(s)…`);
    await api(window.ram.checkAccounts(ids));
    log('Session check done');
  });

  $('#place-id').oninput = () => { updatePlaceName(); saveTargets(); };
  $('#job-id').oninput = saveTargets;
  $('#follow-user').oninput = saveTargets;
  for (const id of ['#place-id', '#job-id', '#follow-user']) $(id).onchange = () => saveTargets(true);
  $('#btn-join').onclick = run(doJoin);
  $('#btn-follow').onclick = run(doFollow);
  $('#follow-user').onkeydown = e => { if (e.key === 'Enter') $('#btn-follow').click(); };
  $('#btn-servers').onclick = run(openServers);
  $('#btn-servers-more').onclick = run(loadServers);

  $('#btn-set-alias').onclick = run(() => setField('alias', $('#f-alias').value.trim()));
  $('#f-alias').onkeydown = e => { if (e.key === 'Enter') $('#btn-set-alias').click(); };
  $('#btn-set-group').onclick = run(() => setField('group', $('#f-group').value.trim() || 'Default'));
  $('#f-group').onkeydown = e => { if (e.key === 'Enter') $('#btn-set-group').click(); };

  // utilities dialog
  $('#u-display-btn').onclick = run(async () => {
    const ids = [...state.selected], name = $('#u-display').value.trim();
    if (!ids.length || !name) return;
    const ok = await api(window.ram.setDisplayName(ids, name));
    log(`Display name set for ${ok} of ${ids.length}`);
  });
  $('#u-pass-btn').onclick = run(async () => {
    const ids = [...state.selected];
    const cur = $('#u-cur').value, next = $('#u-new').value;
    if (!ids.length || !next) return log('Enter a new password');
    if (ids.length === 1 && !cur) return log('Enter the current password');
    const ok = await api(window.ram.changePassword(ids, cur, next));
    $('#u-cur').value = ''; $('#u-new').value = '';
    log(`Password changed for ${ok} of ${ids.length}`);
  });
  $('#u-privacy-btn').onclick = run(async () => {
    if (!needSelection()) return;
    await api(window.ram.setJoinPrivacy([...state.selected], $('#u-privacy').value));
  });

  // settings
  $('#btn-settings').onclick = () => {
    const s = state.settings;
    $('#s-multiRoblox').checked = s.multiRoblox;
    $('#s-closeLastOnLaunch').checked = s.closeLastOnLaunch;
    $('#s-showPresence').checked = s.showPresence;
    $('#s-agingAlert').checked = s.agingAlert !== false;
    $('#s-runOnStartup').checked = s.runOnStartup;
    $('#s-maxActiveClients').value = s.maxActiveClients;
    $('#s-joinDelaySec').value = s.joinDelaySec;
    $('#s-presenceIntervalSec').value = s.presenceIntervalSec;
    $('#s-keepAliveHours').value = s.keepAliveHours;
    $('#s-autoKeepAlive').checked = s.autoKeepAlive;
    $('#s-autoKeepAliveDays').value = s.autoKeepAliveDays;
    $('#dlg-settings').showModal();
  };
  $('#btn-settings-save').onclick = run(async () => {
    state.settings = await api(window.ram.setSettings({
      multiRoblox: $('#s-multiRoblox').checked,
      closeLastOnLaunch: $('#s-closeLastOnLaunch').checked,
      showPresence: $('#s-showPresence').checked,
      agingAlert: $('#s-agingAlert').checked,
      runOnStartup: $('#s-runOnStartup').checked,
      maxActiveClients: Math.max(1, Number($('#s-maxActiveClients').value) || 20),
      joinDelaySec: Number($('#s-joinDelaySec').value) || 0,
      presenceIntervalSec: Number($('#s-presenceIntervalSec').value) || 5,
      keepAliveHours: Number($('#s-keepAliveHours').value) || 12,
      autoKeepAlive: $('#s-autoKeepAlive').checked,
      autoKeepAliveDays: Math.max(1, Number($('#s-autoKeepAliveDays').value) || 14),
    }));
    updateMultiStatus(); renderAccounts();
    $('#dlg-settings').close();
  });

  for (const dlg of $$('.dialog')) dlg.querySelector('[data-close]')?.addEventListener('click', () => dlg.close());
}

// ---------- events from main ----------

window.ram.onAccounts(list => {
  if (isDragging) { pendingAccounts = list; return; } // applied when the drag ends
  state.accounts = list; renderAccounts(); renderEditor();
});
window.ram.onPresence(p => { state.presence = p; if (!isDragging) applyPresence(); });
window.ram.onLog(({ msg, level }) => log(msg, level === 'error' ? 'error' : 'info'));

// ---------- boot ----------

(async function boot() {
  bind();
  let init;
  try {
    init = await api(window.ram.init());
  } catch (e) {
    console.error('BOOT init FAILED:', e.message);
    log('Could not load: ' + e.message, 'error');
    return;
  }
  state.settings = init.settings;
  state.accounts = init.accounts || [];

  $('#place-id').value = state.settings.savedPlaceId || '';
  $('#job-id').value = state.settings.savedJobId || '';
  $('#follow-user').value = state.settings.savedFollowUser || '';
  if (safeGet('hideUsernames')) { $('#hide-usernames').checked = true; document.body.classList.add('hide-names'); }

  updateMultiStatus();
  renderAccounts();
  renderEditor();
  updatePlaceName();
  if (!state.accounts.length && init.defaultRamFile) log('Found your RAM accounts. Use Add Account ▾ → Import from RAM.');
})();
