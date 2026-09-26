// Imports accounts from ic3w0lf's Roblox Account Manager (AccountData.json).
// RAM protects the file with Windows DPAPI (CurrentUser) plus a fixed entropy
// string, so it can be read without a password by the same Windows user.

const fs = require('fs');
const { execFile } = require('child_process');

// "ROBLOX ACCOUNT MANAGER | :) | BROUGHT TO YOU BUY ic3w0lf" — from RAM's AccountManager.cs
const RAM_ENTROPY = Buffer.from('ROBLOX ACCOUNT MANAGER | :) | BROUGHT TO YOU BUY ic3w0lf', 'ascii');
// Files encrypted with a RAM password start with this header instead of a DPAPI blob.
const RAM_PASSWORD_HEADER = Buffer.from('Roblox Account', 'ascii');

function dpapiUnprotect(filePath) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$b = [IO.File]::ReadAllBytes($env:RAM_FILE)
$e = [Convert]::FromBase64String($env:RAM_ENTROPY)
try { $p = [Security.Cryptography.ProtectedData]::Unprotect($b, $e, 'CurrentUser') }
catch { $p = [Security.Cryptography.ProtectedData]::Unprotect($b, $e, 'LocalMachine') }
[Console]::Out.Write([Convert]::ToBase64String($p))
`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      {
        env: { ...process.env, RAM_FILE: filePath, RAM_ENTROPY: RAM_ENTROPY.toString('base64') },
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(`Could not decrypt the RAM file: ${(stderr || err.message).trim()}`));
        resolve(Buffer.from(stdout.trim(), 'base64').toString('utf8'));
      },
    );
  });
}

/** Reads a RAM AccountData.json and returns account objects in this app's shape. */
async function readRamFile(filePath) {
  const raw = fs.readFileSync(filePath);
  let json;

  if (raw.subarray(0, RAM_PASSWORD_HEADER.length).equals(RAM_PASSWORD_HEADER)) {
    throw new Error('This RAM file is locked with a RAM password. Open RAM, remove the password in its settings, then import again.');
  }

  const text = raw.toString('utf8').trimStart().replace(/^﻿/, '');
  if (text.startsWith('[')) json = text; // RAM with encryption turned off
  else json = await dpapiUnprotect(filePath);

  const list = JSON.parse(json);
  if (!Array.isArray(list)) throw new Error('Unexpected RAM file format');

  return list
    .filter(a => a && a.SecurityToken)
    .map(a => ({
      userId: Number(a.UserID) || 0,
      username: a.Username || '',
      cookie: a.SecurityToken,
      password: a.Password || '',
      alias: a.Alias || '',
      description: a.Description || '',
      group: a.Group || 'Default',
      fields: a.Fields || {},
      browserTrackerId: a.BrowserTrackerID || undefined,
      lastUse: a.LastUse || null,
      valid: a.Valid !== false,
      importedFromRam: true,
    }));
}

module.exports = { readRamFile };
