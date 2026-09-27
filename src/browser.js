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
// (the app stores passwords itself) and mark the last session as clean so the
// "Chrome didn't shut down correctly / Restore pages?" bubble never appears.
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
  const args = [`--window-size=${win.w || 900},${win.h || 760}`, '--no-first-run', '--no-default-browser-check', '--disable-save-password-bubble', '--test-type', '--disable-session-crashed-bubble', '--hide-crash-restore-bubble'];
  if (win.x != null && win.y != null) args.push(`--window-position=${win.x},${win.y}`);
  const opts = {
    headless: false,
    viewport: null,
    args,
    // Drop --enable-automation (the "controlled by automated software" banner)
    // and --no-sandbox (the yellow "unsupported command-line flag" warning).
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
async function login(profilesRoot, { username = '', password = '', window: win } = {}) {
  const profileDir = path.join(profilesRoot, crypto.randomUUID());
  const ctx = await launch(profileDir, win);
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
    // Robustly fill: wait for each field, set it, and verify it stuck (retry once).
    const fillField = async (sel, value) => {
      try {
        const el = await page.waitForSelector(sel, { timeout: 15000, state: 'visible' });
        for (let attempt = 0; attempt < 2; attempt++) {
          await el.click({ timeout: 5000 }).catch(() => {});
          await el.fill('');
          await el.type(value, { delay: 15 });
          if (await el.inputValue().catch(() => '') === value) return true;
        }
      } catch { /* field never appeared */ }
      return false;
    };
    try {
      await fillField('#login-username', username);
      if (password) {
        const ok = await fillField('#login-password', password);
        if (ok) await page.click('#login-button', { timeout: 5000 }).catch(() => {});
      }
    } catch { /* user can finish by hand */ }
  }

  return new Promise(resolve => {
    let done = false;
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
      try {
        const user = await new RobloxClient(cookie).getAuthenticatedUser();
        if (!user?.id) return;
        clearInterval(timer);
        const pw = capturedPassword || password;
        // Resolve BEFORE closing: ctx.close() fires the 'close' handler, whose
        // finish(null) would otherwise win the race and discard this login.
        finish({ cookie, password: pw, user, profileDir });
        await ctx.close().catch(() => {});
      } catch { /* cookie not fully valid yet (e.g. 2-step pending) */ }
    }, 1500);
  });
}

/**
 * Opens a logged-in browser for an account. Any cookie Roblox rotates inside
 * the browser is reported back through onCookie so the vault stays current.
 */
async function openAccount(account, profileDir, onCookie, url = 'https://www.roblox.com/home') {
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

module.exports = { login, openAccount, closeAll };
