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
    // Roblox's bot check (Arkose/FunCaptcha) triggers on robotic input — an
    // instant fill() (looks pasted/injected) and an immediate click. A MANUAL
    // login rarely gets a captcha because a person types with real keystrokes,
    // moves the mouse, and pauses. So mimic that: real mouse click to focus,
    // char-by-char typing with jittered delays, little pauses, and a human beat
    // before submitting. (We still verify the value stuck, since Roblox's React
    // form can wipe text typed too early, and fall back to fill() only as a last
    // resort so the account still goes through.)
    const valueOf = sel => page.$eval(sel, el => el.value).catch(() => '');
    const rand = (a, b) => a + Math.floor(Math.random() * (b - a));
    const sleep = ms => page.waitForTimeout(ms);

    const humanFill = async (sel, value) => {
      let el;
      try { el = await page.waitForSelector(sel, { timeout: 20000, state: 'visible' }); }
      catch { return false; }
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          await el.scrollIntoViewIfNeeded().catch(() => {});
          await el.click({ timeout: 4000, delay: rand(40, 120) }).catch(() => {}); // real mouse click
          // Clear anything there the way a person would.
          await page.keyboard.press('Control+A').catch(() => {});
          await page.keyboard.press('Delete').catch(() => {});
          for (const ch of value) {
            await page.keyboard.type(ch, { delay: rand(55, 165) }); // human-ish cadence
            if (Math.random() < 0.08) await sleep(rand(140, 340));  // occasional think-pause
          }
          await sleep(rand(120, 260));
          if ((await valueOf(sel)) === value) return true;
        } catch { /* field detached mid-render; retry */ }
        await sleep(rand(150, 350));
      }
      // Last resort so the login still proceeds (may draw a captcha).
      try {
        const el2 = await page.$(sel);
        if (el2) { await el2.fill(value); if ((await valueOf(sel)) === value) return true; }
      } catch { /* give up; user can finish by hand */ }
      return false;
    };

    // A little mouse wander first — movement entropy a real user generates.
    try {
      await page.mouse.move(rand(60, 300), rand(80, 240));
      await sleep(rand(80, 200));
      await page.mouse.move(rand(220, 520), rand(200, 400));
    } catch { /* headful mouse not ready; not fatal */ }

    await humanFill('#login-username', username);
    if (password) {
      await sleep(rand(250, 550)); // beat between fields, like tabbing/clicking down
      await humanFill('#login-password', password);
      // Submit only once both fields hold their values; pause first like a person.
      for (let i = 0; i < 4; i++) {
        const u = await valueOf('#login-username');
        const p = await valueOf('#login-password');
        if (u === username && p === password) {
          await sleep(rand(450, 950));
          await page.click('#login-button', { timeout: 5000, delay: rand(40, 120) }).catch(() => {});
          break;
        }
        if (u !== username) await humanFill('#login-username', username);
        if (p !== password) await humanFill('#login-password', password);
      }
    }
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
