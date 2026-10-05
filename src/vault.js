// Encrypted account storage. Uses Windows DPAPI (current user) directly, which
// is portable between the dev build and the packaged .exe. Files written by the
// older Electron safeStorage format are read once and migrated.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dpapi = require('./dpapi');
let safeStorage = null;
try { ({ safeStorage } = require('electron')); } catch { /* not in Electron (e.g. tests) */ }

// Synchronous sleep (no busy-wait) so load retries don't spin the CPU.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch { const end = Date.now() + ms; while (Date.now() < end) { /* fallback */ } }
}

class Vault {
  constructor(dir) {
    this.file = path.join(dir, 'accounts.dat');
    this.backup = this.file + '.bak';
    this.accounts = [];
    this._saveTimer = null;
    this.loadFailed = false;    // true if a file existed but could not be decrypted
    this._migrate = false;      // true if loaded from the old safeStorage format
    this._loadedNonEmpty = false; // true if this session loaded >=1 account (so emptying is a real user action)
  }

  // Does the file on disk currently decode to a non-empty account list?
  _diskHasAccounts() {
    for (const f of [this.file, this.backup]) {
      try {
        if (!fs.existsSync(f) || fs.statSync(f).size === 0) continue;
        const { json } = this._decode(fs.readFileSync(f));
        const arr = JSON.parse(json);
        if (Array.isArray(arr) && arr.length > 0) return true;
      } catch { /* unreadable -> treat as no */ }
    }
    return false;
  }

  _decode(buf) {
    // Preferred: DPAPI. Fallback: old Electron safeStorage format (then migrate).
    try {
      return { json: dpapi.unprotect(buf).toString('utf8'), old: false };
    } catch (e1) {
      if (safeStorage) {
        try { return { json: safeStorage.decryptString(buf), old: true }; }
        catch (e2) { /* fall through */ }
      }
      throw e1;
    }
  }

  _tryLoadOnce() {
    let hadFile = false;
    for (const f of [this.file, this.backup]) {
      if (!fs.existsSync(f) || fs.statSync(f).size === 0) continue;
      hadFile = true;
      try {
        const { json, old } = this._decode(fs.readFileSync(f));
        const parsed = JSON.parse(json);
        if (!Array.isArray(parsed)) throw new Error('not an array');
        this.accounts = parsed;
        // Backfill tracker ids for any older accounts missing one, so window
        // labelling and closing the previous client can match them.
        let backfilled = false;
        for (const a of this.accounts) if (a && !a.browserTrackerId) { a.browserTrackerId = randomTrackerId(); backfilled = true; }
        this.loadFailed = false;
        if (parsed.length > 0) this._loadedNonEmpty = true;
        if (old || backfilled) { this._migrate = true; this.saveNow(); } // re-write as DPAPI / persist tracker backfill
        return { ok: true, hadFile };
      } catch (e) {
        try { fs.appendFileSync(this.file + '.error.log', `[${new Date().toISOString()}] pid ${process.pid} ${f}: ${e.message}\n`); } catch { /* ignore */ }
      }
    }
    return { ok: false, hadFile };
  }

  load() {
    // Retry a few times: another instance closing may be mid-write, which is
    // transient. Never conclude "empty" from a single racy read.
    let hadFile = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      const r = this._tryLoadOnce();
      if (r.ok) return;
      hadFile = hadFile || r.hadFile;
      if (!r.hadFile) break;           // no file at all -> genuinely empty, don't wait
      sleepSync(200);                  // a file exists but wouldn't decode -> wait and retry
    }
    this.loadFailed = hadFile;         // a file exists but never decoded -> guard against wipe
    this.accounts = [];
  }

  saveNow() {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
    // Safety: never wipe. Only write an empty vault if this session actually
    // loaded accounts and the user removed them all - never because a load
    // failed or returned empty while good data still sits on disk.
    if (this.accounts.length === 0 && !this._loadedNonEmpty && this._diskHasAccounts()) {
      console.error('Refusing to overwrite existing accounts with an empty vault.');
      return;
    }
    const data = dpapi.protect(Buffer.from(JSON.stringify(this.accounts), 'utf8'));
    const tmp = `${this.file}.${process.pid}.tmp`;
    // Back up atomically first (tmp + rename) so a reader never sees a half-copied backup.
    if (this.accounts.length > 0 && fs.existsSync(this.file) && fs.statSync(this.file).size > 0) {
      const btmp = `${this.backup}.${process.pid}.tmp`;
      fs.copyFileSync(this.file, btmp);
      fs.renameSync(btmp, this.backup);
    }
    // Atomic replace of the main file.
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
    this._dirty = false;
  }

  /** Debounced save so cookie rotations during a batch don't hammer the disk. */
  save() {
    this._dirty = true;
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  /** Flush a pending save immediately (used on quit). No-op if nothing changed. */
  flush() {
    if (this._dirty || this._saveTimer) this.saveNow();
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
    // Every account needs a tracker id: it's how launched clients are matched
    // back to their account (window titles, closing the old client). RAM imports
    // can arrive without one, and `...data` above can override the default.
    if (!acc.browserTrackerId) acc.browserTrackerId = randomTrackerId();
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
