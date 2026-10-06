// Anonymous usage reporting. Sends a small, non-identifying ping so the project
// can count installs/active use and version spread. It NEVER sends accounts,
// cookies, passwords, usernames, user IDs, or any game data - only the fields
// built in report() below. This is disclosed in the README.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Destination for pings - the /ping endpoint on the Discord bot's telemetry
// server (e.g. https://your-host:8787/ping). If empty, nothing is sent.
const TELEMETRY_URL = 'http://198.50.225.43:25570/ping';
// Shared secret - must match telemetry.key on the bot. Note: this app is open
// source, so this is not truly secret; it only deters casual spam.
const TELEMETRY_KEY = 'd6c10f03f920c7db19ceeee204b9c7f2';

// A random id generated once per install, stored next to the app's data. It is
// not tied to any Roblox account or to the machine's identity.
function installId(dir) {
  const f = path.join(dir, 'install-id.txt');
  try { const v = fs.readFileSync(f, 'utf8').trim(); if (v) return v; } catch { /* first run */ }
  const id = crypto.randomUUID();
  try { fs.writeFileSync(f, id); } catch { /* not fatal */ }
  return id;
}

function accountBucket(n) {
  if (!n) return '0';
  if (n <= 5) return '1-5';
  if (n <= 20) return '6-20';
  if (n <= 50) return '21-50';
  return '50+';
}

/**
 * Send one anonymous ping. Best-effort: any failure is swallowed so it can
 * never affect the app.
 * @param {string} dir  the app's data directory (for the install id)
 * @param {{version:string, accountCount:number}} info
 */
async function report(dir, { version, accountCount }) {
  if (!TELEMETRY_URL) return;
  const payload = {
    id: installId(dir),
    version,
    os: `${process.platform} ${os.release()}`,
    accounts: accountBucket(accountCount), // a bucket, never the real list or count-as-identifier
    at: new Date().toISOString(),
  };
  try {
    const isDiscord = /discord(app)?\.com\/api\/webhooks\//i.test(TELEMETRY_URL);
    const body = isDiscord
      ? JSON.stringify({ content: `install ${payload.id.slice(0, 8)} | v${payload.version} | ${payload.os} | accounts ${payload.accounts}` })
      : JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    if (TELEMETRY_KEY && !isDiscord) headers['x-ram-key'] = TELEMETRY_KEY;
    await fetch(TELEMETRY_URL, { method: 'POST', headers, body });
  } catch { /* best effort - never block the app */ }
}

module.exports = { report };
