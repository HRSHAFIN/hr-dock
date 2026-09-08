'use strict';
/**
 * HR Dock — local data store.
 * Single JSON document, atomic writes, debounced flushes, rolling backups.
 * Everything stays on disk in the user's roaming app-data folder; nothing is
 * uploaded anywhere except the (optional, anonymous) weather request.
 */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEBOUNCE_MS = 600;
const MAX_BACKUPS = 10;

const DEFAULTS = {
  version: 1,
  settings: {
    theme: 'auto',                 // dark | light | auto
    accent: '#5b8cff',
    timeFormat: 24,                // 12 | 24
    showSeconds: true,
    firstDayOfWeek: 1,             // 0 = Sunday, 1 = Monday
    opacity: 1,
    compact: false,
    alwaysOnTop: true,
    clickThrough: false,
    autostart: false,
    startMinimised: false,
    surface: 'auto',               // auto | acrylic | glass  (window backdrop)
    lastTab: 'today',
    onboarded: false,
    weather: {
      unit: 'c',                   // c | f
      detailed: true,
      auto: true,
      place: null,                 // { name, country, lat, lon }
      refreshMinutes: 30,
      expanded: false
    },
    notifications: {
      enabled: true,
      sound: true,
      silent: false,
      defaultLeadMinutes: 10,
      snoozeMinutes: 10
    },
    system: { enabled: true },
    modules: { weather: true, schedule: true, todos: true, notes: true, system: true }
  },
  bounds: null,                    // { x, y, width, height } of the expanded widget
  compactBounds: null,
  events: [],
  routines: [],
  todos: [],
  notes: [],
  stats: {
    completions: {},               // 'YYYY-MM-DD' -> number of tasks completed
    focus: {},                     // 'YYYY-MM-DD' -> focused seconds
    streak: { current: 0, best: 0, last: null }
  }
};

function deepMerge(base, patch) {
  if (Array.isArray(base) || Array.isArray(patch)) return patch === undefined ? base : patch;
  if (typeof base !== 'object' || base === null) return patch === undefined ? base : patch;
  if (typeof patch !== 'object' || patch === null) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const key of Object.keys(patch)) out[key] = deepMerge(base[key], patch[key]);
  return out;
}

class Store {
  constructor() {
    this.dir = app.getPath('userData');
    this.file = path.join(this.dir, 'hrdock-data.json');
    this.backupDir = path.join(this.dir, 'backups');
    this.data = DEFAULTS;
    this._timer = null;
    this._writing = false;
    this._dirty = false;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.data = deepMerge(DEFAULTS, JSON.parse(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Corrupt file: keep a copy so nothing is silently destroyed.
        try {
          fs.mkdirSync(this.backupDir, { recursive: true });
          fs.copyFileSync(this.file, path.join(this.backupDir, `corrupt-${Date.now()}.json`));
        } catch (_) { /* best effort */ }
        console.error('[store] unreadable data file, starting fresh:', err.message);
      }
      this.data = JSON.parse(JSON.stringify(DEFAULTS));
    }
    return this.data;
  }

  /** Queue a debounced write. Cheap to call on every keystroke. */
  save() {
    this._dirty = true;
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, DEBOUNCE_MS);
    if (this._timer.unref) this._timer.unref();
  }

  /** Write immediately (used on quit and before backups/exports). */
  flush() {
    if (!this._dirty || this._writing) return;
    this._writing = true;
    this._dirty = false;
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data), 'utf8');
      fs.renameSync(tmp, this.file);           // atomic on the same volume
    } catch (err) {
      console.error('[store] write failed:', err.message);
      this._dirty = true;
    } finally {
      this._writing = false;
    }
  }

  get(key) { return key ? this.data[key] : this.data; }

  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }

  patchSettings(patch) {
    this.data.settings = deepMerge(this.data.settings, patch);
    this.save();
    return this.data.settings;
  }

  replaceAll(next) {
    this.data = deepMerge(DEFAULTS, next);
    this._dirty = true;
    this.flush();
    return this.data;
  }

  backup() {
    this.flush();
    fs.mkdirSync(this.backupDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.backupDir, `hrdock-${stamp}.json`);
    fs.writeFileSync(target, JSON.stringify(this.data, null, 2), 'utf8');
    this.pruneBackups();
    return target;
  }

  pruneBackups() {
    try {
      const files = fs.readdirSync(this.backupDir)
        .filter(f => f.startsWith('hrdock-') && f.endsWith('.json'))
        .sort();
      while (files.length > MAX_BACKUPS) {
        fs.unlinkSync(path.join(this.backupDir, files.shift()));
      }
    } catch (_) { /* best effort */ }
  }

  listBackups() {
    try {
      return fs.readdirSync(this.backupDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const full = path.join(this.backupDir, f);
          const st = fs.statSync(full);
          return { name: f, path: full, size: st.size, mtime: st.mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch (_) { return []; }
  }
}

module.exports = { Store, DEFAULTS };
