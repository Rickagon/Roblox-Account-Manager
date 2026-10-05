// Windows DPAPI (CurrentUser) encryption via PowerShell. Unlike Electron's
// safeStorage, DPAPI is scoped to the Windows user, not the executable, so data
// written by the dev build and the packaged .exe are interchangeable.

const { execFileSync } = require('child_process');
const path = require('path');

// Extra entropy mixed into the protection (public - not a secret, just binds the
// blob to this app so unrelated DPAPI data can't be swapped in).
const ENTROPY_B64 = Buffer.from('RobloxAccountManagerV2 | vault | :)', 'utf8').toString('base64');

// Full path to powershell - PATH isn't always inherited in a packaged app.
const PWSH = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function ps(script, inputB64) {
  // Silence the progress stream so "Preparing modules…" can't leak into stdout.
  const full = `$ProgressPreference='SilentlyContinue';` + script;
  const encoded = Buffer.from(full, 'utf16le').toString('base64');
  const out = execFileSync(
    PWSH,
    ['-NoProfile', '-NonInteractive', '-NoLogo', '-ExecutionPolicy', 'Bypass', '-OutputFormat', 'Text', '-EncodedCommand', encoded],
    { input: inputB64, maxBuffer: 128 * 1024 * 1024, windowsHide: true },
  ).toString();
  // Keep only base64 characters, in case anything else slips onto stdout.
  return out.replace(/[^A-Za-z0-9+/=]/g, '');
}

/** Buffer (plaintext) -> Buffer (DPAPI ciphertext). */
function protect(buf) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$in=[Console]::In.ReadToEnd()
$b=[Convert]::FromBase64String($in)
$e=[Convert]::FromBase64String('${ENTROPY_B64}')
$p=[Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($p))`;
  return Buffer.from(ps(script, buf.toString('base64')), 'base64');
}

/** Buffer (DPAPI ciphertext) -> Buffer (plaintext). Throws if it can't decrypt. */
function unprotect(buf) {
  const script = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$in=[Console]::In.ReadToEnd()
$b=[Convert]::FromBase64String($in)
$e=[Convert]::FromBase64String('${ENTROPY_B64}')
$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$e,'CurrentUser')
[Console]::Out.Write([Convert]::ToBase64String($p))`;
  const out = ps(script, buf.toString('base64'));
  if (!out) throw new Error('DPAPI unprotect returned nothing');
  return Buffer.from(out, 'base64');
}

module.exports = { protect, unprotect };
