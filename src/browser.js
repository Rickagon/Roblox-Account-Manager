// Account browser windows. Drives the Chrome already installed on this PC
// (falls back to Edge) with the stealth plugin, one saved profile per account.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const { RobloxClient, COOKIE_NAME } = require('./roblox');

chromium.use(stealth);

const open = new Map(); // profileDir -> BrowserContext

// Prepare a profile before launch: turn off Chrome's "Save password?" prompt
// (the app stores passwords itself), mark the last session clean so no
// "Restore pages?" bubble, and pre-trust the roblox-player protocol from
// roblox.com so the "Open Roblox Game Client?" dialog never appears.
function disablePasswordPrompts(profileDir) {
  const dir = path.join(profileDir, 'Default');
  const file = path.join(dir, 'Preferences');
  let prefs = {};
  try { prefs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* new profile */ }
  prefs.credentials_enable_service = false;
  prefs.credentials_enable_autosignin = false;
  prefs.profile = {
    ...(prefs.profile || {}),
    password_manager_enabled: false,
    password_manager_leak_detection: false,
    exit_type: 'Normal',      // pretend last exit was clean -> no "Restore pages?" prompt
    exited_cleanly: true,
  };
  // Auto-allow the roblox-player protocol from Roblox's site (the "Open Roblox
  // Game Client?" confirmation) for these origins.
  const pairs = { ...((prefs.protocol_handler && prefs.protocol_handler.allowed_origin_protocol_pairs) || {}) };
  for (const origin of ['https://www.roblox.com', 'https://roblox.com']) {
    pairs[origin] = { ...(pairs[origin] || {}), 'roblox-player': true };
  }
  prefs.protocol_handler = { ...(prefs.protocol_handler || {}), allowed_origin_protocol_pairs: pairs };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(prefs));
  } catch { /* not fatal */ }
}

/**
 * @param {string} profileDir
 * @param {{x?:number,y?:number,w?:number,h?:number}} [win] optional window placement
 */
function launch(profileDir, win = {}) {
  // Cache the in-flight promise (not just the resolved context) so two quick
  // calls can't each spawn Chromium against the same profile folder, which is
  // what made browser windows reopen after being closed.
  const existing = open.get(profileDir);
  if (existing) return existing;

  fs.mkdirSync(profileDir, { recursive: true });
  disablePasswordPrompts(profileDir);
  // --test-type silences the "unsupported command-line flag" bar. (Dropping it
  // didn't change the captcha, so it's back for the cleaner window.)
  const args = [`--window-size=${win.w || 900},${win.h || 760}`, '--no-first-run', '--no-default-browser-check', '--disable-save-password-bubble', '--test-type', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble', '--disable-blink-features=AutomationControlled'];
  if (win.x != null && win.y != null) args.push(`--window-position=${win.x},${win.y}`);
  const opts = {
    headless: false,
    viewport: null,
    args,
    // Drop the flags that mark the browser as automated: --enable-automation (the
    // "controlled by automated software" banner + navigator.webdriver) and the
    // --no-sandbox warning bar.
    ignoreDefaultArgs: ['--enable-automation', '--no-sandbox'],
  };
  const p = (async () => {
    try {
      return await chromium.launchPersistentContext(profileDir, { ...opts, channel: 'chrome' });
    } catch {
      return await chromium.launchPersistentContext(profileDir, { ...opts, channel: 'msedge' });
    }
  })();
  open.set(profileDir, p);
  p.then(ctx => ctx.on('close', () => open.delete(profileDir)), () => open.delete(profileDir));
  return p;
}

async function readRobloxCookie(ctx) {
  try {
    const cookies = await ctx.cookies('https://www.roblox.com');
    return cookies.find(c => c.name === COOKIE_NAME)?.value || '';
  } catch {
    return ''; // context already closed
  }
}

function cookieParam(value) {
  return {
    name: COOKIE_NAME,
    value,
    domain: '.roblox.com',
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
    expires: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
  };
}

/**
 * Opens a login window. Resolves with { cookie, password, user, profileDir }
 * once the user has signed in, or null if they closed the window.
 */
async function loginAutomated(profilesRoot, { username = '', password = '', window: win } = {}) {
  // Reuse a PERSISTENT login profile (one per on-screen slot so parallel logins
  // don't lock the same folder). Keeping it means Arkose's device-reputation
  // cookies survive between logins, so the "device" builds trust and is served
  // solvable challenges instead of a cold, hardest-difficulty one every time.
  // The account itself gets its own fresh profile (profileDir below); the login
  // profile only exists to log in and carry Arkose's device trust.
  const slotKey = win && win.x != null ? `${win.x}_${win.y}` : 'main';
  const loginProfile = path.join(profilesRoot, `_login_${slotKey}`);
  const profileDir = path.join(profilesRoot, crypto.randomUUID()); // the account's own profile
  const ctx = await launch(loginProfile, win);
  // Start signed-out of Roblox, but KEEP Arkose/FunCaptcha cookies (device trust).
  try {
    const all = await ctx.cookies();
    const keep = all.filter(c => /arkose|funcaptcha/i.test(c.domain || ''));
    await ctx.clearCookies();
    if (keep.length) await ctx.addCookies(keep);
  } catch { /* fresh profile, nothing to clear */ }
  const page = ctx.pages()[0] || (await ctx.newPage());

  let capturedPassword = '';
  page.on('request', req => {
    try {
      const u = new URL(req.url());
      if (req.method() !== 'POST' || u.hostname !== 'auth.roblox.com' || !/\/(login|signup)$/.test(u.pathname)) return;
      const body = req.postDataJSON();
      if (body?.password) capturedPassword = body.password;
    } catch { /* not JSON */ }
  });

  const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
  const sleep = ms => page.waitForTimeout(ms);

  // Show only the login card: hide Roblox's nav/header/footer and background so
  // the small window is just the form. Re-applied on every navigation.
  const focusLoginCss = `
    #navigation-container, .rbx-navbar, #header, .age-bracket-label, footer, #footer-container,
    .game-cards, .content > *:not(#login-container):not(.login-container):not([class*="signup"]) { display:none !important; }
    body, #content, .content { background:#0f1115 !important; }
    #login-container, .login-container, [class*="signupLoginContainer"] { margin:0 auto !important; float:none !important; }
    body { overflow:hidden !important; }`;
  const applyCss = () => page.addStyleTag({ content: focusLoginCss }).catch(() => {});
  page.on('domcontentloaded', applyCss);

  await page.goto('https://www.roblox.com/login', { timeout: 120000 }).catch(() => {});
  await applyCss();

  if (username) {
    // Roblox's bot check (Arkose/FunCaptcha) triggers on robotic input - an
    // instant fill() (looks pasted/injected) and an immediate click. A MANUAL
    // login rarely gets a captcha because a person types with real keystrokes,
    // moves the mouse, and pauses. So mimic that: real mouse click to focus,
    // char-by-char typing with jittered delays, little pauses, and a human beat
    // before submitting. (We still verify the value stuck, since Roblox's React
    // form can wipe text typed too early, and fall back to fill() only as a last
    // resort so the account still goes through.)
    const valueOf = sel => page.$eval(sel, el => el.value).catch(() => '');

    // Paste the value in one shot (like Ctrl+V) instead of typing it. We focus
    // with a real mouse click, clear, then insertText - a single input event,
    // no per-key events.
    const pasteFill = async (sel, value) => {
      let el;
      try { el = await page.waitForSelector(sel, { timeout: 20000, state: 'visible' }); }
      catch { return false; }
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.click({ timeout: 4000, delay: rand(40, 120) }).catch(() => {}); // real mouse click
          await page.keyboard.press('Control+A').catch(() => {});
          await page.keyboard.press('Delete').catch(() => {});
          await page.keyboard.insertText(value); // paste-style: one input event
          await sleep(rand(120, 240));
          if ((await valueOf(sel)) === value) return true;
        } catch { /* field detached mid-render; retry */ }
        await sleep(rand(150, 320));
      }
      // Last resort so the login still proceeds.
      try {
        const el2 = await page.$(sel);
        if (el2) { await el2.fill(value); if ((await valueOf(sel)) === value) return true; }
      } catch { /* give up; user can finish by hand */ }
      return false;
    };

    // Let Arkose/FunCaptcha's session telemetry initialise on a quiet page before
    // we interact - touching the form the instant it loads looks scripted.
    await sleep(rand(1500, 3000));

    // A little mouse wander first - movement entropy a real user generates.
    try {
      await page.mouse.move(rand(60, 300), rand(80, 240));
      await sleep(rand(120, 300));
      await page.mouse.move(rand(220, 520), rand(200, 400));
    } catch { /* headful mouse not ready; not fatal */ }

    await pasteFill('#login-username', username);
    if (password) {
      await sleep(rand(300, 650)); // beat between fields
      await pasteFill('#login-password', password);
      // Submit only once both fields hold their values; pause first like a person.
      for (let i = 0; i < 4; i++) {
        const u = await valueOf('#login-username');
        const p = await valueOf('#login-password');
        if (u === username && p === password) {
          await sleep(rand(450, 950));
          await page.click('#login-button', { timeout: 5000, delay: rand(40, 120) }).catch(() => {});
          break;
        }
        if (u !== username) await pasteFill('#login-username', username);
        if (p !== password) await pasteFill('#login-password', password);
      }
    }
  }

  return new Promise(resolve => {
    let done = false;
    let tries = 0;
    const finish = result => {
      if (done) return;
      done = true;
      clearInterval(timer);
      resolve(result);
    };
    ctx.on('close', () => finish(null));

    const timer = setInterval(async () => {
      const cookie = await readRobloxCookie(ctx);
      if (!cookie) return;
      tries++;
      const pw = capturedPassword || password;
      try {
        const user = await new RobloxClient(cookie).getAuthenticatedUser();
        if (user?.id) {
          clearInterval(timer);
          // Resolve BEFORE closing: ctx.close() fires the 'close' handler, whose
          // finish(null) would otherwise win the race and discard this login.
          finish({ cookie, password: pw, user, profileDir });
          await ctx.close().catch(() => {});
          return;
        }
      } catch { /* cookie not fully valid yet (2-step pending, or account locked) */ }
      // After a few tries the cookie is set but /authenticated still fails - the
      // account is probably LOCKED (never reaches the home page). Identify it from
      // the logged-in page so it still gets added (flagged), not silently lost.
      if (tries >= 4) {
        const who = await identifyFromPage(ctx).catch(() => null);
        if (who?.id) {
          clearInterval(timer);
          finish({ cookie, password: pw, user: who, profileDir, locked: true });
          await ctx.close().catch(() => {});
        }
      }
    }, 1500);
  });
}

// Pull the signed-in user's id/name straight from the Roblox page (works even
// when the account is locked and the API's /authenticated call is refused).
async function identifyFromPage(ctx) {
  const page = ctx.pages()[0];
  if (!page) return null;
  const data = await page.evaluate(() => {
    try {
      const u = (window.Roblox && window.Roblox.CurrentUser) || {};
      const meta = document.querySelector('meta[name="user-data"]');
      const id = u.userId || (meta && meta.getAttribute('data-userid'));
      const name = u.name || u.userName || (meta && meta.getAttribute('data-name'));
      return id ? { id: Number(id), name: name || '' } : null;
    } catch { return null; }
  }).catch(() => null);
  if (!data?.id) return null;
  let displayName = data.name;
  if (!data.name) {
    try {
      const info = await new RobloxClient('').getUserById(data.id);
      data.name = info?.name || `User ${data.id}`;
      displayName = info?.displayName || data.name;
    } catch { data.name = `User ${data.id}`; }
  }
  return { id: data.id, name: data.name, displayName };
}

/**
 * Opens a logged-in browser for an account. Any cookie Roblox rotates inside
 * the browser is reported back through onCookie so the vault stays current.
 */
async function openAccount(account, profileDir, onCookie, url = 'https://www.roblox.com/home', sites = []) {
  const alreadyOpen = open.has(profileDir);
  const ctx = await launch(profileDir);

  if (alreadyOpen) {
    // Reuse the window that's already up: just navigate it, don't wire it twice.
    const page = ctx.pages()[0] || (await ctx.newPage());
    await page.bringToFront().catch(() => {});
    await page.goto(url, { timeout: 120000 }).catch(() => {});
    return;
  }

  await ctx.addCookies([cookieParam(account.cookie)]);
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(url, { timeout: 120000 }).catch(() => {});

  // Saved sites (Settings): open each one in its own tab, then return to the main tab.
  for (const site of sites) {
    try {
      const tab = await ctx.newPage();
      tab.goto(site, { timeout: 120000 }).catch(() => {});
    } catch { /* window closed meanwhile */ }
  }
  if (sites.length) await page.bringToFront().catch(() => {});

  let last = account.cookie;
  const sync = async () => {
    const c = await readRobloxCookie(ctx);
    if (c && c !== last) { last = c; onCookie(c); }
  };
  const timer = setInterval(sync, 20000);
  ctx.on('page', p => p.on('close', sync));
  page.on('close', sync);
  ctx.on('close', () => clearInterval(timer));
}

async function closeAll() {
  const ctxs = await Promise.all([...open.values()].map(p => Promise.resolve(p).catch(() => null)));
  await Promise.all(ctxs.filter(Boolean).map(c => c.close().catch(() => {})));
}

// ---------------------------------------------------------------------------
// Login in your REAL Chrome (no Playwright). Chrome is started as a normal
// program with its own profile folder. Nothing is attached to the page while
// the captcha runs: the app only talks to Chrome's browser-level debugging
// channel to read cookies (the page can't see that). It briefly attaches to the
// page only to type saved username/password and to catch the typed password.
// Falls back to the automated login if Chrome/Edge isn't installed.

function findChrome() {
  const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
  const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  return [
    path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(require('os').homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ].find(p => p && fs.existsSync(p)) || null;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = require('net').createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// Minimal Chrome DevTools Protocol client over a WebSocket.
function cdpConnect(wsUrl, onEvent = () => {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();
    ws.onopen = () => resolve({
      send(method, params = {}, sessionId) {
        return new Promise((res, rej) => {
          const i = ++id;
          pending.set(i, { res, rej });
          try { ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); }
          catch (e) { pending.delete(i); rej(e); }
        });
      },
      close() { try { ws.close(); } catch { /* ignore */ } },
    });
    ws.onerror = () => reject(new Error('Could not talk to Chrome'));
    ws.onmessage = m => {
      let d; try { d = JSON.parse(m.data); } catch { return; }
      if (d.id) {
        const p = pending.get(d.id);
        if (!p) return;
        pending.delete(d.id);
        d.error ? p.rej(new Error(d.error.message)) : p.res(d.result);
      } else onEvent(d);
    };
    ws.onclose = () => { for (const p of pending.values()) p.rej(new Error('closed')); pending.clear(); };
  });
}

async function login(profilesRoot, opts = {}) {
  const exe = findChrome();
  if (!exe) return loginAutomated(profilesRoot, opts);
  try {
    return await loginRealChrome(exe, profilesRoot, opts);
  } catch (e) {
    console.error('Real-Chrome login failed, using the built-in browser:', e.message);
    return loginAutomated(profilesRoot, opts);
  }
}

async function loginRealChrome(exe, profilesRoot, { username = '', password = '', window: win } = {}) {
  const { spawn } = require('child_process');
  // Persistent login profile per screen slot (keeps Arkose device trust, see loginAutomated).
  const slotKey = win && win.x != null ? `${win.x}_${win.y}` : 'main';
  const loginProfile = path.join(profilesRoot, `_chrome_login_${slotKey}`);
  const profileDir = path.join(profilesRoot, crypto.randomUUID()); // the account's own profile
  fs.mkdirSync(loginProfile, { recursive: true });
  disablePasswordPrompts(loginProfile);

  const port = await freePort();
  const args = [
    `--user-data-dir=${loginProfile}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run', '--no-default-browser-check',
    `--window-size=${win?.w || 900},${win?.h || 760}`,
    'about:blank',
  ];
  if (win?.x != null && win?.y != null) args.splice(-1, 0, `--window-position=${win.x},${win.y}`);
  const child = spawn(exe, args, { stdio: 'ignore', windowsHide: false });
  let exited = false;
  child.on('exit', () => { exited = true; });

  // Wait for Chrome's browser-level debugging endpoint.
  let wsUrl = '';
  for (let i = 0; i < 40 && !wsUrl && !exited; i++) {
    await new Promise(r => setTimeout(r, 400));
    try { wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()).webSocketDebuggerUrl; } catch { /* not up yet */ }
  }
  if (!wsUrl) { try { child.kill(); } catch { /* ignore */ } throw new Error('Chrome did not start'); }

  let capturedPassword = '';
  let pageSession = null;
  const c = await cdpConnect(wsUrl, ev => {
    // Catch the password typed into Roblox's login form (sent in the login request).
    if (ev.method === 'Network.requestWillBeSent') {
      const rq = ev.params.request;
      if (rq.method === 'POST' && /auth\.roblox\.com\/v\d\/(login|signup)/.test(rq.url) && rq.postData) {
        try { const b = JSON.parse(rq.postData); if (b?.password) capturedPassword = b.password; } catch { /* not JSON */ }
      }
    }
  });

  // Start signed-out of Roblox but keep Arkose/FunCaptcha cookies (device trust).
  try {
    const { cookies } = await c.send('Storage.getCookies');
    const keep = cookies.filter(k => /arkose|funcaptcha/i.test(k.domain || ''));
    await c.send('Storage.clearCookies');
    if (keep.length) await c.send('Storage.setCookies', { cookies: keep });
  } catch { /* fresh profile */ }

  // Open the login page in a new tab, then drop the blank start tab.
  const { targetInfos: before } = await c.send('Target.getTargets');
  const { targetId } = await c.send('Target.createTarget', { url: 'https://www.roblox.com/login' });
  for (const t of before) if (t.type === 'page') c.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});

  // Attach to the login tab only for password capture and (optionally) typing.
  try {
    const att = await c.send('Target.attachToTarget', { targetId, flatten: true });
    pageSession = att.sessionId;
    await c.send('Network.enable', {}, pageSession);
  } catch { pageSession = null; }

  if (username && pageSession) fillRealChrome(c, pageSession, username, password).catch(() => {});

  return new Promise(resolve => {
    let done = false;
    let tries = 0;
    const finish = async result => {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (result) {
        try { await c.send('Browser.close'); } catch { try { child.kill(); } catch { /* ignore */ } }
      }
      c.close();
      resolve(result);
    };
    child.on('exit', () => finish(null)); // user closed the window

    const timer = setInterval(async () => {
      if (done) return;
      let cookie = '';
      try {
        const { cookies } = await c.send('Storage.getCookies');
        cookie = cookies.find(k => k.name === COOKIE_NAME && /roblox\.com$/.test(k.domain))?.value || '';
      } catch { return; }
      if (!cookie) return;
      tries++;
      const pw = capturedPassword || password;
      try {
        const user = await new RobloxClient(cookie).getAuthenticatedUser();
        if (user?.id) return finish({ cookie, password: pw, user, profileDir });
      } catch { /* 2-step pending or locked */ }
      // Logged in but /authenticated refused: probably a locked account. Read the
      // user from the page (the captcha is already done by now).
      if (tries >= 4 && pageSession) {
        try {
          const r = await c.send('Runtime.evaluate', {
            expression: `(() => { const u = (window.Roblox && Roblox.CurrentUser) || {}; const m = document.querySelector('meta[name="user-data"]');
              const id = u.userId || (m && m.getAttribute('data-userid')); const name = u.name || u.userName || (m && m.getAttribute('data-name'));
              return id ? JSON.stringify({ id: Number(id), name: name || '' }) : ''; })()`,
            returnByValue: true,
          }, pageSession);
          const who = r?.result?.value ? JSON.parse(r.result.value) : null;
          if (who?.id) {
            if (!who.name) {
              try { const info = await new RobloxClient('').getUserById(who.id); who.name = info?.name || `User ${who.id}`; who.displayName = info?.displayName; } catch { who.name = `User ${who.id}`; }
            }
            finish({ cookie, password: pw, user: { id: who.id, name: who.name, displayName: who.displayName || who.name }, profileDir, locked: true });
          }
        } catch { /* page busy */ }
      }
    }, 1500);
  });
}

// Type saved credentials into the real-Chrome login tab (does not click Log In,
// so the actual submit is your own click).
async function fillRealChrome(c, session, username, password) {
  const val = async sel => {
    const r = await c.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})?.value ?? null`, returnByValue: true }, session);
    return r?.result?.value;
  };
  const put = async (sel, text) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const { root } = await c.send('DOM.getDocument', { depth: 1 }, session);
        const { nodeId } = await c.send('DOM.querySelector', { nodeId: root.nodeId, selector: sel }, session);
        if (nodeId) {
          await c.send('DOM.focus', { nodeId }, session);
          if ((await val(sel)) !== text) {
            await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }, session).catch(() => {});
            await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 }, session).catch(() => {});
            await c.send('Input.insertText', { text }, session);
          }
          await new Promise(r => setTimeout(r, 250));
          if ((await val(sel)) === text) return true;
        }
      } catch { /* page still loading */ }
      await new Promise(r => setTimeout(r, 800));
    }
    return false;
  };
  // Wait for the form to exist (up to ~20s).
  for (let i = 0; i < 25; i++) {
    try { if ((await val('#login-username')) !== null) break; } catch { /* loading */ }
    await new Promise(r => setTimeout(r, 800));
  }
  await new Promise(r => setTimeout(r, 1200)); // let React settle so it doesn't wipe the text
  await put('#login-username', username);
  if (password) await put('#login-password', password);
}

module.exports = { login, openAccount, closeAll };
