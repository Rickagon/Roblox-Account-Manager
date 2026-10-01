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
/** All RobloxPlayerBeta processes -> [{ pid, hasWindow }]. */
async function listRobloxProcesses() {
  const out = await ps(`
$ProgressPreference='SilentlyContinue'
Get-Process RobloxPlayerBeta -ErrorAction SilentlyContinue | ForEach-Object { "{0}\`t{1}" -f $_.Id, ([int]($_.MainWindowHandle -ne 0)) }`);
  return String(out).split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const [pid, w] = l.split('\t');
    return { pid, hasWindow: w === '1' };
  });
}

/** Force-kill the given process ids. */
async function killProcesses(pids) {
  if (!pids || !pids.length) return;
  await ps(`Stop-Process -Id ${pids.map(Number).filter(Boolean).join(',')} -Force -ErrorAction SilentlyContinue`);
}

// Modern Roblox doesn't put an account id in the client process, so windows are
// matched to accounts by launch order instead: list the current game windows,
// and the app assigns each new one the next queued account name.

/** Visible top-level windows owned by RobloxPlayerBeta -> [{ hwnd, title }]. */
async function listRobloxWindows() {
  const out = await ps(`
$ProgressPreference='SilentlyContinue'
Add-Type @"
using System;using System.Text;using System.Runtime.InteropServices;
public class RamEnum {
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
 public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
}
"@ -ErrorAction SilentlyContinue
$lines = New-Object System.Collections.ArrayList
$cb = [RamEnum+EnumWindowsProc]{ param($h,$l)
  if ([RamEnum]::IsWindowVisible($h)) {
    $procId = 0
    [RamEnum]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'RobloxPlayerBeta') {
      $sb = New-Object System.Text.StringBuilder 256
      [RamEnum]::GetWindowText($h, $sb, 256) | Out-Null
      [void]$lines.Add(("{0}\`t{1}" -f ([Int64]$h), $sb.ToString()))
    }
  }
  return $true
}
[RamEnum]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
$lines -join "\`n"`);
  return String(out).split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.indexOf('\t');
    return i === -1 ? { hwnd: l, title: '' } : { hwnd: l.slice(0, i), title: l.slice(i + 1) };
  });
}

/** Apply { hwnd: title } to those windows in one call. */
async function applyWindowTitles(map) {
  if (!map || !Object.keys(map).length) return;
  await ps(`
$ProgressPreference='SilentlyContinue'
Add-Type @"
using System;using System.Runtime.InteropServices;
public class RamSet { [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool SetWindowText(IntPtr h, string t); }
"@ -ErrorAction SilentlyContinue
$m = $env:RAM_TITLES | ConvertFrom-Json
foreach ($prop in $m.PSObject.Properties) {
  [RamSet]::SetWindowText([IntPtr][Int64]$prop.Name, [string]$prop.Value) | Out-Null
}`, { RAM_TITLES: JSON.stringify(map) });
}

/**
 * Map each visible Roblox game window to the real Roblox userId of the account
 * running it, by matching the window's process start time to its session log
 * (whose GameJoinLoadTime line contains "userid:<id>"). Returns [{hwnd, userid}].
 * This is exact regardless of load order.
 */
async function getWindowAccounts() {
  const out = await ps(`
$ProgressPreference='SilentlyContinue'
Add-Type @"
using System;using System.Runtime.InteropServices;
public class RamWA {
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
 public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
}
"@ -ErrorAction SilentlyContinue

$wins = New-Object System.Collections.ArrayList
$cb = [RamWA+EnumWindowsProc]{ param($h,$l)
  if ([RamWA]::IsWindowVisible($h)) {
    $procId = 0
    [RamWA]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null
    $p = Get-Process -Id $procId -ErrorAction SilentlyContinue
    if ($p -and $p.ProcessName -eq 'RobloxPlayerBeta') { [void]$wins.Add([pscustomobject]@{ hwnd=[Int64]$h; procId=$procId }) }
  }
  return $true
}
[RamWA]::EnumWindows($cb, [IntPtr]::Zero) | Out-Null
if ($wins.Count -eq 0) { return }

$create = @{}
Get-CimInstance Win32_Process -Filter "Name='RobloxPlayerBeta.exe'" | ForEach-Object {
  $create[[int]$_.ProcessId] = [datetimeoffset]($_.CreationDate.ToUniversalTime())
}

$logdir = Join-Path $env:LOCALAPPDATA 'Roblox\\logs'
$logs = New-Object System.Collections.ArrayList
Get-ChildItem $logdir -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 60 | ForEach-Object {
  if ($_.Name -match '(\\d{8}T\\d{6}Z)') {
    try { $t = [datetimeoffset]::ParseExact($matches[1],'yyyyMMddTHHmmssZ',$null,[System.Globalization.DateTimeStyles]::AssumeUniversal) } catch { $t = [datetimeoffset]$_.CreationTimeUtc }
    $m = Select-String -Path $_.FullName -Pattern 'userid:(\\d+)' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($m) { [void]$logs.Add([pscustomobject]@{ time=$t; uid=$m.Matches[0].Groups[1].Value }) }
  }
}

$lines = New-Object System.Collections.ArrayList
foreach ($w in $wins) {
  $pc = $create[[int]$w.procId]
  if (-not $pc) { continue }
  $best = $null; $bestDiff = [double]::MaxValue
  foreach ($li in $logs) {
    $d = [math]::Abs(($li.time - $pc).TotalSeconds)
    if ($d -lt $bestDiff) { $bestDiff = $d; $best = $li }
  }
  if ($best -and $bestDiff -le 120) { [void]$lines.Add(("{0}\`t{1}" -f $w.hwnd, $best.uid)) }
}
$lines -join "\`n"`);
  return String(out).split('\n').map(l => l.trim()).filter(Boolean).map(l => {
    const i = l.indexOf('\t');
    return i === -1 ? null : { hwnd: l.slice(0, i), userid: l.slice(i + 1) };
  }).filter(Boolean);
}

// ---- Multi-Roblox ----
// Roblox refuses to start a second client while "ROBLOX_singletonMutex" is
// held by another Roblox. Grabbing it ourselves first makes every client
// believe it's the only one. Nothing is injected into Roblox.

let mutexHolder = null;
let mutexStopping = false;
let mutexOwned = false; // true only if WE created the lock (grabbed it before any Roblox)

// A background PowerShell process holds Roblox's single-instance handles for the
// whole session. It keeps a handle whether or not it created them, so even if a
// Roblox is already running (it owns them first) the handles stay alive once we
// hold them, letting extra clients launch.
function spawnHolder() {
  const script = `
$c1=$false; $c2=$false
$m = [System.Threading.Mutex]::new($true, 'ROBLOX_singletonMutex', [ref]$c1)
try { $e = [System.Threading.EventWaitHandle]::new($false, [System.Threading.EventResetMode]::AutoReset, 'ROBLOX_singletonEvent', [ref]$c2) } catch { }
if ($c1) { [Console]::Out.WriteLine('OWNED') } else { [Console]::Out.WriteLine('EXISTS') }
[Console]::Out.Flush()
[void][Console]::In.ReadLine()
try { $m.ReleaseMutex() } catch { }
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  });
}

function enableMultiRoblox() {
  if (mutexHolder) return Promise.resolve({ enabled: true, owned: mutexOwned });
  mutexStopping = false;
  const child = spawnHolder();
  mutexHolder = child;
  child.on('exit', () => {
    if (mutexHolder !== child) return;
    mutexHolder = null;
    mutexOwned = false;
    // Persistent: if it dies unexpectedly, grab the lock again.
    if (!mutexStopping) setTimeout(() => { if (!mutexHolder && !mutexStopping) enableMultiRoblox(); }, 1000);
  });
  return new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    child.stdout.once('data', buf => { mutexOwned = buf.toString().includes('OWNED'); finish({ enabled: true, owned: mutexOwned }); });
    child.on('exit', () => finish({ enabled: false, owned: false }));
    setTimeout(() => finish({ enabled: !!mutexHolder, owned: mutexOwned }), 4000);
  });
}

function disableMultiRoblox() {
  if (!mutexHolder) return;
  mutexStopping = true;
  mutexOwned = false;
  const child = mutexHolder;
  mutexHolder = null;
  try { child.stdin.end('\n'); } catch { /* ignore */ }
  setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 1000);
}

function isMultiRobloxEnabled() {
  return !!mutexHolder;
}

// True only when the app grabbed the single-instance lock BEFORE any Roblox
// started. When false, launching a new client while one is running would cancel
// the running one, so joins must be blocked.
function isMultiRobloxOwned() {
  return mutexOwned;
}

module.exports = {
  getPlayerHandler,
  buildLaunchUri,
  launchUri,
  closeClientsFor,
  countRobloxClients,
  listRobloxProcesses,
  killProcesses,
  listRobloxWindows,
  applyWindowTitles,
  getWindowAccounts,
  enableMultiRoblox,
  disableMultiRoblox,
  isMultiRobloxEnabled,
  isMultiRobloxOwned,
};
