// Starting Roblox clients: finding the player, building the roblox-player: URI,
// multi-instance, and closing an account's previous client.

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function ps(script, env = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { env: { ...process.env, ...env }, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim())) : resolve(stdout.trim())));
  });
}

/**
 * The command Windows runs for roblox-player: links. Respects Bloxstrap-style
 * launchers if the user installed one. Returns { exe, args } where args contains "%1".
 */
async function getPlayerHandler() {
  const out = await ps(`(Get-ItemProperty 'Registry::HKEY_CLASSES_ROOT\\roblox-player\\shell\\open\\command' -ErrorAction SilentlyContinue).'(default)'`);
  const m = out.match(/^"([^"]+)"\s*(.*)$/) || out.match(/^(\S+)\s*(.*)$/);
  if (m && fs.existsSync(m[1])) return { exe: m[1], args: m[2] || '%1' };

  // Fallback: newest RobloxPlayerBeta.exe in the standard install folder.
  const versions = path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'Versions');
  if (fs.existsSync(versions)) {
    const candidates = fs.readdirSync(versions)
      .map(d => path.join(versions, d, 'RobloxPlayerBeta.exe'))
      .filter(p => fs.existsSync(p))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    if (candidates[0]) return { exe: candidates[0], args: '%1' };
  }
  throw new Error('Roblox is not installed (no roblox-player handler found). Install Roblox from roblox.com first.');
}

/**
 * @param {object} o
 * @param {string} o.ticket authentication ticket
 * @param {string} o.browserTrackerId per-account id, lets us find this account's client later
 * @param {'game'|'job'|'follow'|'private'|'app'} o.mode
 * @param {number} [o.placeId]
 * @param {string} [o.jobId]
 * @param {number} [o.userId] user to follow
 * @param {string} [o.accessCode]
 * @param {string} [o.linkCode]
 */
function buildLaunchUri(o) {
  const base = 'https://www.roblox.com/Game/PlaceLauncher.ashx?';
  let launcherUrl = '';
  if (o.mode === 'follow') {
    launcherUrl = `${base}request=RequestFollowUser&userId=${o.userId}`;
  } else if (o.mode === 'private') {
    launcherUrl = `${base}request=RequestPrivateGame&placeId=${o.placeId}&accessCode=${o.accessCode}&linkCode=${o.linkCode || ''}`;
  } else if (o.mode === 'job') {
    launcherUrl = `${base}request=RequestGameJob&browserTrackerId=${o.browserTrackerId}&placeId=${o.placeId}&gameId=${o.jobId}&isPlayTogetherGame=false`;
  } else if (o.mode === 'game') {
    launcherUrl = `${base}request=RequestGame&browserTrackerId=${o.browserTrackerId}&placeId=${o.placeId}&isPlayTogetherGame=false`;
  }

  const parts = [
    'roblox-player:1',
    `launchmode:${o.mode === 'app' ? 'app' : 'play'}`,
    `gameinfo:${o.ticket}`,
    `launchtime:${Date.now()}`,
  ];
  if (launcherUrl) parts.push(`placelauncherurl:${encodeURIComponent(launcherUrl)}`);
  parts.push(`browsertrackerid:${o.browserTrackerId}`, 'robloxLocale:en_us', 'gameLocale:en_us', 'channel:', 'LaunchExp:InApp');
  return parts.join('+');
}

async function launchUri(uri) {
  const { exe, args } = await getPlayerHandler();
  // Registry args look like `"%1"` or `--player "%1"`; swap the placeholder for our URI.
  const tokens = (args.match(/"[^"]*"|\S+/g) || ['%1']).map(t => t.replace(/^"|"$/g, ''));
  if (!tokens.some(t => t.includes('%1'))) tokens.push('%1');
  const argv = tokens.map(t => t.replace('%1', uri));
  const child = spawn(exe, argv, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', e => console.error('Failed to start Roblox:', e.message));
  child.unref();
}

/** Kills Roblox clients that were started for this browserTrackerId. */
async function closeClientsFor(browserTrackerId) {
  const out = await ps(`
Get-CimInstance Win32_Process -Filter "Name='RobloxPlayerBeta.exe'" |
  Where-Object { $_.CommandLine -match ('(-b\\s+|browsertrackerid[:=])' + $env:TRACKER + '\\b') } |
  ForEach-Object { $_.ProcessId }`, { TRACKER: String(browserTrackerId) });
  const pids = out.split(/\s+/).filter(Boolean).map(Number);
  for (const pid of pids) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
  if (pids.length) await new Promise(r => setTimeout(r, 750)); // let Roblox drop the session
  return pids.length;
}

async function countRobloxClients() {
  // Count only clients that actually have a window. A Roblox process lingers for
  // a while after you close its window, so counting all of them would keep the
  // limit "full" long after you've closed clients.
  const out = await ps(`$ProgressPreference='SilentlyContinue'; @(Get-Process RobloxPlayerBeta -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count`);
  const m = String(out).match(/\d+/);
  return m ? Number(m[0]) : 0;
}

/**
 * Force-kill Roblox clients whose window is gone but whose process is still
 * running (what happens when you X out and Roblox fails to exit). Spares clients
 * younger than minAgeSec so ones still loading (no window yet) aren't killed.
 * Returns how many it killed.
 */
async function killWindowlessClients(minAgeSec = 40) {
  const out = await ps(`
$ProgressPreference='SilentlyContinue'
$killed = 0
Get-CimInstance Win32_Process -Filter "Name='RobloxPlayerBeta.exe'" | ForEach-Object {
  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  $age = ((Get-Date) - $_.CreationDate).TotalSeconds
  if ($p -and $p.MainWindowHandle -eq 0 -and $age -gt ${minAgeSec}) {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    $killed++
  }
}
[Console]::Out.Write($killed)`);
  const m = String(out).match(/\d+/);
  return m ? Number(m[0]) : 0;
}

/** Set the title-bar text of the Roblox window launched for this browserTrackerId. */
async function labelWindow(browserTrackerId, label) {
  await ps(`
$ProgressPreference='SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class RamWin { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string t); }
"@ -ErrorAction SilentlyContinue
$tid = $env:RAM_TID
Get-CimInstance Win32_Process -Filter "Name='RobloxPlayerBeta.exe'" | Where-Object { $_.CommandLine -match ('(-b\s+|browsertrackerid[:=])' + [regex]::Escape($tid) + '\b') } | ForEach-Object {
  $p = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  if ($p -and $p.MainWindowHandle -ne 0) { [RamWin]::SetWindowText($p.MainWindowHandle, $env:RAM_LABEL) | Out-Null }
}`, { RAM_TID: String(browserTrackerId), RAM_LABEL: String(label) });
}

// ---- Multi-Roblox ----
// Roblox refuses to start a second client while "ROBLOX_singletonMutex" is
// held by another Roblox. Grabbing it ourselves first makes every client
// believe it's the only one. Nothing is injected into Roblox.

let mutexHolder = null;

function enableMultiRoblox() {
  if (mutexHolder) return Promise.resolve({ enabled: true, owned: true });
  const script = `
$created = $false
$m = [System.Threading.Mutex]::new($true, 'ROBLOX_singletonMutex', [ref]$created)
if ($created) { [Console]::Out.WriteLine('OWNED') } else { [Console]::Out.WriteLine('EXISTS') }
[Console]::Out.Flush()
[void][Console]::In.ReadLine()
$m.ReleaseMutex()
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
  mutexHolder = child;
  child.on('exit', () => { if (mutexHolder === child) mutexHolder = null; });

  return new Promise(resolve => {
    child.stdout.once('data', buf => {
      const owned = buf.toString().includes('OWNED');
      if (!owned) disableMultiRoblox();
      resolve({ enabled: owned, owned });
    });
  });
}

function disableMultiRoblox() {
  if (!mutexHolder) return;
  const child = mutexHolder;
  mutexHolder = null;
  try { child.stdin.end('\n'); } catch { /* ignore */ }
  setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 1000);
}

function isMultiRobloxEnabled() {
  return !!mutexHolder;
}

module.exports = {
  getPlayerHandler,
  buildLaunchUri,
  launchUri,
  closeClientsFor,
  countRobloxClients,
  killWindowlessClients,
  labelWindow,
  enableMultiRoblox,
  disableMultiRoblox,
  isMultiRobloxEnabled,
};
