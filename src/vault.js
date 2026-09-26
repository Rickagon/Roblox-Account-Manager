// Encrypted account storage. Uses Electron safeStorage, which on Windows is
// DPAPI tied to the current Windows user (same protection RAM used).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { safeStorage } = require('electron');

class Vault {
  constructor(dir) {
    this.file = path.join(dir, 'accounts.dat');
    this.backup = this.file + '.bak';
    this.accounts = [];
    this._saveTimer = null;
  }

  load() {
    for (const f of [this.file, this.backup]) {
      if (!fs.existsSync(f)) continue;
      try {
        const json = safeStorage.decryptString(fs.readFileSync(f));
        this.accounts = JSON.parse(json);
        return;
      } catch (e) {
        console.error(`Failed to read ${f}:`, e.message);
      }
    }
    this.accounts = [];
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    const data = safeStorage.encryptString(JSON.stringify(this.accounts));
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, data);
    if (fs.existsSync(this.file)) fs.copyFileSync(this.file, this.backup);
    fs.renameSync(tmp, this.file);
  }

  /** Debounced save so cookie rotations during a batch don't hammer the disk. */
  save() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  get(id) {
    return this.accounts.find(a => a.id === id);
  }

  findByUserId(userId) {
    return this.accounts.find(a => a.userId === userId);
  }

  /** Adds or updates (matched by Roblox userId). Returns the stored account. */
  upsert(data) {
    let acc = data.userId ? this.findByUserId(data.userId) : null;
    if (acc) {
      for (const [k, v] of Object.entries(data)) {
        // Don't wipe user-entered info with empty values from a fresh login.
        if (v === undefined || v === '' || v === null) continue;
        acc[k] = v;
      }
    } else {
      acc = {
        id: crypto.randomUUID(),
        userId: 0,
        username: '',
        displayName: '',
        cookie: '',
        password: '',
        alias: '',
        description: '',
        group: 'Default',
        fields: {},
        browserTrackerId: randomTrackerId(),
        valid: true,
        lastUse: null,
        addedAt: new Date().toISOString(),
        cookieUpdatedAt: new Date().toISOString(),
        ...data,
      };
      this.accounts.push(acc);
    }
    this.save();
    return acc;
  }

  update(id, patch) {
    const acc = this.get(id);
    if (!acc) return null;
    Object.assign(acc, patch);
    this.save();
    return acc;
  }

  remove(id) {
    this.accounts = this.accounts.filter(a => a.id !== id);
    this.save();
  }

  reorder(ids) {
    const byId = new Map(this.accounts.map(a => [a.id, a]));
    const ordered = ids.map(id => byId.get(id)).filter(Boolean);
    const rest = this.accounts.filter(a => !ids.includes(a.id));
    this.accounts = [...ordered, ...rest];
    this.save();
  }
}

function randomTrackerId() {
  const r = (min, max) => Math.floor(Math.random() * (max - min)) + min;
  return `${r(100000, 175000)}${r(100000, 900000)}`;
}

module.exports = { Vault, randomTrackerId };
