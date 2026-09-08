'use strict';
/**
 * HR Dock — main process.
 *
 * Owns the desktop widget window (frameless, always-visible, position-sticky),
 * the tray icon, autostart registration, the reminder engine, the weather
 * service and the system monitor. The renderer is sandboxed: it has no Node
 * access and no network access of its own, and talks to all of this through
 * the narrow contextBridge API in ../preload/preload.js.
 */
const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage,
  shell, dialog, globalShortcut, powerMonitor, nativeTheme
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Store } = require('./store.js');
const { WeatherService } = require('./weather.js');
const { SystemMonitor } = require('./system.js');
const { ReminderEngine } = require('./reminders.js');

const isDev = process.argv.includes('--dev');
const launchedAtStartup = process.argv.includes('--startup');

// Test affordances: run against a throwaway profile, and grab a PNG of the
// rendered widget. Both are inert in normal use.
const captureArg = process.argv.find(a => a.startsWith('--capture='));
const captureTarget = captureArg ? captureArg.slice('--capture='.length) : null;
if (process.env.HRDOCK_USER_DATA) app.setPath('userData', process.env.HRDOCK_USER_DATA);

const EXPANDED = { width: 480, height: 780, minWidth: 380, minHeight: 460 };
const COMPACT = { width: 340, height: 210, minWidth: 260, minHeight: 120 };
const SNAP_PX = 24;

let store = null;
let weather = null;
let monitor = null;
let reminders = null;
let win = null;
let tray = null;
let quitting = false;
let saveBoundsTimer = null;

// Smoother animation on the composited, transparent surface.
app.commandLine.appendSwitch('enable-gpu-rasterization');

/** Windows 11 (build >= 22000) supports native acrylic/mica backdrops. */
function isWin11() {
  if (process.platform !== 'win32') return false;
  const build = Number((os.release() || '').split('.')[2] || 0);
  return build >= 22000;
}

function resolveSurface() {
  const pref = store.data.settings.surface || 'auto';
  if (pref === 'acrylic') return isWin11() ? 'acrylic' : 'glass';
  if (pref === 'glass') return 'glass';
  return isWin11() ? 'acrylic' : 'glass';
}

// ---------------------------------------------------------------- window

/** Keep the widget on a display that actually exists and is reachable. */
function clampToDisplay(bounds) {
  const displays = screen.getAllDisplays();
  const target = screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay();
  const area = target.workArea;
  const width = Math.min(bounds.width, area.width);
  const height = Math.min(bounds.height, area.height);
  // Require a reasonable slice of the widget to remain grabbable on screen.
  const visible = displays.some(d => {
    const a = d.workArea;
    return bounds.x + width - 60 > a.x && bounds.x + 60 < a.x + a.width
      && bounds.y + 40 > a.y && bounds.y + 40 < a.y + a.height;
  });
  if (visible) return { x: Math.round(bounds.x), y: Math.round(bounds.y), width, height };
  return {
    x: Math.round(area.x + area.width - width - 32),
    y: Math.round(area.y + 48),
    width,
    height
  };
}

function defaultBounds(compact) {
  const area = screen.getPrimaryDisplay().workArea;
  const size = compact ? COMPACT : EXPANDED;
  return {
    x: Math.round(area.x + area.width - size.width - 32),
    y: Math.round(area.y + 48),
    width: size.width,
    height: size.height
  };
}

function currentBounds() {
  const compact = !!store.data.settings.compact;
  const saved = compact ? store.data.compactBounds : store.data.bounds;
  return clampToDisplay(saved || defaultBounds(compact));
}

function persistBounds() {
  if (!win || win.isDestroyed()) return;
  if (saveBoundsTimer) clearTimeout(saveBoundsTimer);
  saveBoundsTimer = setTimeout(() => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const b = win.getBounds();
    if (store.data.settings.compact) store.data.compactBounds = b;
    else store.data.bounds = b;
    store.save();
  }, 400);
  if (saveBoundsTimer.unref) saveBoundsTimer.unref();
}

/** Nudge the window flush against a nearby work-area edge after a drag. */
function snapToEdges() {
  if (!win || win.isDestroyed()) return;
  const b = win.getBounds();
  const area = screen.getDisplayMatching(b).workArea;
  let { x, y } = b;
  if (Math.abs(x - area.x) < SNAP_PX) x = area.x;
  if (Math.abs(x + b.width - (area.x + area.width)) < SNAP_PX) x = area.x + area.width - b.width;
  if (Math.abs(y - area.y) < SNAP_PX) y = area.y;
  if (Math.abs(y + b.height - (area.y + area.height)) < SNAP_PX) y = area.y + area.height - b.height;
  if (x !== b.x || y !== b.y) win.setPosition(Math.round(x), Math.round(y), false);
}

function createWindow() {
  const settings = store.data.settings;
  const compact = !!settings.compact;
  const size = compact ? COMPACT : EXPANDED;
  const bounds = currentBounds();
  const surface = resolveSurface();

  const options = {
    ...bounds,
    minWidth: size.minWidth,
    minHeight: size.minHeight,
    frame: false,
    resizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    hasShadow: true,
    roundedCorners: true,
    backgroundColor: '#00000000',
    title: 'HR Dock',
    icon: appIcon(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      backgroundThrottling: false,
      devTools: isDev
    }
  };

  if (surface === 'acrylic') options.backgroundMaterial = 'acrylic';
  else options.transparent = true;

  win = new BrowserWindow(options);
  win.surface = surface;

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    applyWindowSettings();
    if (!(launchedAtStartup && settings.startMinimised)) win.show();
    if (isDev) win.webContents.openDevTools({ mode: 'detach' });

    if (captureTarget) {
      setTimeout(async () => {
        try {
          const image = await win.webContents.capturePage();
          fs.writeFileSync(captureTarget, image.toPNG());
          console.log(`[capture] wrote ${captureTarget}`);
        } catch (err) {
          console.error('[capture] failed:', err.message);
        }
        quitting = true;
        app.quit();
      }, Number(process.env.HRDOCK_CAPTURE_DELAY) || 2600);
    }
  });

  win.on('move', persistBounds);
  win.on('moved', () => { snapToEdges(); persistBounds(); });
  win.on('resize', persistBounds);
  win.on('resized', persistBounds);

  // Closing the widget hides it; only the tray (or an explicit quit) exits.
  win.on('close', e => {
    if (!quitting) { e.preventDefault(); win.hide(); }
  });
  win.on('closed', () => { win = null; });

  // Never let the widget navigate away or spawn browser windows in-frame.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', e => e.preventDefault());

  return win;
}

function applyWindowSettings() {
  if (!win || win.isDestroyed()) return;
  const s = store.data.settings;
  // 'normal' level keeps the widget above the desktop and ordinary windows
  // without covering full-screen apps, games or UAC prompts.
  win.setAlwaysOnTop(!!s.alwaysOnTop, 'normal');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  win.setOpacity(Math.max(0.25, Math.min(1, Number(s.opacity) || 1)));
  win.setIgnoreMouseEvents(!!s.clickThrough, { forward: true });
  win.setSkipTaskbar(true);
}

/** Swap between compact and full dashboard geometry, remembering both. */
function setCompact(compact) {
  if (!win || win.isDestroyed()) return;
  const wasCompact = !!store.data.settings.compact;
  if (wasCompact === !!compact) return;

  const b = win.getBounds();
  if (wasCompact) store.data.compactBounds = b; else store.data.bounds = b;

  store.data.settings.compact = !!compact;
  const size = compact ? COMPACT : EXPANDED;
  const saved = compact ? store.data.compactBounds : store.data.bounds;
  // Anchor the transition to the current top-right corner so the widget does
  // not appear to jump across the screen when it changes size.
  const next = clampToDisplay(saved && saved.width ? saved : {
    x: b.x + b.width - size.width,
    y: b.y,
    width: size.width,
    height: size.height
  });

  win.setMinimumSize(size.minWidth, size.minHeight);
  win.setBounds(next, true);
  store.save();
  send('state:changed', { compact: !!compact });
}

/** Recreate the window when the backdrop material changes (needs a new HWND). */
function rebuildWindow() {
  if (!win || win.isDestroyed()) return;
  const wasVisible = win.isVisible();
  quitting = true;                 // suppress the hide-on-close guard
  win.destroy();
  quitting = false;
  createWindow();
  if (!wasVisible) win.once('ready-to-show', () => win.hide());
}

function toggleVisibility() {
  if (!win || win.isDestroyed()) { createWindow(); return; }
  if (win.isVisible() && !win.isMinimized()) win.hide();
  else { win.show(); win.focus(); }
}

function send(channel, payload) {
  if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------- tray

function appIcon() {
  const png = path.join(__dirname, '..', '..', 'assets', 'icon.png');
  return fs.existsSync(png) ? png : undefined;
}

function trayImage() {
  const file = appIcon();
  if (!file) return nativeImage.createEmpty();
  return nativeImage.createFromPath(file).resize({ width: 16, height: 16 });
}

function buildTrayMenu() {
  const s = store.data.settings;
  return Menu.buildFromTemplate([
    { label: 'HR Dock', enabled: false },
    { type: 'separator' },
    {
      label: win && win.isVisible() ? 'Hide widget' : 'Show widget',
      accelerator: 'Ctrl+Alt+A',
      click: toggleVisibility
    },
    {
      label: 'Compact mode',
      type: 'checkbox',
      checked: !!s.compact,
      click: item => { setCompact(item.checked); refreshTray(); }
    },
    {
      label: 'Always on top',
      type: 'checkbox',
      checked: !!s.alwaysOnTop,
      click: item => {
        store.patchSettings({ alwaysOnTop: item.checked });
        applyWindowSettings();
        send('settings:changed', store.data.settings);
      }
    },
    {
      label: 'Click-through (ignore mouse)',
      type: 'checkbox',
      checked: !!s.clickThrough,
      click: item => {
        store.patchSettings({ clickThrough: item.checked });
        applyWindowSettings();
        send('settings:changed', store.data.settings);
      }
    },
    {
      label: 'Silent mode',
      type: 'checkbox',
      checked: !!(s.notifications && s.notifications.silent),
      click: item => {
        store.patchSettings({ notifications: { silent: item.checked } });
        send('settings:changed', store.data.settings);
      }
    },
    { type: 'separator' },
    {
      label: 'Start with Windows',
      type: 'checkbox',
      checked: !!s.autostart,
      click: item => { setAutostart(item.checked); send('settings:changed', store.data.settings); }
    },
    {
      label: 'Reset position',
      click: () => {
        const b = defaultBounds(!!store.data.settings.compact);
        if (win) { win.setBounds(b, true); win.show(); }
        persistBounds();
      }
    },
    { label: 'Open data folder', click: () => shell.openPath(app.getPath('userData')) },
    { type: 'separator' },
    { label: 'Quit HR Dock', click: () => { quitting = true; app.quit(); } }
  ]);
}

function refreshTray() {
  if (tray) tray.setContextMenu(buildTrayMenu());
}

function createTray() {
  try {
    tray = new Tray(trayImage());
  } catch (err) {
    console.error('[tray] unavailable:', err.message);
    return;
  }
  tray.setToolTip('HR Dock — productivity dashboard');
  refreshTray();
  tray.on('click', toggleVisibility);
  tray.on('double-click', toggleVisibility);
}

// ---------------------------------------------------------------- autostart

function setAutostart(enabled) {
  store.patchSettings({ autostart: !!enabled });
  try {
    app.setLoginItemSettings({
      openAtLogin: !!enabled,
      openAsHidden: false,
      path: process.execPath,
      args: isDev ? [path.resolve(__dirname, '..', '..'), '--startup'] : ['--startup']
    });
  } catch (err) {
    console.error('[autostart] failed:', err.message);
  }
  refreshTray();
  return app.getLoginItemSettings().openAtLogin;
}

// ---------------------------------------------------------------- IPC

function registerIpc() {
  ipcMain.handle('app:bootstrap', () => ({
    data: store.data,
    env: {
      platform: process.platform,
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      isWin11: isWin11(),
      surface: win ? win.surface : resolveSurface(),
      userData: app.getPath('userData'),
      autostart: (() => { try { return app.getLoginItemSettings().openAtLogin; } catch (_) { return false; } })(),
      dark: nativeTheme.shouldUseDarkColors,
      dev: isDev
    }
  }));

  ipcMain.handle('data:get', () => store.data);

  // The renderer owns the in-memory collections and hands back whole arrays;
  // they are small (thousands of rows at most) and this keeps mutation logic
  // in one place instead of duplicating it across the process boundary.
  ipcMain.handle('data:set', (_e, { key, value }) => {
    if (!['events', 'routines', 'todos', 'notes', 'stats'].includes(key)) {
      throw new Error(`refusing to write unknown collection: ${key}`);
    }
    store.set(key, value);
    if (key === 'events' || key === 'todos' || key === 'routines') reminders.refresh();
    return true;
  });

  ipcMain.handle('settings:patch', (_e, patch) => {
    const before = JSON.parse(JSON.stringify(store.data.settings));
    const next = store.patchSettings(patch || {});
    applyWindowSettings();
    if (patch && patch.surface && patch.surface !== before.surface) rebuildWindow();
    if (patch && patch.compact !== undefined && patch.compact !== before.compact) {
      store.data.settings.compact = before.compact;   // let setCompact own the transition
      setCompact(patch.compact);
    }
    refreshTray();
    return next;
  });

  ipcMain.handle('window:command', (_e, { command, payload }) => {
    if (!win || win.isDestroyed()) return false;
    switch (command) {
      case 'hide': win.hide(); break;
      case 'show': win.show(); win.focus(); break;
      case 'minimise': win.minimize(); break;
      case 'quit': quitting = true; app.quit(); break;
      case 'compact': setCompact(!!payload); break;
      case 'toggleCompact': setCompact(!store.data.settings.compact); break;
      case 'center': {
        const b = win.getBounds();
        const area = screen.getDisplayMatching(b).workArea;
        win.setBounds({
          ...b,
          x: Math.round(area.x + (area.width - b.width) / 2),
          y: Math.round(area.y + (area.height - b.height) / 2)
        }, true);
        break;
      }
      case 'resetPosition': win.setBounds(defaultBounds(!!store.data.settings.compact), true); break;
      case 'setBounds': {
        const next = clampToDisplay({ ...win.getBounds(), ...payload });
        win.setBounds(next, false);
        break;
      }
      case 'nudge': {
        const b = win.getBounds();
        win.setPosition(Math.round(b.x + (payload.dx || 0)), Math.round(b.y + (payload.dy || 0)), false);
        break;
      }
      case 'devtools': if (isDev) win.webContents.toggleDevTools(); break;
      default: return false;
    }
    persistBounds();
    return true;
  });

  ipcMain.handle('window:state', () => {
    if (!win || win.isDestroyed()) return null;
    const b = win.getBounds();
    const display = screen.getDisplayMatching(b);
    return {
      bounds: b,
      visible: win.isVisible(),
      focused: win.isFocused(),
      compact: !!store.data.settings.compact,
      surface: win.surface,
      display: { id: display.id, workArea: display.workArea, scale: display.scaleFactor }
    };
  });

  ipcMain.handle('weather:get', async (_e, opts) => {
    const s = store.data.settings.weather || {};
    const place = s.auto ? null : s.place;
    return weather.fetchWeather(place, {
      unit: s.unit || 'c',
      force: !!(opts && opts.force),
      maxAgeMs: Math.max(5, Number(s.refreshMinutes) || 30) * 60000
    });
  });
  ipcMain.handle('weather:search', (_e, query) => weather.searchPlaces(query));
  ipcMain.handle('weather:detect', () => weather.detectPlace(true));

  ipcMain.handle('system:watch', (_e, on) => {
    if (on) {
      monitor.start();
      return monitor.snapshot();
    }
    monitor.stop();
    return null;
  });

  ipcMain.handle('reminder:snooze', (_e, { reminder, minutes }) => reminders.snooze(reminder, minutes));
  ipcMain.handle('reminder:dismiss', (_e, key) => { reminders.dismiss(key); return true; });
  ipcMain.handle('reminder:test', () => {
    reminders.fire({
      key: `test:${Date.now()}`,
      kind: 'event',
      title: 'HR Dock reminders are working',
      body: 'This is what a reminder looks like.',
      category: 'general',
      day: require('../shared/datetime.js').todayKey()
    });
    return true;
  });

  ipcMain.handle('autostart:set', (_e, enabled) => setAutostart(enabled));

  ipcMain.handle('data:backup', () => {
    try { return { ok: true, path: store.backup() }; }
    catch (err) { return { ok: false, error: err.message }; }
  });
  ipcMain.handle('data:backups', () => store.listBackups());

  ipcMain.handle('data:export', async () => {
    const stamp = new Date().toISOString().slice(0, 10);
    const res = await dialog.showSaveDialog(win, {
      title: 'Export HR Dock data',
      defaultPath: path.join(app.getPath('documents'), `hrdock-backup-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
    try {
      store.flush();
      fs.writeFileSync(res.filePath, JSON.stringify(store.data, null, 2), 'utf8');
      return { ok: true, path: res.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('data:import', async (_e, filePath) => {
    let target = filePath;
    if (!target) {
      const res = await dialog.showOpenDialog(win, {
        title: 'Import HR Dock data',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (res.canceled || !res.filePaths.length) return { ok: false, cancelled: true };
      target = res.filePaths[0];
    }
    try {
      const incoming = JSON.parse(fs.readFileSync(target, 'utf8'));
      if (typeof incoming !== 'object' || incoming === null) throw new Error('not an HR Dock backup');
      store.backup();                       // never overwrite without a safety net
      store.replaceAll(incoming);
      applyWindowSettings();
      reminders.refresh();
      send('data:replaced', store.data);
      return { ok: true, path: target };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('data:reveal', () => shell.openPath(app.getPath('userData')));
  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return true;
  });
}

// ---------------------------------------------------------------- lifecycle

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { win.show(); win.focus(); }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId('com.hrdock.app');   // required for Windows toasts

    store = new Store();
    weather = new WeatherService();
    monitor = new SystemMonitor();
    reminders = new ReminderEngine(store, {
      onFire: payload => {
        send('reminder:fired', payload);
        if (payload.action === 'click' && win) { win.show(); win.focus(); }
      }
    });

    registerIpc();
    createWindow();
    createTray();
    reminders.start();

    monitor.on('sample', sample => send('system:sample', sample));

    // Keep the widget honest across resumes, display changes and theme flips.
    powerMonitor.on('resume', () => {
      reminders.refresh();
      send('system:resume', Date.now());
      if (win && !win.isDestroyed()) applyWindowSettings();
    });
    screen.on('display-metrics-changed', () => {
      if (win && !win.isDestroyed()) win.setBounds(clampToDisplay(win.getBounds()), false);
    });
    screen.on('display-removed', () => {
      if (win && !win.isDestroyed()) win.setBounds(clampToDisplay(win.getBounds()), false);
    });
    nativeTheme.on('updated', () => send('theme:changed', nativeTheme.shouldUseDarkColors));

    globalShortcut.register('Control+Alt+A', toggleVisibility);
    globalShortcut.register('Control+Alt+C', () => { setCompact(!store.data.settings.compact); refreshTray(); });

    app.on('activate', () => { if (!win) createWindow(); else win.show(); });
  });

  app.on('window-all-closed', e => { /* the tray keeps HR Dock alive */ });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    if (monitor) monitor.stop();
    if (reminders) reminders.stop();
    if (store) store.flush();
  });
}
