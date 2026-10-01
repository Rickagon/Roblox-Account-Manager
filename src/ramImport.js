// Imports accounts from ic3w0lf's Roblox Account Manager (AccountData.json).
// RAM protects the file with Windows DPAPI (CurrentUser) plus a fixed entropy
// string, so it can be read without a password by the same Windows user.
//
// If the user set a RAM password, RAM instead encrypts the file with libsodium
// (see RAM's Cryptography.cs): the layout is
//   [RAMHeader 64 bytes][Salt 16][Nonce 24][SecretBox ciphertext]
// where the key = crypto_pwhash(Argon2i, Moderate = ops 6 / mem 128MiB, 32 bytes)
// over SHA-512(password), and the body is crypto_secretbox (XSalsa20-Poly1305).
// We reproduce that exactly to import password-locked files.

const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const sodium = require('libsodium-wrappers-sumo');

// "ROBLOX ACCOUNT MANAGER | :) | BROUGHT TO YOU BUY ic3w0lf" — from RAM's AccountManager.cs
const RAM_ENTROPY = Buffer.from('ROBLOX ACCOUNT MANAGER | :) | BROUGHT TO YOU BUY ic3w0lf', 'ascii');
// The exact RAMHeader byte array from RAM's Cryptography.cs — a password-locked
// file begins with these 64 bytes ("Roblox Account Manager created by ic3w0lf22 @ github.com .......").
const RAM_FULL_HEADER = Buffer.from([
  82, 111, 98, 108, 111, 120, 32, 65, 99, 99, 111, 117, 110, 116, 32, 77, 97, 110, 97, 103, 101, 114, 32,
  99, 114, 101, 97, 116, 101, 100, 32, 98, 121, 32, 105, 99, 51, 119, 48, 108, 102, 50, 50, 32, 64, 32,
  103, 105, 116, 104, 117, 98, 46, 99, 111, 109, 32, 46, 46, 46, 46, 46, 46, 46,
]);

// Decrypt a password-locked RAM file. Throws 'RAM_PASSWORD_WRONG' if the password
// (or anything else) doesn't authenticate.
async function sodiumDecrypt(raw, password) {
  await sodium.ready;
  const h = RAM_FULL_HEADER.length; // 64
  const salt = raw.subarray(h, h + 16);
  const nonce = raw.subarray(h + 16, h + 40);
  const cipher = raw.subarray(h + 40);
  // RAM hashes the password with crypto_hash (SHA-512) before Argon2 (AccountManager.cs).
  const pwInput = crypto.createHash('sha512').update(String(password), 'utf8').digest();
  let key;
  try {
    key = sodium.crypto_pwhash(
      32, new Uint8Array(pwInput), new Uint8Array(salt),
      6, 134217728, sodium.crypto_pwhash_ALG_ARGON2I13, // Moderate: ops 6, mem 128 MiB, Argon2i
    );
  } catch (e) {
    throw new Error(`Could not derive the key from the RAM password: ${e.message}`);
  }
  let plain;
  try {
    plain = sodium.crypto_secretbox_open_easy(new Uint8Array(cipher), new Uint8Array(nonce), key);
  } catch {
    throw new Error('RAM_PASSWORD_WRONG');
  }
  if (!plain) throw new Error('RAM_PASSWORD_WRONG');
  return Buffer.from(plain).toString('utf8');
}

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

/**
 * Reads a RAM AccountData.json and returns account objects in this app's shape.
 * If the file is password-locked, pass the RAM password; without it, throws
 * 'RAM_PASSWORD_REQUIRED' so the caller can prompt.
 */
async function readRamFile(filePath, password = '') {
  const raw = fs.readFileSync(filePath);
  let json;

  const isPasswordFile = raw.length >= RAM_FULL_HEADER.length
    && raw.subarray(0, RAM_FULL_HEADER.length).equals(RAM_FULL_HEADER);
  if (isPasswordFile) {
    if (!password) throw new Error('RAM_PASSWORD_REQUIRED');
    json = await sodiumDecrypt(raw, password);
  } else {
    const text = raw.toString('utf8').trimStart().replace(/^﻿/, '');
    if (text.startsWith('[')) json = text; // RAM with encryption turned off
    else json = await dpapiUnprotect(filePath);
  }

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
