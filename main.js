const { app, BrowserWindow, ipcMain, dialog, clipboard, shell, Tray, Menu } = require('electron');
const fs = require('fs');
const path = require('path');
const { Vault } = require('./src/vault');
const { RobloxClient } = require('./src/roblox');
const { readRamFile } = require('./src/ramImport');
const browser = require('./src/browser');
const launcher = require('./src/launcher');

// Keep data OUT of AppData: sandboxed launchers (MSIX-packaged apps) silently
// redirect AppData writes into their own container, which made different
// launches see different account files. A home-folder path is never redirected.
const LEGACY_DIR = path.join(app.getPath('appData'), 'roblox-account-manager-v2');
const SHARED_DIR = path.join(require('os').homedir(), '.roblox-account-manager-v2');
fs.mkdirSync(SHARED_DIR, { recursive: true });
if (!fs.existsSync(path.join(SHARED_DIR, 'accounts.dat'))) {
  // One-time migration from the old AppData location.
  for (const f of ['accounts.dat', 'accounts.dat.bak', 'settings.json', 'recent-games.json']) {
    try { if (fs.existsSync(path.join(LEGACY_DIR, f))) fs.copyFileSync(path.join(LEGACY_DIR, f), path.join(SHARED_DIR, f)); } catch { /* ignore */ }
  }
}
app.setPath('userData', SHARED_DIR);

const DATA_DIR = app.getPath('userData');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const RECENT_FILE = path.join(DATA_DIR, 'recent-games.json');
const DEFAULT_RAM_DIR = path.join(app.getPath('downloads'), 'Roblox.Account.Manager.3.6.1', 'Roblox Account Manager');

const DEFAULT_SETTINGS = {
  multiRoblox: true,
  closeLastOnLaunch: true,
  killClosedClients: true,
  labelWindows: true,
  joinDelaySec: 8,
  shuffleJobId: false,
  showPresence: true,
  presenceIntervalSec: 5,
  keepAliveHours: 12,
  maxRecentGames: 30,
  savedPlaceId: '',
  savedJobId: '',
  savedFollowUser: '',
  agingAlert: true,
  maxActiveClients: 20,
  runOnStartup: false,
  startMinimized: false,
  autoKeepAlive: true,
  autoKeepAliveDays: 14,
  lastActiveAt: null,
};

const KEEPALIVE_MODE = process.argv.includes('--keepalive');
// Launched hidden at Windows startup (see syncLoginItem): grab the Multi-Roblox
// lock silently in the background without popping a window in the user's face.
const STARTED_HIDDEN = process.argv.includes('--hidden');
const TASK_NAME = 'RobloxAccountManagerV2 KeepAlive';

let win;
let tray = null;
let isQuitting = false;
let vault;
let settings = { ...DEFAULT_SETTINGS };
let recentGames = [];
const clients = new Map(); // account id -> RobloxClient
let presenceTimer;
let keepAliveTimer;
let joinInProgress = false; // a launch batch is running
let joinCancel = false;     // request to stop the launch queue

// ---------- persistence helpers ----------

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
function saveSettings() { writeJson(SETTINGS_FILE, settings); }
function saveRecent() { writeJson(RECENT_FILE, recentGames); }

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** What the renderer is allowed to see. Cookies and passwords never leave the main process unless copied. */
function publicAccount(a) {
  return {
    id: a.id,
    userId: a.userId,
    username: a.username,
    displayName: a.displayName,
    alias: a.alias,
    description: a.description,
    group: a.group,
    valid: a.valid,
    hasPassword: !!a.password,
    lastUse: a.lastUse,
    addedAt: a.addedAt,
    cookieUpdatedAt: a.cookieUpdatedAt,
    avatarUrl: a.avatarUrl || '',
  };
}
function pushAccounts() {
  send('accounts', vault.accounts.map(publicAccount));
}

function log(msg, level = 'info') {
  send('log', { msg, level, at: Date.now() });
  (level === 'error' ? console.error : console.log)(msg);
}

// ---------- Roblox clients with cookie rotation ----------

function clientFor(acc) {
  let c = clients.get(acc.id);
  if (!c || c.cookie !== acc.cookie) {
    c = new RobloxClient(acc.cookie, newCookie => {
      vault.update(acc.id, { cookie: newCookie, cookieUpdatedAt: new Date().toISOString(), valid: true });
      log(`Saved refreshed cookie for ${acc.username}`);
    });
    clients.set(acc.id, c);
  }
  return c;
}

function anyValidClient() {
  const acc = vault.accounts.find(a => a.valid);
  return acc ? clientFor(acc) : new RobloxClient('');
}

async function checkAccount(acc) {
  try {
    const user = await clientFor(acc).getAuthenticatedUser();
    vault.update(acc.id, {
      valid: true,
      userId: user.id,
      username: user.name,
      displayName: user.displayName,
      lastChecked: new Date().toISOString(),
    });
    return true;
  } catch (e) {
    if (e.status === 401) {
      vault.update(acc.id, { valid: false, lastChecked: new Date().toISOString() });
      log(`${acc.username}: session expired, log in again to fix it`, 'error');
      return false;
    }
    log(`${acc.username}: check failed (${e.message})`, 'error');
    return null;
  }
}

async function refreshAvatars() {
  try {
    const ids = vault.accounts.filter(a => a.userId).map(a => a.userId);
    const urls = await anyValidClient().getAvatarHeadshots(ids);
    for (const a of vault.accounts) if (urls[a.userId]) a.avatarUrl = urls[a.userId];
    vault.save();
    pushAccounts();
  } catch (e) {
    log(`Could not load avatars: ${e.message}`, 'error');
  }
}

/** Touch each account's session so Roblox can hand us rotated cookies before old ones are retired. */
async function keepAlive(force = false, onProgress) {
  const cutoff = Date.now() - settings.keepAliveHours * 3600 * 1000;
  const due = vault.accounts.filter(a => force || !a.lastChecked || Date.parse(a.lastChecked) < cutoff);
  for (let i = 0; i < due.length; i++) {
    if (onProgress) onProgress(i, due.length, due[i].username);
    await checkAccount(due[i]);
    pushAccounts();
    await new Promise(r => setTimeout(r, 1500));
  }
  markActive();
  return due.length;
}

function markActive() {
  settings.lastActiveAt = new Date().toISOString();
  saveSettings();
}

// ---------- scheduled keep-alive ----------
// A per-user Windows scheduled task starts the app with --keepalive daily and
// at logon. In that mode it quits silently unless the app has gone unused for
// autoKeepAliveDays, in which case it shows a small progress window.

function psRun(script) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise(resolve => {
    require('child_process').execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true },
      (err, _out, stderr) => resolve(err ? (stderr || err.message).trim() : ''));
  });
}

async function syncScheduledTask() {
  if (!settings.autoKeepAlive) {
    await psRun(`Unregister-ScheduledTask -TaskName '${TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue`);
    return;
  }
  const exe = process.execPath.replace(/'/g, "''");
  const args = (app.isPackaged ? '--keepalive' : `"${app.getAppPath()}" --keepalive`).replace(/'/g, "''");
  const err = await psRun(`
$a = New-ScheduledTaskAction -Execute '${exe}' -Argument '${args}'
$t = @((New-ScheduledTaskTrigger -Daily -At 12:00pm), (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME))
$s = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1)
Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $t -Settings $s -Description 'Keeps saved Roblox sessions from expiring when the account manager has not been opened for a while.' -Force | Out-Null
`);
  if (err) log(`Could not set up automatic keep-alive: ${err}`, 'error');
}

function syncLoginItem() {
  try {
    // Start hidden at login so the app can grab the Multi-Roblox lock in the
    // background before any Roblox opens, without flashing a window.
    const args = app.isPackaged ? [] : [app.getAppPath()];
    if (settings.startMinimized) args.push('--hidden');
    app.setLoginItemSettings({ openAtLogin: !!settings.runOnStartup, path: process.execPath, args });
  } catch (e) {
    log(`Could not change the startup setting: ${e.message}`, 'error');
  }
}

function keepAliveDue() {
  const last = Date.parse(settings.lastActiveAt || 0) || 0;
  return Date.now() - last >= settings.autoKeepAliveDays * 24 * 3600 * 1000;
}

async function runKeepAliveMode() {
  if (!keepAliveDue() || !vault.accounts.length) return app.quit();

  win = new BrowserWindow({
    width: 420,
    height: 170,
    resizable: false,
    maximizable: false,
    backgroundColor: '#0f1115',
    title: 'Roblox Account Manager',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await win.loadFile(path.join(__dirname, 'renderer', 'keepalive.html'));

  await keepAlive(true, (i, total, name) => send('keepalive', { i, total, name }));
  const dead = vault.accounts.filter(a => !a.valid).length;
  vault.saveNow();
  send('keepalive', { done: true, total: vault.accounts.length, dead });
  setTimeout(() => app.quit(), dead ? 15000 : 4000);
}

async function pollPresence() {
  if (!settings.showPresence) return;
  const ids = vault.accounts.filter(a => a.userId && a.valid).map(a => a.userId);
  if (!ids.length) return;
  try {
    const out = {};
    for (let i = 0; i < ids.length; i += 50) {
      const list = await anyValidClient().getPresence(ids.slice(i, i + 50));
      for (const p of list) out[p.userId] = p;
    }
    send('presence', out);
  } catch (e) {
    console.error('presence', e.message);
  }
}

let zombieTimer;
const seenWithWindow = new Set();   // pids that have had a game window at some point
const windowlessSince = new Map();  // pid -> when it went windowless after having a window
function restartTimers() {
  clearInterval(presenceTimer);
  clearInterval(keepAliveTimer);
  clearInterval(zombieTimer);
  presenceTimer = setInterval(pollPresence, Math.max(3, settings.presenceIntervalSec) * 1000);
  keepAliveTimer = setInterval(() => keepAlive(false), 60 * 60 * 1000);
  // Clean up ONLY clients that had a game window and then lost it (you closed
  // them) but whose process kept running. Clients still loading (never had a
  // window) and in-game clients are never touched.
  if (settings.killClosedClients !== false) {
    zombieTimer = setInterval(async () => {
      try {
        const procs = await launcher.listRobloxProcesses();
        const alive = new Set(procs.map(p => p.pid));
        for (const pid of [...seenWithWindow]) if (!alive.has(pid)) seenWithWindow.delete(pid);
        for (const pid of [...windowlessSince.keys()]) if (!alive.has(pid)) windowlessSince.delete(pid);
        const now = Date.now();
        const kill = [];
        for (const p of procs) {
          if (p.hasWindow) { seenWithWindow.add(p.pid); windowlessSince.delete(p.pid); continue; }
          if (!seenWithWindow.has(p.pid)) continue; // never had a window -> loading/tray, leave it
          if (!windowlessSince.has(p.pid)) windowlessSince.set(p.pid, now);
          else if (now - windowlessSince.get(p.pid) >= 20000) kill.push(p.pid); // window gone 20s+
        }
        if (kill.length) {
          await launcher.killProcesses(kill);
          kill.forEach(pid => { seenWithWindow.delete(pid); windowlessSince.delete(pid); });
          log(`Closed ${kill.length} leftover Roblox client${kill.length > 1 ? 's' : ''} that didn't exit`);
        }
      } catch { /* transient */ }
    }, 10000);
  }
}

// ---------- joining games ----------

const JOB_GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Works out where to join from the Place ID and Job ID fields.
 * The Job ID field is the priority: it holds private/share links or a server ID.
 *   - Job field with a private/share link  -> that private server (place taken from the link)
 *   - Job field with a plain server GUID    -> that exact server (needs a Place ID)
 *   - Job field empty, Place ID present     -> a random public server
 *   - Both empty                            -> nothing
 * Returns { placeId, jobId, linkCode, shareCode } or null when there's nothing to join.
 */
function parseTarget(placeInput, jobInput) {
  const place = String(placeInput || '').trim();
  const job = String(jobInput || '').trim();
  const t = { placeId: 0, jobId: '', linkCode: '', shareCode: '' };

  const placeIdIn = s => s.match(/games\/(\d+)/i)?.[1] || (/^\d+$/.test(s) ? s : '');
  if (placeIdIn(place)) t.placeId = Number(placeIdIn(place));

  // The Job ID field: link, share code, or a server GUID.
  const share = job.match(/share\?[^ ]*\bcode=([\w-]+)/i) || job.match(/[?&]code=([\w-]+)/i);
  const link = job.match(/privateServerLinkCode=([\w-]+)/i);
  if (share) t.shareCode = share[1];
  else if (link) t.linkCode = link[1];
  else if (JOB_GUID.test(job)) t.jobId = job;
  else if (job) throw new Error('The Job ID box needs a server ID or a private/VIP server link');

  const jobPlace = job.match(/games\/(\d+)/i)?.[1];
  if (jobPlace) t.placeId = Number(jobPlace); // a link in the Job box carries its own place

  if (!t.placeId && !t.linkCode && !t.shareCode) return null;
  return t;
}

async function pickRandomServer(client, placeId) {
  let cursor = '';
  const servers = [];
  for (let page = 0; page < 3; page++) {
    const d = await client.getServers(placeId, cursor);
    servers.push(...(d?.data ?? []).filter(s => s.playing < s.maxPlayers));
    cursor = d?.nextPageCursor;
    if (!cursor) break;
  }
  if (!servers.length) return '';
  return servers[Math.floor(Math.random() * servers.length)].id;
}

async function addRecentGame(placeId) {
  if (!placeId) return;
  let entry = recentGames.find(g => g.placeId === placeId);
  if (!entry) {
    entry = { placeId, name: `Place ${placeId}`, iconUrl: '' };
    try {
      const d = await anyValidClient().getPlaceDetails(placeId);
      if (d?.name) entry.name = d.name;
      entry.iconUrl = (await anyValidClient().getPlaceIcon(placeId)) || '';
    } catch { /* keep placeholder name */ }
  }
  recentGames = [entry, ...recentGames.filter(g => g.placeId !== placeId)].slice(0, settings.maxRecentGames);
  saveRecent();
  send('recent', recentGames);
}

async function joinWith(acc, opts) {
  const client = clientFor(acc);

  if (settings.closeLastOnLaunch) {
    const n = await launcher.closeClientsFor(acc.browserTrackerId).catch(() => 0);
    if (n) log(`${acc.username}: closed previous client`);
  }

  const launch = { browserTrackerId: acc.browserTrackerId };

  if (opts.followUser) {
    const userId = /^\d+$/.test(opts.followUser) ? Number(opts.followUser) : await client.getUserIdByName(opts.followUser);
    Object.assign(launch, { mode: 'follow', userId });
  } else {
    const t = parseTarget(opts.placeId, opts.jobId);
    if (!t) throw new Error('Enter a Place ID, or a private/VIP server link in the Job ID box');

    if (t.shareCode) {
      const r = await client.resolveShareLink(t.shareCode);
      t.placeId = r.placeId;
      t.linkCode = r.linkCode;
    }
    if (!t.placeId) throw new Error('Could not work out the place for that link');

    if (t.linkCode) {
      const accessCode = await client.resolvePrivateServerLink(t.placeId, t.linkCode);
      Object.assign(launch, { mode: 'private', placeId: t.placeId, accessCode, linkCode: t.linkCode });
    } else if (t.jobId) {
      Object.assign(launch, { mode: 'job', placeId: t.placeId, jobId: t.jobId });
    } else {
      // Place ID only -> a random public server (falls back to normal matchmaking).
      const jobId = await pickRandomServer(client, t.placeId).catch(() => '');
      Object.assign(launch, jobId ? { mode: 'job', placeId: t.placeId, jobId } : { mode: 'game', placeId: t.placeId });
    }
  }

  launch.ticket = await client.getAuthTicket();
  await launcher.launchUri(launcher.buildLaunchUri(launch));
  vault.update(acc.id, { lastUse: new Date().toISOString() });
  log(`${acc.username}: launching`);

  if (settings.labelWindows !== false) startWindowLabeler();
}

// Label each Roblox window with the exact account running it. The account is
// read from Roblox's own session log (userid), matched to the window by process
// start time, so it's correct no matter what order the games finished loading.
// Titles are re-applied because Roblox resets its own title while loading.
let windowLabelTimer = null;
let windowLabelMisses = 0;
function startWindowLabeler() {
  if (windowLabelTimer) return;
  windowLabelMisses = 0;
  windowLabelTimer = setInterval(async () => {
    try {
      if (settings.labelWindows === false) return;
      const wins = await launcher.getWindowAccounts(); // [{ hwnd, userid }]
      const apply = {};
      for (const w of wins) {
        const acc = vault.accounts.find(a => String(a.userId) === String(w.userid));
        if (acc) apply[w.hwnd] = acc.username;
      }
      if (Object.keys(apply).length) { await launcher.applyWindowTitles(apply); windowLabelMisses = 0; }
      else {
        // No matchable windows a few times in a row -> nothing to label, stop.
        const any = await launcher.listRobloxWindows().catch(() => []);
        if (!any.length && ++windowLabelMisses >= 3) { clearInterval(windowLabelTimer); windowLabelTimer = null; }
      }
    } catch { /* transient */ }
  }, 4000);
}

async function ensureMultiRoblox() {
  // The pill reflects whether the app actually OWNS the lock (multi will work),
  // not merely that it holds a handle.
  if (!settings.multiRoblox || launcher.isMultiRobloxEnabled()) { send('multiRoblox', launcher.isMultiRobloxOwned()); return; }
  const r = await launcher.enableMultiRoblox();
  if (!r.enabled) log('Multi-Roblox could not start. Close the old Roblox Account Manager if it is running, then reopen this app.', 'error');
  else if (!r.owned) log('Multi-Roblox: a Roblox client is already running, so the app could not take the lock first. Close ALL Roblox windows (or Quit this app from the tray and reopen it) — then it will grab the lock and you can launch multiple.', 'error');
  send('multiRoblox', launcher.isMultiRobloxOwned());
}

// If no Roblox is running, (re)grab the lock so the app OWNS it before launches.
async function grabLockIfClear() {
  if (!settings.multiRoblox) return;
  const procs = await launcher.listRobloxProcesses().catch(() => [{}]);
  if (procs.length === 0) {
    launcher.disableMultiRoblox();
    await new Promise(r => setTimeout(r, 300));
    await ensureMultiRoblox();
  }
}

// ---------- IPC ----------

function handle(channel, fn) {
  ipcMain.handle(channel, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      log(e.message, 'error');
      return { ok: false, error: e.message };
    }
  });
}

function registerIpc() {
  handle('init', () => {
    return {
      accounts: vault.accounts.map(publicAccount),
      settings,
      recent: recentGames,
      multiRoblox: launcher.isMultiRobloxOwned(),
      defaultRamFile: fs.existsSync(path.join(DEFAULT_RAM_DIR, 'AccountData.json')) ? path.join(DEFAULT_RAM_DIR, 'AccountData.json') : '',
      version: app.getVersion(),
    };
  });

  handle('settings:set', patch => {
    settings = { ...settings, ...patch };
    saveSettings();
    if ('presenceIntervalSec' in patch || 'showPresence' in patch || 'killClosedClients' in patch) restartTimers();
    if ('autoKeepAlive' in patch) syncScheduledTask();
    if ('runOnStartup' in patch || 'startMinimized' in patch) syncLoginItem();
    if ('multiRoblox' in patch) {
      if (patch.multiRoblox) ensureMultiRoblox();
      else { launcher.disableMultiRoblox(); send('multiRoblox', false); }
    }
    return settings;
  });

  handle('account:add', async () => {
    log('Log in to Roblox in the window that opened');
    const r = await browser.login(PROFILES_DIR);
    if (!r) return null;
    const acc = vault.upsert({
      userId: r.user.id,
      username: r.user.name,
      displayName: r.user.displayName,
      cookie: r.cookie,
      password: r.password,
      profileDir: r.profileDir,
      valid: true,
      cookieUpdatedAt: new Date().toISOString(),
      lastChecked: new Date().toISOString(),
    });
    log(`Added ${acc.username}`);
    pushAccounts();
    refreshAvatars();
    return publicAccount(acc);
  });

  handle('account:relogin', async id => {
    const acc = vault.get(id);
    log(`Log in as ${acc.username} in the window that opened`);
    const r = await browser.login(PROFILES_DIR, { username: acc.username, password: acc.password });
    if (!r) return null;
    if (r.user.id !== acc.userId) throw new Error(`You logged in as ${r.user.name}, not ${acc.username}. Nothing was changed.`);
    vault.update(id, { cookie: r.cookie, password: r.password || acc.password, profileDir: r.profileDir, valid: true, cookieUpdatedAt: new Date().toISOString(), lastChecked: new Date().toISOString() });
    log(`${acc.username}: logged in again`);
    pushAccounts();
    return true;
  });

  handle('account:browser', async (id, url) => {
    const acc = vault.get(id);
    if (!acc.profileDir) vault.update(id, { profileDir: path.join(PROFILES_DIR, acc.id) });
    await browser.openAccount(acc, acc.profileDir, cookie => {
      vault.update(id, { cookie, cookieUpdatedAt: new Date().toISOString() });
      log(`${acc.username}: saved refreshed cookie from browser`);
    }, url);
  });

  handle('account:update', (id, patch) => {
    const allowed = ['alias', 'description', 'group'];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    vault.update(id, clean);
    pushAccounts();
  });

  handle('account:updateMany', (ids, patch) => {
    const allowed = ['alias', 'description', 'group'];
    const clean = Object.fromEntries(Object.entries(patch).filter(([k]) => allowed.includes(k)));
    for (const id of ids) vault.update(id, clean);
    pushAccounts();
  });

  async function addOneCookie(raw) {
    const cookie = String(raw || '').trim().replace(/^\.ROBLOSECURITY=/, '');
    if (!cookie) return { ok: false, error: 'empty' };
    const user = await new RobloxClient(cookie).getAuthenticatedUser().catch(() => null);
    if (!user?.id) return { ok: false, error: 'invalid or expired' };
    const acc = vault.upsert({
      userId: user.id, username: user.name, displayName: user.displayName, cookie, valid: true,
      cookieUpdatedAt: new Date().toISOString(), lastChecked: new Date().toISOString(),
    });
    return { ok: true, username: acc.username };
  }

  // Add one or many cookies, one per line.
  handle('account:addCookies', async text => {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) throw new Error('Paste at least one cookie');
    let added = 0;
    for (const line of lines) {
      const r = await addOneCookie(line);
      if (r.ok) { added++; log(`Added ${r.username}`); }
      else log(`Skipped a cookie (${r.error})`, 'error');
    }
    pushAccounts();
    refreshAvatars();
    return { added, total: lines.length };
  });

  // Open a login window per "user:pass" line (or blank line = manual login). Sequential.
  // Login windows tiled across the screen, several at once. Each slot is a
  // window position; a worker per slot keeps opening the next login as soon
  // as its window finishes.
  // Always 3 windows stacked per column, filled left-to-right, at the smallest
  // usable size. Concurrency is however many columns of 3 fit across the screen.
  const ROWS = 3;
  function loginSlots(count) {
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workArea;
    const W = 500;                                   // Chrome won't make a window narrower than ~500px; match it so tiles don't overlap
    const h = Math.floor(wa.height / ROWS);          // three per column, top to bottom
    const maxCols = Math.max(1, Math.floor(wa.width / W));
    const n = Math.min(count, maxCols * ROWS);
    return Array.from({ length: n }, (_, i) => {
      const col = Math.floor(i / ROWS), row = i % ROWS;
      return { x: wa.x + col * W, y: wa.y + row * h, w: W, h };
    });
  }

  handle('account:addLogins', async text => {
    const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
    const creds = lines.length ? lines : [''];
    const slots = creds.length > 1 ? loginSlots(creds.length) : [undefined]; // single login keeps the normal size
    let added = 0;
    let next = 0;
    if (creds.length > 1) log(`Opening ${Math.min(slots.length, creds.length)} login windows at a time. Do the "hold" check in each one.`);

    const worker = async slot => {
      // Desync the windows so several automated logins don't hit Roblox from one
      // IP at the exact same instant (a bot signal that can draw captchas).
      if (creds.length > 1) await new Promise(r => setTimeout(r, Math.floor(Math.random() * 1800)));
      while (next < creds.length) {
        const line = creds[next++];
        const idx = line.indexOf(':');
        const username = idx > -1 ? line.slice(0, idx) : line;
        const password = idx > -1 ? line.slice(idx + 1) : '';
        if (creds.length === 1) log(username ? `Logging in ${username}. Solve any check in the window.` : 'Log in in the window that opened');
        try {
          const r = await browser.login(PROFILES_DIR, { username, password, window: slot });
          if (!r) { log(`${username || 'Login'} window closed, skipped`); continue; }
          vault.upsert({
            userId: r.user.id, username: r.user.name, displayName: r.user.displayName,
            cookie: r.cookie, password: r.password, profileDir: r.profileDir, valid: true,
            cookieUpdatedAt: new Date().toISOString(), lastChecked: new Date().toISOString(),
          });
          added++;
          log(`Added ${r.user.name} (${added} of ${creds.length})`);
          pushAccounts();
        } catch (e) { log(`${username}: login failed: ${e.message}`, 'error'); }
      }
    };
    await Promise.all(slots.map(worker));
    refreshAvatars();
    return { added, total: creds.length };
  });

  handle('account:summary', async id => {
    const acc = vault.get(id);
    return clientFor(acc).getSummary(acc.userId);
  });

  handle('account:setDisplayName', async (ids, name) => {
    let ok = 0;
    for (const id of ids) {
      const acc = vault.get(id);
      try { await clientFor(acc).setDisplayName(acc.userId, name); vault.update(id, { displayName: name }); ok++; log(`${acc.username}: display name set`); }
      catch (e) { log(`${acc.username}: ${e.message}`, 'error'); }
    }
    pushAccounts();
    return ok;
  });

  handle('account:changePassword', async (ids, current, next) => {
    let ok = 0;
    for (const id of ids) {
      const acc = vault.get(id);
      // Blank "current" field means: use each account's saved password.
      const cur = current || acc.password;
      if (!cur) { log(`${acc.username}: no current password known, skipped`, 'error'); continue; }
      try {
        await clientFor(acc).changePassword(cur, next);
        vault.update(id, { password: next }); // Roblox rotates the cookie; the client already captured it.
        ok++;
        log(`${acc.username}: password changed`);
      } catch (e) { log(`${acc.username}: ${e.message}`, 'error'); }
    }
    pushAccounts();
    return ok;
  });

  handle('account:setJoinPrivacy', async (ids, value) => {
    for (const id of ids) {
      const acc = vault.get(id);
      try { await clientFor(acc).setJoinPrivacy(value); log(`${acc.username}: join privacy set to ${value}`); }
      catch (e) { log(`${acc.username}: ${e.message}`, 'error'); }
    }
    return true;
  });

  handle('place:info', async placeId => {
    const d = await anyValidClient().getPlaceDetails(Number(placeId));
    return d ? { name: d.name, builder: d.builder } : null;
  });

  // Work out the place (id + name) from whatever is in the Place ID / Job ID
  // boxes, resolving a share link or private/VIP link to its place.
  handle('place:resolve', async ({ placeId, jobId }) => {
    const client = anyValidClient();
    let id = 0;
    try {
      const t = parseTarget(placeId, jobId);
      if (t) {
        if (t.shareCode) id = (await client.resolveShareLink(t.shareCode)).placeId;
        else id = t.placeId;
      }
    } catch { /* bad/partial link -> no place yet */ }
    if (!id) return null;
    const d = await client.getPlaceDetails(id).catch(() => null);
    return { placeId: id, name: d?.name || `Place ${id}` };
  });

  handle('account:setPassword', (id, password) => {
    vault.update(id, { password });
    pushAccounts();
  });

  handle('account:remove', async (ids, doLogout = true) => {
    // Confirmation is handled by an in-app dialog in the renderer.
    for (const id of ids) {
      const acc = vault.get(id);
      if (!acc) continue;
      if (doLogout && acc.valid && acc.cookie) {
        try { await clientFor(acc).logout(); log(`${acc.username}: logged out`); }
        catch (e) { log(`${acc.username}: log out failed (${e.message})`, 'error'); }
      }
      // Clean up the leftover browser profile folder.
      const dir = acc.profileDir || path.join(PROFILES_DIR, acc.id);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      clients.delete(id);
      vault.remove(id);
      pushAccounts();
    }
    return true;
  });

  handle('account:reorder', ids => { vault.reorder(ids); pushAccounts(); });

  handle('account:copy', (id, what) => {
    const acc = vault.get(id);
    const value = {
      username: acc.username,
      password: acc.password,
      cookie: acc.cookie,
      userId: String(acc.userId),
      combo: acc.password ? `${acc.username}:${acc.password}` : '',
    }[what];
    if (!value) throw new Error(`No ${what === 'combo' ? 'password' : what} saved for ${acc.username}`);
    clipboard.writeText(value);
    return true;
  });

  // Copy a field from several accounts at once, one per line (e.g. user:pass combos).
  handle('account:copyMany', (ids, what) => {
    const lines = ids.map(id => {
      const acc = vault.get(id);
      if (!acc) return '';
      return { username: acc.username, password: acc.password, cookie: acc.cookie, userId: String(acc.userId), combo: acc.password ? `${acc.username}:${acc.password}` : '' }[what] || '';
    }).filter(Boolean);
    if (!lines.length) throw new Error('Nothing to copy');
    clipboard.writeText(lines.join('\n'));
    return lines.length;
  });

  handle('account:check', async ids => {
    for (const id of ids) {
      const acc = vault.get(id);
      if (acc) await checkAccount(acc);
      pushAccounts();
    }
  });

  handle('join', async ({ ids, placeId, jobId, followUser }) => {
    // Guard against an accidental second click while a batch is still launching.
    if (joinInProgress) { log('Already launching — ignoring the extra Join click.'); return; }
    joinInProgress = true;
    joinCancel = false;
    send('joining', true);
    try {
      await grabLockIfClear(); // own the lock first if nothing is running yet
      await ensureMultiRoblox();

      // Don't cancel a Roblox that's already running. If the app doesn't hold the
      // single-instance lock (a client started before the app grabbed it), a new
      // launch would hand off to that running client and close it. Refuse instead.
      if (!launcher.isMultiRobloxOwned()) {
        const running = await launcher.countRobloxClients().catch(() => 0);
        if (running > 0) {
          log('Not launching — a Roblox client is already running and the app doesn\'t hold the Multi-Roblox lock, so launching now would close your current game. Fully close Roblox (or Quit this app from the tray and reopen it) first, then Join again.', 'error');
          return;
        }
      }

      const accounts = ids.map(id => vault.get(id)).filter(Boolean);
      const max = Math.max(1, settings.maxActiveClients || 20);
      for (let i = 0; i < accounts.length; i++) {
        if (joinCancel) { log('Launch queue stopped.'); break; }
        // Cap how many Roblox clients run at once.
        for (let waited = 0; (await launcher.countRobloxClients().catch(() => 0)) >= max; waited += 1.5) {
          if (joinCancel) break;
          if (waited === 0) log(`Reached the ${max}-client limit — close a Roblox window to launch ${accounts[i].username}`);
          if (waited >= 120) { log(`Still at the ${max}-client limit after 2 min; stopping.`, 'error'); joinCancel = true; break; }
          await new Promise(r => setTimeout(r, 1500));
        }
        if (joinCancel) { log('Launch queue stopped.'); break; }
        try {
          await joinWith(accounts[i], { placeId, jobId, followUser });
        } catch (e) {
          log(`${accounts[i].username}: ${e.message}`, 'error');
          if (e.status === 401) { vault.update(accounts[i].id, { valid: false }); pushAccounts(); }
        }
        if (i < accounts.length - 1) {
          // Interruptible delay between accounts so Stop takes effect promptly.
          for (let t = 0; t < settings.joinDelaySec * 1000 && !joinCancel; t += 200) await new Promise(r => setTimeout(r, 200));
        }
      }
      pushAccounts();
      for (const delay of [4000, 9000, 15000]) setTimeout(pollPresence, delay);
    } finally {
      joinInProgress = false;
      send('joining', false);
    }
  });

  handle('servers', async ({ placeId, cursor }) => {
    const client = anyValidClient();
    const [page, details] = await Promise.all([
      client.getServers(Number(placeId), cursor || ''),
      cursor ? null : client.getPlaceDetails(Number(placeId)).catch(() => null),
    ]);
    return { ...page, name: details?.name };
  });

  handle('recent:remove', placeId => {
    recentGames = recentGames.filter(g => g.placeId !== placeId);
    saveRecent();
    return recentGames;
  });

  handle('import:pick', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Select RAM AccountData.json',
      defaultPath: DEFAULT_RAM_DIR,
      filters: [{ name: 'RAM account data', extensions: ['json', 'backup'] }],
      properties: ['openFile'],
    });
    return r.canceled ? '' : r.filePaths[0];
  });

  handle('import:ram', async (file, password) => {
    const list = await readRamFile(file, password || '');
    let added = 0;
    let updated = 0;
    for (const a of list) {
      const exists = a.userId && vault.findByUserId(a.userId);
      vault.upsert(a);
      exists ? updated++ : added++;
    }

    // Bring over RAM's recent games list and a few settings if they're next to it.
    const dir = path.dirname(file);
    const ramRecent = readJson(path.join(dir, 'RecentGames.json'), []);
    for (const g of ramRecent) {
      const d = g?.Details;
      if (d?.placeId && !recentGames.some(r => r.placeId === d.placeId)) recentGames.push({ placeId: d.placeId, name: d.name || `Place ${d.placeId}`, iconUrl: '' });
    }
    recentGames = recentGames.slice(0, settings.maxRecentGames);
    saveRecent();
    send('recent', recentGames);

    vault.saveNow();
    pushAccounts();
    log(`Imported ${added} new and updated ${updated} accounts from RAM. Checking which sessions still work...`);
    keepAlive(true).then(() => {
      const dead = vault.accounts.filter(a => !a.valid).length;
      log(dead ? `Done. ${dead} account(s) need "Log in again".` : 'Done. All sessions work.');
      refreshAvatars();
    });
    return { added, updated };
  });

  handle('open:repo', () => { shell.openExternal('https://github.com/Rickagon/RobloxAccountManagerV2'); });

  handle('open:external', url => {
    if (/^https:\/\/(www\.)?roblox\.com\//.test(url)) shell.openExternal(url);
  });

  handle('roblox:closeAll', async () => {
    joinCancel = true; // stop any launch queue in progress
    const out = await launcher.countRobloxClients().catch(() => 0);
    await new Promise(res => require('child_process').exec('taskkill /IM RobloxPlayerBeta.exe /F', () => res()));

    // Nothing is running now, so re-grab the single-instance lock: this is the
    // one-click way to fix Multi-Roblox when a client had taken the lock first.
    if (settings.multiRoblox) {
      launcher.disableMultiRoblox();
      // Wait for the clients to actually exit before claiming the lock.
      for (let i = 0; i < 12; i++) {
        if ((await launcher.listRobloxProcesses().catch(() => [{}])).length === 0) break;
        await new Promise(r => setTimeout(r, 250));
      }
      await ensureMultiRoblox();
      if (launcher.isMultiRobloxOwned()) log('Multi-Roblox lock re-claimed — you can launch multiple clients now.');
    }
    return out;
  });
}

// ---------- app lifecycle ----------

function createWindow() {
  // Give the app its own taskbar identity so Windows uses our icon, not electron.exe's.
  if (process.platform === 'win32') app.setAppUserModelId('com.ic3.robloxaccountmanager.v2');
  win = new BrowserWindow({
    width: 900,
    height: 480,
    minWidth: 820,
    minHeight: 420,
    show: !STARTED_HIDDEN, // launched at startup with --hidden: stay in the tray
    backgroundColor: '#0f1115',
    title: 'Roblox Account Manager',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.platform === 'win32') win.setIcon(path.join(__dirname, 'assets', 'icon.ico'));

  // Closing the window hides it to the tray instead of quitting, so the app
  // keeps holding the Multi-Roblox lock for the whole session. Real exit is
  // via the tray's Quit (or before-quit), which sets isQuitting first.
  win.on('close', e => {
    if (!isQuitting) { e.preventDefault(); win.hide(); }
  });
}

// Bring the window back from the tray (recreating it if it was destroyed).
function showWindow() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// Tray icon: the app lives here while the window is closed, so it can hold the
// Multi-Roblox lock in the background.
function buildTray() {
  if (tray) return;
  try {
    tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
  } catch { return; } // no tray (e.g. missing icon) -> app still runs
  tray.setToolTip('Roblox Account Manager');
  const menu = Menu.buildFromTemplate([
    { label: 'Open Roblox Account Manager', click: showWindow },
    { type: 'separator' },
    { label: 'Quit (releases Multi-Roblox lock)', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    if (argv.includes('--keepalive')) return; // app is already open, its own timer keeps sessions alive
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    fs.mkdirSync(PROFILES_DIR, { recursive: true });
    settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, {}) };
    recentGames = readJson(RECENT_FILE, []);
    vault = new Vault(DATA_DIR);
    vault.load();

    if (KEEPALIVE_MODE) {
      runKeepAliveMode();
      return;
    }

    markActive();
    syncScheduledTask();
    syncLoginItem();
    registerIpc();
    createWindow();
    buildTray();
    restartTimers();

    if (settings.multiRoblox) ensureMultiRoblox();
    win.webContents.once('did-finish-load', () => {
      pollPresence();
      keepAlive(false);
      if (vault.accounts.some(a => !a.avatarUrl)) refreshAvatars();
    });
  });

  app.on('before-quit', async () => {
    isQuitting = true; // let the window's close handler destroy it instead of hiding
    launcher.disableMultiRoblox();
    if (vault) vault.flush(); // only writes if there were unsaved changes -> avoids racing a reopen's read
    await browser.closeAll();
  });

  // The window normally hides to the tray (not destroyed), so this only fires on
  // a real quit. Stay alive in the tray otherwise so the lock keeps being held.
  app.on('window-all-closed', () => { if (isQuitting) app.quit(); });
}
