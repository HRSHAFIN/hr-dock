'use strict';
/**
 * HR Dock — preload bridge.
 *
 * The renderer runs with contextIsolation on and no Node integration. This is
 * the entire surface it can reach: a fixed set of typed calls, plus a small
 * event bus. Nothing here forwards arbitrary IPC channels or file paths.
 */
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = [
  'reminder:fired',
  'system:sample',
  'system:resume',
  'settings:changed',
  'state:changed',
  'data:replaced',
  'theme:changed'
];

const listeners = new Map();
for (const channel of EVENTS) {
  listeners.set(channel, new Set());
  ipcRenderer.on(channel, (_e, payload) => {
    for (const fn of listeners.get(channel)) {
      try { fn(payload); } catch (err) { console.error(`[bridge] ${channel} handler failed`, err); }
    }
  });
}

const api = {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  data: {
    get: () => ipcRenderer.invoke('data:get'),
    set: (key, value) => ipcRenderer.invoke('data:set', { key, value }),
    backup: () => ipcRenderer.invoke('data:backup'),
    backups: () => ipcRenderer.invoke('data:backups'),
    export: () => ipcRenderer.invoke('data:export'),
    import: filePath => ipcRenderer.invoke('data:import', filePath || null),
    reveal: () => ipcRenderer.invoke('data:reveal')
  },

  settings: {
    patch: patch => ipcRenderer.invoke('settings:patch', patch)
  },

  window: {
    command: (command, payload) => ipcRenderer.invoke('window:command', { command, payload }),
    state: () => ipcRenderer.invoke('window:state'),
    hide: () => ipcRenderer.invoke('window:command', { command: 'hide' }),
    quit: () => ipcRenderer.invoke('window:command', { command: 'quit' }),
    toggleCompact: () => ipcRenderer.invoke('window:command', { command: 'toggleCompact' }),
    setBounds: bounds => ipcRenderer.invoke('window:command', { command: 'setBounds', payload: bounds })
  },

  weather: {
    get: opts => ipcRenderer.invoke('weather:get', opts || {}),
    search: query => ipcRenderer.invoke('weather:search', query),
    detect: () => ipcRenderer.invoke('weather:detect')
  },

  system: {
    watch: on => ipcRenderer.invoke('system:watch', !!on)
  },

  reminders: {
    snooze: (reminder, minutes) => ipcRenderer.invoke('reminder:snooze', { reminder, minutes }),
    dismiss: key => ipcRenderer.invoke('reminder:dismiss', key),
    test: () => ipcRenderer.invoke('reminder:test')
  },

  autostart: {
    set: enabled => ipcRenderer.invoke('autostart:set', !!enabled)
  },

  openExternal: url => ipcRenderer.invoke('shell:open', url),

  /** Subscribe to a main-process event. Returns an unsubscribe function. */
  on(channel, handler) {
    const set = listeners.get(channel);
    if (!set) throw new Error(`unknown channel: ${channel}`);
    set.add(handler);
    return () => set.delete(handler);
  }
};

contextBridge.exposeInMainWorld('hrdock', api);
