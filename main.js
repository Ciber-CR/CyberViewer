'use strict';

const {
  app, BrowserWindow, shell, ipcMain, screen, Tray, Menu,
  protocol, nativeImage, clipboard, dialog, globalShortcut
} = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { Readable } = require('stream');
const { execFile } = require('child_process');

const {
  cleanFsPath, toMediaUrl, createPathAllowlist, IMAGE_EXTS, mimeForPath,
  isExistingImageFile
} = require('./lib/paths');
const { evictThumbCache } = require('./lib/thumb-cache');
const { clampWindowBounds } = require('./lib/window-bounds');
const { initUpdater, setAutoCheckEnabled } = require('./lib/updater');
const { buildBackup, parseBackup } = require('./lib/settings-backup');
const CVMedia = require('./js/media-helpers');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'cvlocal',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: false
    }
  }
]);

const settingsPath = path.join(app.getPath('userData'), 'settings.json');
const menuI18n = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'i18n', 'menu.json'), 'utf8')
);

/** Matches the config placeholder. Empty/missing settings resolve to this. */
const DEFAULT_TOGGLE_HOTKEY = 'Alt+Shift+V';

function isToggleHotkeyDisabled(value) {
  return value === 'disabled';
}

function resolveToggleHotkey(value) {
  if (isToggleHotkeyDisabled(value)) return '';
  const s = value == null ? '' : String(value).trim();
  return s || DEFAULT_TOGGLE_HOTKEY;
}

const pathAllowlist = createPathAllowlist([__dirname]);

function getUiLang() {
  try {
    const s = loadSettings();
    return (s.app && s.app.language) || 'en';
  } catch (_) {
    return 'en';
  }
}

function tMenu(key, lang) {
  const l = lang || getUiLang();
  const pack = menuI18n[l] || menuI18n.en || {};
  return pack[key] != null ? pack[key] : (menuI18n.en && menuI18n.en[key]) || key;
}

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (data && data.app) {
        if (data.app.checkUpdatesOnStartup === undefined) {
          data.app.checkUpdatesOnStartup = data.app.manualUpdateOnly === undefined
            ? true
            : !data.app.manualUpdateOnly;
        }
        if (!data.app.updateNotify || typeof data.app.updateNotify !== 'object') {
          data.app.updateNotify = {
            lastNotifiedAvailable: null,
            lastNotifiedDownloaded: null
          };
        }
        if (data.app.toolbarOpen === undefined) data.app.toolbarOpen = true;
        if (data.app.bannerAutoHide === undefined) data.app.bannerAutoHide = (data.app.hudAutoHide !== undefined ? data.app.hudAutoHide : true);
        if (data.app.hudAutoHideDelay === undefined) data.app.hudAutoHideDelay = 2000;
        if (data.app.disableTooltips === undefined) data.app.disableTooltips = false;
        if (data.app.alphaBackground === undefined) data.app.alphaBackground = 'checker-dark';
        if (data.app.imageOutline === undefined) data.app.imageOutline = false;
        if (!Array.isArray(data.app.recentFiles)) data.app.recentFiles = [];
        if (!Array.isArray(data.app.recentFolders)) data.app.recentFolders = [];
        if (data.app.slideshowIntervalMs === undefined) data.app.slideshowIntervalMs = 3000;
        if (data.app.slideshowLoop === undefined) data.app.slideshowLoop = true;
        if (data.app.slideshowEnterFullscreen === undefined) data.app.slideshowEnterFullscreen = true;
        if (data.app.allowMultipleInstances === undefined) data.app.allowMultipleInstances = false;
        if (data.app.showFileName === undefined) data.app.showFileName = true;
        if (data.app.animateGifs === undefined) data.app.animateGifs = true;
      if (data.app.dblClickAction === undefined) data.app.dblClickAction = 'fullscreen';
        if (data.app.toggleHotkey === undefined || data.app.toggleHotkey === '') {
          data.app.toggleHotkey = DEFAULT_TOGGLE_HOTKEY;
        }
      }
      return data;
    }
  } catch (e) {
    console.error('Error cargando settings:', e);
  }
  return {
    window: { width: 1280, height: 800, maximized: true },
    app: {
      closeToTray: false,
      closeImageOnTray: true,
      startMinimized: false,
      autoStart: false,
      accentColor: '#00d4ff',
      sidebarOpen: false,
      statusbarVisible: true,
      preferredDisplayId: 'auto',
      language: 'en',
      contextMenuEnabled: false,
      toggleHotkey: DEFAULT_TOGGLE_HOTKEY,
      checkUpdatesOnStartup: true,
      updateNotify: {
        lastNotifiedAvailable: null,
        lastNotifiedDownloaded: null
      },
      toolbarOpen: true,
      bannerAutoHide: true,
      hudAutoHideDelay: 2000,
      disableTooltips: false,
      showTopHints: true,
      alphaBackground: 'checker-dark',
      imageOutline: false,
      recentFiles: [],
      recentFolders: [],
      slideshowIntervalMs: 3000,
      slideshowLoop: true,
      slideshowEnterFullscreen: true,
      allowMultipleInstances: false,
      showFileName: true,
      animateGifs: true,
      dblClickAction: 'fullscreen',
      navZoomMode: 'reset'
    }
  };
}

function saveSettings(data) {
  try {
    const current = loadSettings();
    const merged = {
      window: { ...current.window, ...(data.window || {}) },
      app: { ...current.app, ...(data.app || {}) }
    };
    fs.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
  } catch (e) {
    console.error('Error guardando settings:', e);
  }
}

function getFilePathFromArgs(args) {
  for (let arg of args) {
    arg = arg.replace(/^"(.*)"$/, '$1');
    if (arg.match(/\.(jpg|jpeg|png|gif|webp|bmp|tiff|tif|ico)$/i)) {
      try {
        if (fs.existsSync(arg)) {
          const resolved = path.resolve(arg);
          pathAllowlist.allow(resolved);
          return resolved;
        }
      } catch (_) { /* ignore */ }
    }
  }
  return null;
}

function resolveAllowedPath(rawPath) {
  const abs = cleanFsPath(rawPath);
  return pathAllowlist.assertAllowed(abs);
}

function registerMediaProtocol() {
  protocol.handle('cvlocal', async (request) => {
    try {
      // Prefer ?p= absolute path — avoids Windows drive letters becoming URL hosts.
      const abs = cleanFsPath(request.url);
      if (!pathAllowlist.isAllowed(abs)) {
        console.warn('cvlocal forbidden:', abs);
        return new Response('Forbidden', { status: 403 });
      }
      let st;
      try {
        st = await fs.promises.stat(abs);
      } catch (_) {
        return new Response('Not Found', { status: 404 });
      }
      if (!st.isFile()) {
        return new Response('Not Found', { status: 404 });
      }

      // Stream file bytes — avoids loading multi-MB images fully into RAM.
      const nodeStream = fs.createReadStream(abs);
      const webStream = Readable.toWeb(nodeStream);
      const isThumb = abs.toLowerCase().includes(`${path.sep}thumb_cache${path.sep}`) ||
        abs.toLowerCase().includes('/thumb_cache/');
      return new Response(webStream, {
        headers: {
          'Content-Type': mimeForPath(abs),
          'Content-Length': String(st.size),
          'Cache-Control': isThumb ? 'private, max-age=86400' : 'no-cache, must-revalidate'
        }
      });
    } catch (e) {
      console.error('cvlocal protocol error:', e.message);
      return new Response('Bad Request', { status: 400 });
    }
  });
}

let win;
let tray = null;
let isQuitting = false;

// Resolved once at launch from persisted settings + launch args (see lock section).
let allowMultipleInstances = false;
const initialFilePath = getFilePathFromArgs(process.argv);
const instanceHasInitialFile = !!initialFilePath;
// Tray/close-to-tray are reserved for the "resident" launch (no file arg).
// Instances opened with an image file are ephemeral windows under multi-instance:
// they get no tray icon and closing them quits that process (no duplicates).
function wantsTray() {
  const s = loadSettings().app;
  return !!s.closeToTray && !(allowMultipleInstances && instanceHasInitialFile);
}

function resolveStartupBounds(settings) {
  const raw = settings.window && settings.window.bounds;
  const clamped = clampWindowBounds(raw, {
    displays: screen.getAllDisplays(),
    primary: screen.getPrimaryDisplay(),
    preferredDisplayId: settings.app && settings.app.preferredDisplayId
  });
  const inflated = !!(
    raw &&
    Number.isFinite(raw.width) &&
    Number.isFinite(raw.height) &&
    (raw.width > clamped.width + 32 || raw.height > clamped.height + 32)
  );
  return { ...clamped, inflated };
}

function persistWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    // Do not persist exclusive-fullscreen metrics as normal window bounds
    if (typeof win.isFullScreen === 'function' && win.isFullScreen()) return;

    const isMax = win.isMaximized();
    // Live bounds identify the monitor even while maximized
    const live = win.getBounds();
    const liveDisplay =
      (typeof screen.getDisplayMatching === 'function' && screen.getDisplayMatching(live)) ||
      screen.getDisplayNearestPoint({
        x: Math.round(live.x + live.width / 2),
        y: Math.round(live.y + live.height / 2)
      });

    // getNormalBounds avoids DPI-inflated maximized metrics on Windows
    const raw = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : live;
    const clamped = clampWindowBounds(raw, {
      displays: screen.getAllDisplays(),
      primary: screen.getPrimaryDisplay(),
      preferredDisplayId: loadSettings().app.preferredDisplayId,
      savedDisplayId: liveDisplay && liveDisplay.id
    });
    saveSettings({
      window: {
        maximized: isMax,
        bounds: {
          x: clamped.x,
          y: clamped.y,
          width: clamped.width,
          height: clamped.height,
          displayId: (liveDisplay && liveDisplay.id) || clamped.displayId
        }
      }
    });
  } catch (e) {
    console.error('Error persisting window state:', e);
  }
}

function createWindow() {
  const settings = loadSettings();
  const startup = resolveStartupBounds(settings);
  // Prefer maximized when previously maximized, first-run, or saved size was DPI-inflated
  const startMaximized =
    settings.window.maximized === true ||
    settings.window.maximized == null ||
    startup.inflated;

  win = new BrowserWindow({
    x: startup.x,
    y: startup.y,
    width: startup.width,
    height: startup.height,
    minWidth: 800,
    minHeight: 500,
    title: 'CyberViewer',
    backgroundColor: '#080a0e',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    frame: false,
    titleBarStyle: 'hidden',
    // Native rounded corners only on Windows 11 (build >= 22000). No effect on Win10.
    roundedCorners: true,
    thickFrame: true,
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      spellcheck: false,
      enableWebSQL: false,
      webSecurity: true
    }
  });

  try {
    win.setBackgroundColor('#080a0e');
  } catch (_) { /* ignore */ }

  // Debounce persistence — move/resize fire often and mixed-DPI getBounds is noisy
  let persistTimer = null;
  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = null;
      if (!win || win.isDestroyed()) return;
      if (win.isMaximized()) return;
      if (typeof win.isFullScreen === 'function' && win.isFullScreen()) return;
      persistWindowState();
    }, 400);
  };
  win.on('move', schedulePersist);
  win.on('resize', schedulePersist);

  let shown = false;
  const revealWindow = () => {
    if (shown || !win || win.isDestroyed()) return;
    shown = true;

    const isStartupLaunch = process.argv.includes('--startup');
    const shouldStartMinimized = settings.app.autoStart && isStartupLaunch;

    if (shouldStartMinimized) {
      if (!tray) createTray();
      return;
    }

    // Last-resort flash mitigation: show at opacity 0, settle layout, then fade in
    try { win.setOpacity(0); } catch (_) { /* ignore */ }

    // Place on the resolved startup display (keeps last-used monitor)
    try {
      win.setBounds({
        x: startup.x,
        y: startup.y,
        width: startup.width,
        height: startup.height
      });
    } catch (_) { /* ignore */ }

    win.show();

    if (startMaximized) {
      try {
        // Nudge onto the target display before maximize if needed
        const target =
          screen.getDisplayNearestPoint({
            x: startup.x + Math.floor(startup.width / 2),
            y: startup.y + Math.floor(startup.height / 2)
          });
        const cur = win.getBounds();
        const curDisp =
          (typeof screen.getDisplayMatching === 'function' && screen.getDisplayMatching(cur)) ||
          screen.getDisplayNearestPoint({
            x: Math.round(cur.x + cur.width / 2),
            y: Math.round(cur.y + cur.height / 2)
          });
        if (target && curDisp && target.id !== curDisp.id) {
          const wa = target.workArea || target.bounds;
          win.setBounds({
            x: wa.x + 48,
            y: wa.y + 48,
            width: Math.min(startup.width, Math.max(800, wa.width - 96)),
            height: Math.min(startup.height, Math.max(500, wa.height - 96))
          });
        }
        if (!win.isMaximized()) win.maximize();
      } catch (_) { /* ignore */ }
    }

    const fadeIn = () => {
      if (!win || win.isDestroyed()) return;
      try { win.setOpacity(1); } catch (_) { /* ignore */ }
    };
    // Two ticks: let Chromium/DWM composite the dark frame before becoming visible
    setTimeout(fadeIn, 32);
  };

  // Register before loadURL to avoid missing a fast ui-ready
  const onUiReady = () => {
    ipcMain.removeListener('ui-ready', onUiReady);
    revealWindow();
  };
  ipcMain.on('ui-ready', onUiReady);
  win.once('ready-to-show', () => {
    // Fallback if renderer never acks
    setTimeout(() => revealWindow(), 1500);
  });
  win.on('closed', () => {
    ipcMain.removeListener('ui-ready', onUiReady);
  });

  const htmlPath = path.join(__dirname, 'CyberViewer.html');
  const loadUrl = !app.isPackaged
    ? pathToFileURL(htmlPath).href + '?v=' + Date.now()
    : pathToFileURL(htmlPath).href;
  win.loadURL(loadUrl);

  win.on('close', (event) => {
    if (!isQuitting && wantsTray()) {
      event.preventDefault();
      hideToTray();
      return false;
    }
    persistWindowState();
  });

  win.on('show', () => updateTrayMenu());
  win.on('hide', () => updateTrayMenu());
  win.on('minimize', () => updateTrayMenu());
  win.on('restore', () => updateTrayMenu());
  win.on('blur', () => {
    if (win && !win.isDestroyed()) win.webContents.send('window-blur');
  });

  win.on('maximize', () => {
    win.webContents.send('win-state', 'maximized');
    persistWindowState();
  });
  win.on('unmaximize', () => {
    // Ignore transient unmaximize while entering exclusive fullscreen
    if (typeof win.isFullScreen === 'function' && win.isFullScreen()) return;
    win.webContents.send('win-state', 'normal');
    // Re-clamp after unmaximize — Windows/DPI often restores oversized bounds
    setTimeout(() => {
      if (!win || win.isDestroyed() || win.isMaximized()) return;
      if (typeof win.isFullScreen === 'function' && win.isFullScreen()) return;
      try {
        const raw = win.getBounds();
        const clamped = clampWindowBounds(raw, {
          displays: screen.getAllDisplays(),
          primary: screen.getPrimaryDisplay(),
          preferredDisplayId: loadSettings().app.preferredDisplayId
        });
        if (raw.width > clamped.width + 8 || raw.height > clamped.height + 8) {
          win.setBounds({
            x: clamped.x,
            y: clamped.y,
            width: clamped.width,
            height: clamped.height
          });
        }
      } catch (_) { /* ignore */ }
      persistWindowState();
    }, 0);
  });

  // OS exclusive fullscreen ↔ renderer immersive (ghost) UI
  win.on('enter-full-screen', () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('fullscreen-changed', true);
  });
  win.on('leave-full-screen', () => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('fullscreen-changed', false);
    // Restore maximize glyph after exclusive fullscreen ends
    try {
      win.webContents.send('win-state', win.isMaximized() ? 'maximized' : 'normal');
    } catch (_) { /* ignore */ }
    persistWindowState();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

function hideToTray() {
  if (!win || win.isDestroyed()) return;
  persistWindowState();
  // Optionally unload the open image when hiding to the tray, so reopening
  // the window (manually or via Explorer) shows a clean state with no trace
  // of the previous image — it stays only in the Recents history.
  try {
    const s = (loadSettings().app) || {};
    if (s.closeImageOnTray !== false && win.webContents && !win.webContents.isDestroyed()) {
      win.webContents.send('menu-action', { action: 'close-image' });
    }
  } catch (_) { /* ignore */ }
  if (win.isVisible()) win.hide();
  updateTrayMenu();
}

function showFromTray() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  updateTrayMenu();
}

function isWindowShown() {
  return !!(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
}

// ── Custom HTML tray menu (mirrors the CyberPaste tray popup style) ──
// Card width & transparent shadow pad, both in logical (DIP) px. Electron 35
// reports tray bounds, screen work areas, setBounds and renderer CSS sizes all
// in DIP — we stay in DIP throughout (no scaleFactor scaling).
const TRAY_MENU_WIDTH = 268;
const TRAY_MENU_SHADOW_PAD = 26;
// Estimated card-bearing window height (DIP) for the first paint; corrected by
// `tray-menu-ready` once the renderer measures the real size. card(~220) + bleed(52).
const TRAY_MENU_EST_HEIGHT = 272;
let trayMenuWin = null;
let trayMenuAnchor = null;
let trayMenuHideTimer = null;
let trayMenuLastShown = 0;

function buildTrayMenuState() {
  const settings = loadSettings();
  const lang = settings.app.language || 'en';
  const t = menuI18n[lang] || menuI18n.en;
  const visible = isWindowShown();
  return {
    version: app.getVersion(),
    head: 'CyberViewer v' + app.getVersion(),
    visible,
    showLabel: visible ? (t.tray_hide || t.tray_show) : t.tray_show,
    settingsLabel: t.tray_settings,
    aboutLabel: t.tray_about || t.about,
    exitLabel: t.tray_exit,
    shortcut: resolveToggleHotkey(settings.app && settings.app.toggleHotkey)
  };
}

// Position + size the tray popup (DIP) so the visible card sits just outside the
// tray icon, opening away from the taskbar. We anchor on the icon rectangle from
// tray.getBounds() (DIP, same coordinate space as screen.workArea and setBounds
// in Electron 35) and detect which screen edge the icon hugs (bottom = normal
// taskbar, left/top/right = moved taskbar) so a vertical-left taskbar opens the
// card to the *right* of the icon — matching how native tray menus behave.
function trayMenuGeometry(iconBounds, windowW, windowH) {
  let b = (iconBounds && typeof iconBounds.x === 'number' && (iconBounds.width || iconBounds.height))
    ? { x: iconBounds.x, y: iconBounds.y, width: iconBounds.width || 0, height: iconBounds.height || 0 }
    : null;
  if (!b) {
    let p = null;
    try { p = screen.getCursorScreenPoint(); } catch (_) { p = { x: 0, y: 0 }; }
    b = { x: p.x, y: p.y, width: 0, height: 0 };
  }
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  let display;
  try { display = screen.getDisplayNearestPoint({ x: cx, y: cy }); }
  catch (_) { display = screen.getPrimaryDisplay(); }
  const work = (display && display.workArea) || { x: 0, y: 0, width: windowW, height: windowH };

  const gap = 4;
  const pad = TRAY_MENU_SHADOW_PAD;
  const cardW = windowW - 2 * pad;
  const cardH = windowH - 2 * pad;

  // Distance from the icon center to each work-area edge.
  const dLeft = cx - work.x;
  const dRight = (work.x + work.width) - cx;
  const dTop = cy - work.y;
  const dBottom = (work.y + work.height) - cy;

  let cardX, cardY;
  if (dBottom <= dLeft && dBottom <= dRight && dBottom <= dTop) {
    // Bottom taskbar: open above the icon.
    cardX = cx - cardW / 2;
    cardY = b.y - gap - cardH;
  } else if (dTop <= dLeft && dTop <= dRight) {
    // Top taskbar: open below the icon.
    cardX = cx - cardW / 2;
    cardY = b.y + b.height + gap;
  } else if (dLeft <= dRight) {
    // Left taskbar: open to the right of the icon.
    cardX = b.x + b.width + gap;
    cardY = cy - cardH / 2;
  } else {
    // Right taskbar: open to the left of the icon.
    cardX = b.x - gap - cardW;
    cardY = cy - cardH / 2;
  }

  // Keep the card within the work area, then convert to window coords (subtract bleed).
  cardX = Math.min(Math.max(cardX, work.x + 4), work.x + work.width - cardW - 4);
  cardY = Math.min(Math.max(cardY, work.y + 4), work.y + work.height - cardH - 4);
  return { x: Math.round(cardX - pad), y: Math.round(cardY - pad), width: windowW, height: windowH };
}

function ensureTrayMenuWin() {
  if (trayMenuWin && !trayMenuWin.isDestroyed()) return trayMenuWin;
  trayMenuWin = new BrowserWindow({
    width: TRAY_MENU_WIDTH + 2 * TRAY_MENU_SHADOW_PAD,
    height: TRAY_MENU_EST_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'tray-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  trayMenuWin.setAlwaysOnTop(true, 'pop-up-menu');
  trayMenuWin.loadFile(path.join(__dirname, 'tray-menu.html'));
  trayMenuWin.on('blur', () => {
    if (trayMenuHideTimer) return;
    // Ignore the transient blur that fires when a tray right-click / re-show
    // steals focus away and back — only hide on a genuine focus loss.
    if (Date.now() - trayMenuLastShown < 250) return;
    trayMenuHideTimer = setTimeout(() => {
      trayMenuHideTimer = null;
      hideTrayMenu();
    }, 120);
  });
  trayMenuWin.on('closed', () => { trayMenuWin = null; });
  trayMenuWin.webContents.once('did-finish-load', () => {
    if (!trayMenuWin || trayMenuWin.isDestroyed()) return;
    trayMenuWin.webContents.send('tray-menu-state', buildTrayMenuState());
    trayMenuWin.webContents.send('tray-menu-show');
  });
  return trayMenuWin;
}

function showTrayMenu(eventBounds) {
  if (!tray) return;
  // Prefer the tray-icon rectangle Electron hands us on right-click; fall back
  // to tray.getBounds() and finally the cursor. All are DIP in Electron 35, so
  // geometry stays in a single coordinate space — no per-monitor DPI flip.
  let b = (eventBounds && typeof eventBounds.x === 'number' && (eventBounds.width || eventBounds.height))
    ? eventBounds : null;
  if (!b) { try { b = tray.getBounds(); } catch (_) { b = null; } }
  if (!b || !b.width && !b.height) {
    let p = null; try { p = screen.getCursorScreenPoint(); } catch (_) { p = null; }
    b = p ? { x: p.x, y: p.y, width: 0, height: 0 } : { x: 0, y: 0, width: 0, height: 0 };
  }
  trayMenuAnchor = b;
  if (trayMenuHideTimer) { clearTimeout(trayMenuHideTimer); trayMenuHideTimer = null; }
  const w = ensureTrayMenuWin();
  if (!w || w.isDestroyed()) return;
  const geo = trayMenuGeometry(trayMenuAnchor,
    TRAY_MENU_WIDTH + 2 * TRAY_MENU_SHADOW_PAD, TRAY_MENU_EST_HEIGHT);
  w.setBounds(geo);
  if (!w.isVisible()) w.show();
  w.focus();
  trayMenuLastShown = Date.now();
  if (!w.webContents.isLoading()) {
    w.webContents.send('tray-menu-state', buildTrayMenuState());
    w.webContents.send('tray-menu-show');
  }
}

function hideTrayMenu() {
  if (trayMenuHideTimer) { clearTimeout(trayMenuHideTimer); trayMenuHideTimer = null; }
  if (trayMenuWin && !trayMenuWin.isDestroyed() && trayMenuWin.isVisible()) {
    trayMenuWin.hide();
  }
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setToolTip('CyberViewer v' + app.getVersion());
  if (trayMenuWin && !trayMenuWin.isDestroyed() && !trayMenuWin.webContents.isLoading()) {
    trayMenuWin.webContents.send('tray-menu-state', buildTrayMenuState());
  }
}

function createTray() {
  if (tray) return;
  tray = new Tray(path.join(__dirname, 'assets', 'icon.ico'));
  tray.setToolTip('CyberViewer v' + app.getVersion());
  tray.on('click', () => {
    hideTrayMenu();
    if (!win || win.isDestroyed()) return;
    if (isWindowShown()) hideToTray();
    else showFromTray();
  });
  tray.on('right-click', (_event, bounds) => {
    showTrayMenu(bounds);
  });
}

// ── Global toggle hotkey ─────────────────────────────────────────────
// When the user sets an accelerator (e.g. "Alt+Shift+V") we register it globally
// so CyberViewer can be shown/hidden from anywhere. "disabled" (or a resolved
// empty value) unregisters the shortcut. Missing/blank settings use Alt+Shift+V.
function applyToggleHotkey(accelerator) {
  try { globalShortcut.unregisterAll(); } catch (_) { /* not registered yet */ }
  const acc = resolveToggleHotkey(accelerator);
  if (!acc) return { success: true }; // disabled by design
  try {
    globalShortcut.register(acc, () => {
      if (!win || win.isDestroyed()) return;
      if (isWindowShown()) hideToTray();
      else showFromTray();
    });
    if (!globalShortcut.isRegistered(acc)) {
      return { success: false, error: 'accelerator-in-use' };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message || 'invalid-accelerator' };
  }
}

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch (_) { /* nothing registered */ }
});

ipcMain.on('tray-menu-action', (_event, action) => {
  hideTrayMenu();
  switch (action) {
    case 'toggle':
      if (isWindowShown()) hideToTray();
      else showFromTray();
      break;
    case 'settings':
      showFromTray();
      if (win && !win.isDestroyed()) win.webContents.send('open-settings');
      break;
    case 'about':
      showFromTray();
      if (win && !win.isDestroyed()) win.webContents.send('menu-action', { action: 'show-about' });
      break;
    case 'quit':
      isQuitting = true;
      app.quit();
      break;
    default:
      break;
  }
});

ipcMain.on('tray-menu-ready', (_event, rect) => {
  if (!trayMenuWin || trayMenuWin.isDestroyed() || !trayMenuWin.isVisible()) return;
  if (!rect || !rect.width || !rect.height) return;
  // Renderer measures in CSS px, which on a transparent DIP window equals DIP.
  const geo = trayMenuGeometry(trayMenuAnchor, Math.round(rect.width), Math.round(rect.height));
  const cur = trayMenuWin.getBounds();
  if (Math.abs(cur.width - geo.width) > 1 ||
      Math.abs(cur.height - geo.height) > 1 ||
      Math.abs(cur.x - geo.x) > 1 ||
      Math.abs(cur.y - geo.y) > 1) {
    trayMenuWin.setBounds(geo);
  }
  trayMenuWin.focus();
});

ipcMain.on('tray-menu-hide', () => hideTrayMenu());

// ── IPC ──
ipcMain.on('win-minimize', () => win.minimize());
ipcMain.on('win-maximize', () => {
  if (!win || win.isDestroyed()) return;
  // Leave exclusive fullscreen before toggle maximize/restore
  if (typeof win.isFullScreen === 'function' && win.isFullScreen()) {
    win.setFullScreen(false);
  }
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.on('win-close', () => win.close());
ipcMain.on('win-devtools', () => {
  // DevTools only outside packaged builds
  if (!app.isPackaged && win && !win.isDestroyed()) {
    win.webContents.openDevTools();
  }
});

ipcMain.handle('win-set-fullscreen', (event, flag) => {
  if (!win || win.isDestroyed()) return false;
  const want = !!flag;
  try {
    if (win.isFullScreen() === want) return want;
    win.setFullScreen(want);
    return win.isFullScreen();
  } catch (e) {
    console.error('setFullScreen failed:', e);
    return false;
  }
});

ipcMain.handle('win-is-fullscreen', () => {
  if (!win || win.isDestroyed()) return false;
  try {
    return !!win.isFullScreen();
  } catch (_) {
    return false;
  }
});

ipcMain.handle('open-file-dialog', async () => {
  const lang = getUiLang();
  const result = await dialog.showOpenDialog(win, {
    title: tMenu('dialog_open_title', lang),
    filters: [
      {
        name: tMenu('dialog_open_filter_images', lang),
        extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico']
      },
      { name: tMenu('dialog_open_filter_all', lang), extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return null;
  const filePath = result.filePaths[0];
  pathAllowlist.allow(filePath);
  return filePath;
});

/**
 * Resolve first image in a directory (natural sort) and allowlist it.
 * @param {string} dirPath
 * @returns {Promise<{ok:boolean, path?:string, dir?:string, count?:number, empty?:boolean, error?:string}>}
 */
async function resolveFirstImageInDir(dirPath) {
  try {
    const dir = path.resolve(dirPath);
    let st;
    try {
      st = await fs.promises.stat(dir);
    } catch (_) {
      return { ok: false, error: 'NOT_FOUND' };
    }
    if (!st.isDirectory()) return { ok: false, error: 'NOT_DIR' };

    const files = await fs.promises.readdir(dir);
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    const imageNames = files
      .filter((f) => IMAGE_EXTS.has(path.extname(f).toLowerCase()))
      .sort((a, b) => collator.compare(a, b));

    if (!imageNames.length) {
      return { ok: false, empty: true, dir };
    }

    for (const name of imageNames) {
      const fullPath = path.resolve(dir, name);
      try {
        const fst = await fs.promises.stat(fullPath);
        if (!fst.isFile()) continue;
        const allowed = pathAllowlist.allowImageFile(fullPath);
        if (!allowed) continue;
        return { ok: true, path: allowed, dir, count: imageNames.length };
      } catch (_) { /* skip */ }
    }
    return { ok: false, empty: true, dir };
  } catch (e) {
    console.error('resolveFirstImageInDir failed:', e);
    return { ok: false, error: e.message || 'OPEN_FOLDER_FAILED' };
  }
}

/**
 * Pick a folder, find the first image (natural sort), allowlist it, return its path.
 * Renderer then uses existing scan-folder from that image.
 */
ipcMain.handle('open-folder-dialog', async () => {
  const lang = getUiLang();
  const result = await dialog.showOpenDialog(win, {
    title: tMenu('dialog_open_folder_title', lang),
    properties: ['openDirectory']
  });
  if (result.canceled || !result.filePaths.length) {
    return { ok: false, canceled: true };
  }
  return resolveFirstImageInDir(result.filePaths[0]);
});

/** Open a known folder path (recent folders) without a dialog. */
ipcMain.handle('open-folder-path', async (event, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string') {
    return { ok: false, error: 'BAD_PATH' };
  }
  return resolveFirstImageInDir(dirPath);
});

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.handle('get-version', () => app.getVersion());
ipcMain.handle('show-save-dialog', async (event, options) => {
  const result = await dialog.showSaveDialog(win, options);
  if (!result.canceled && result.filePath) {
    pathAllowlist.allow(result.filePath);
  }
  return result;
});

const SETTINGS_BACKUP_MAX_BYTES = 2 * 1024 * 1024;

ipcMain.handle('settings:export-backup', async (_event, appSettings) => {
  const lang = getUiLang();
  const result = await dialog.showSaveDialog(win, {
    title: tMenu('dialog_export_settings_title', lang),
    defaultPath: 'CyberViewer-settings.json',
    filters: [
      { name: tMenu('dialog_settings_filter', lang), extensions: ['json'] },
      { name: tMenu('dialog_save_filter_all', lang), extensions: ['*'] }
    ]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };
  try {
    const current = loadSettings();
    const appData = (appSettings && typeof appSettings === 'object')
      ? { ...current.app, ...appSettings }
      : current.app;
    const backup = buildBackup(appData, { appVersion: app.getVersion() });
    fs.writeFileSync(result.filePath, JSON.stringify(backup, null, 2), 'utf8');
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: e.message || 'WRITE_FAILED' };
  }
});

ipcMain.handle('settings:import-backup', async () => {
  const lang = getUiLang();
  const result = await dialog.showOpenDialog(win, {
    title: tMenu('dialog_import_settings_title', lang),
    filters: [
      { name: tMenu('dialog_settings_filter', lang), extensions: ['json'] },
      { name: tMenu('dialog_open_filter_all', lang), extensions: ['*'] }
    ],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  const filePath = result.filePaths[0];
  try {
    const st = await fs.promises.stat(filePath);
    if (!st.isFile() || st.size > SETTINGS_BACKUP_MAX_BYTES) {
      return { ok: false, error: 'INVALID_FILE' };
    }
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const parsed = parseBackup(raw);
    if (!parsed.ok) return parsed;
    return { ok: true, settings: parsed.settings, favorites: parsed.favorites };
  } catch (e) {
    return { ok: false, error: e.message || 'READ_FAILED' };
  }
});

// ── Print / PDF export (Chromium engine, no native deps) ──
// The renderer bakes the current image (rotation) to a PNG data URL, then
// asks the main process to render it in a hidden window and call the native
// print/PrintToPDF path. v1 is single-page fit; never upscales small images.

async function loadPrintWindow(html) {
  const printWin = new BrowserWindow({
    width: 800, height: 600, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true }
  });

  // Do not put the whole image-backed HTML into a data: URL. Large photos become
  // huge base64 strings and can exceed Chromium URL limits, causing PDF export to
  // fail before printToPDF runs. A temporary file keeps the navigation URL small.
  const tmpHtmlPath = path.join(
    app.getPath('temp'),
    'cyberviewer-print-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex') + '.html'
  );
  try {
    fs.writeFileSync(tmpHtmlPath, html, 'utf8');
    await printWin.loadURL(pathToFileURL(tmpHtmlPath).toString());
    await printWin.webContents.executeJavaScript(`
      Promise.all(Array.from(document.images).map((img) => {
        if (img.complete && img.naturalWidth > 0) return true;
        return new Promise((resolve, reject) => {
          img.onload = () => resolve(true);
          img.onerror = () => reject(new Error('Image failed to load for print/PDF'));
        });
      }))
    `, true);
  } finally {
    try { fs.unlinkSync(tmpHtmlPath); } catch (_) { /* best-effort temp cleanup */ }
  }
  return printWin;
}

ipcMain.handle('export-image-pdf', async (event, { dataUrl, width, height, title, options, savePath }) => {
  try {
    if (!dataUrl) return { success: false, error: 'No image data' };

    let targetPath = savePath;
    if (!targetPath) {
      const lang = getUiLang();
      const t = menuI18n[lang] || menuI18n.en;
      const baseName = (title || 'image').replace(/[\\/:*?"<>|]/g, '_');
      const result = await dialog.showSaveDialog(win, {
        title: t.export_pdf || 'Export PDF',
        defaultPath: baseName + '.pdf',
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      });
      if (result.canceled || !result.filePath) return { success: false, canceled: true };
      targetPath = result.filePath;
    }

    const printOpts = CVMedia.resolveExportOptions(options, width, height, 'pdf');
    const html = CVMedia.bakePrintHtml(dataUrl, width, height, title);
    const printWin = await loadPrintWindow(html);
    let pdfBuffer;
    try {
      pdfBuffer = await printWin.webContents.printToPDF(printOpts);
    } finally {
      if (!printWin.isDestroyed()) printWin.destroy();
    }

    const tmpPath = targetPath + '.cybertmp.' + Date.now();
    fs.writeFileSync(tmpPath, pdfBuffer);
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
    fs.renameSync(tmpPath, targetPath);
    pathAllowlist.allow(targetPath);
    return { success: true, filePath: targetPath };
  } catch (e) {
    console.error('export-image-pdf error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('print-image', async (event, { dataUrl, width, height, title, options }) => {
  try {
    if (!dataUrl) return { success: false, error: 'No image data' };
    const printOpts = CVMedia.resolveExportOptions(options, width, height, 'print');
    const html = CVMedia.bakePrintHtml(dataUrl, width, height, title);
    const printWin = await loadPrintWindow(html);
    const printResult = await new Promise((resolve) => {
      printWin.webContents.print(printOpts, (success, failureReason) => {
        resolve({ success, failureReason });
      });
    });
    if (!printWin.isDestroyed()) printWin.destroy();
    if (!printResult.success && printResult.failureReason && printResult.failureReason !== 'canceled') {
      console.error('print-image failed:', printResult.failureReason);
      return { success: false, error: printResult.failureReason };
    }
    if (win && !win.isDestroyed()) win.focus();
    return { success: true };
  } catch (e) {
    console.error('print-image error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.handle('get-monitors', () => {
  const lang = getUiLang();
  const primaryId = screen.getPrimaryDisplay().id;
  const primaryPrefix = tMenu('monitor_primary', lang);
  const monLabel = tMenu('monitor_label', lang);
  return screen.getAllDisplays().map((d) => ({
    id: d.id,
    label: `${d.id === primaryId ? primaryPrefix : ''}${monLabel.replace('{id}', String(d.id))}`,
    bounds: d.bounds
  }));
});

ipcMain.handle('to-media-url', (event, filePath) => {
  try {
    const abs = resolveAllowedPath(filePath);
    return toMediaUrl(abs);
  } catch (e) {
    return null;
  }
});

/** Register only existing image files (widens allowlist to their parent dirs). */
ipcMain.handle('register-paths', (event, paths) => {
  try {
    if (!Array.isArray(paths)) return { success: false, registered: [] };
    const registered = [];
    const max = 5000;
    for (let i = 0; i < paths.length && registered.length < max; i++) {
      const p = paths[i];
      if (!p) continue;
      const abs = pathAllowlist.allowImageFile(p);
      if (abs) registered.push(abs);
    }
    return { success: true, registered, count: registered.length };
  } catch (e) {
    return { success: false, error: e.message, registered: [] };
  }
});

/** Default directory for saving pasted images (no dialog). Allowlist it so save-image
    can write files there without a per-file prompt. Falls back to app data on error. */
ipcMain.handle('get-default-save-dir', () => {
  try {
    const dir = app.getPath('pictures');
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { /* ignore */ }
    pathAllowlist.allow(dir);
    return dir;
  } catch (e) {
    const fallback = app.getPath('userData');
    pathAllowlist.allow(fallback);
    return fallback;
  }
});

ipcMain.handle('scan-folder', async (event, filePath) => {
  try {
    const absFile = cleanFsPath(filePath);
    // Only scan neighbors of an existing image file (prevents arbitrary directory reads).
    if (!isExistingImageFile(absFile)) {
      return [];
    }
    pathAllowlist.allow(absFile);
    const dir = path.dirname(absFile);

    // withFileTypes returns Dirent entries whose isFile() needs no extra stat,
    // so we skip one syscall per directory entry vs the bare-name path.
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

    const imageDirents = dirents
      .filter((d) => (d.isFile() || d.isSymbolicLink()) && IMAGE_EXTS.has(path.extname(d.name).toLowerCase()))
      .sort((a, b) => collator.compare(a.name, b.name));

    // Stat in parallel for sizes — the old serial await-per-file loop serialized N
    // syscalls on the main event loop; Promise.all fans them out via libuv's pool.
    const results = await Promise.all(imageDirents.map(async (d) => {
      const fullPath = path.resolve(dir, d.name);
      try {
        const stats = await fs.promises.stat(fullPath); // follows symlinks
        if (!stats.isFile()) return null;
        return { path: fullPath, size: stats.size };
      } catch (_) {
        return null; // skip unreadable
      }
    }));
    return results.filter(Boolean);
  } catch (e) {
    console.error('Error escaneando carpeta:', e);
    return [];
  }
});

const thumbCachePath = path.join(app.getPath('userData'), 'thumb_cache');
if (!fs.existsSync(thumbCachePath)) fs.mkdirSync(thumbCachePath, { recursive: true });
pathAllowlist.allow(thumbCachePath);

/**
 * Limit concurrent nativeImage thumb work to avoid CPU spikes on large folders.
 * Priority waiters (current image) jump the queue so the open image is never
 * stuck behind dozens of sibling thumbnails.
 */
const THUMB_CONCURRENCY = 3;
let thumbInFlight = 0;
/** @type {{ resolve: () => void, priority: boolean }[]} */
const thumbWaiters = [];

function acquireThumbSlot(priority) {
  if (thumbInFlight < THUMB_CONCURRENCY) {
    thumbInFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const entry = { resolve, priority: !!priority };
    if (entry.priority) {
      // Ahead of the first non-priority waiter (preserve FIFO among priorities)
      let insertAt = 0;
      while (insertAt < thumbWaiters.length && thumbWaiters[insertAt].priority) {
        insertAt++;
      }
      thumbWaiters.splice(insertAt, 0, entry);
    } else {
      thumbWaiters.push(entry);
    }
  }).then(() => {
    thumbInFlight++;
  });
}

function releaseThumbSlot() {
  thumbInFlight = Math.max(0, thumbInFlight - 1);
  const next = thumbWaiters.shift();
  if (next) next.resolve();
}

async function renderGifFirstFrameThumb(abs, cacheFile) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#000;overflow:hidden;width:160px;height:120px}
    img{position:absolute;left:0;top:0;max-width:none;opacity:0}
    canvas{position:absolute;left:0;top:0;width:160px;height:120px}
  </style></head><body><img id="src"><canvas id="canvas" width="160" height="120"></canvas><script>
    const done = (payload) => window.__thumbDone = payload;
    const img = document.getElementById('src');
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d');
    img.onload = () => {
      try {
        const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
        const w = Math.max(1, Math.round(img.naturalWidth * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const x = Math.floor((canvas.width - w) / 2);
        const y = Math.floor((canvas.height - h) / 2);
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, x, y, w, h);
        done({ ok: true, dataUrl: canvas.toDataURL('image/jpeg', 0.8) });
      } catch (e) {
        done({ ok: false, error: e.message });
      }
    };
    img.onerror = () => done({ ok: false, error: 'GIF frame failed to load' });
    img.src = ${JSON.stringify(pathToFileURL(abs).toString())};
  </script></body></html>`;

  const frameWin = new BrowserWindow({
    width: 160,
    height: 120,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: false, webSecurity: false }
  });
  try {
    await frameWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    const result = await frameWin.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const start = Date.now();
        const tick = () => {
          if (window.__thumbDone) return resolve(window.__thumbDone);
          if (Date.now() - start > 5000) return resolve({ ok: false, error: 'GIF frame timeout' });
          setTimeout(tick, 30);
        };
        tick();
      })
    `, true);
    if (!result || !result.ok || !result.dataUrl) return false;
    const base64 = String(result.dataUrl).split(',')[1];
    if (!base64) return false;
    await fs.promises.writeFile(cacheFile, Buffer.from(base64, 'base64'));
    return true;
  } finally {
    if (!frameWin.isDestroyed()) frameWin.destroy();
  }
}

ipcMain.handle('get-thumbnail', async (event, filePath, opts) => {
  try {
    const abs = resolveAllowedPath(filePath);
    const priority = !!(opts && opts.priority);
    const stats = await fs.promises.stat(abs);
    const normalizedPath = abs.toLowerCase();
    const isGif = path.extname(abs).toLowerCase() === '.gif';
    const thumbVersion = isGif ? 'gif-frame-v2' : 'still-v1';
    const hash = crypto.createHash('md5').update(normalizedPath + stats.mtimeMs + thumbVersion).digest('hex');
    const cacheFile = path.join(thumbCachePath, `${hash}.jpg`);

    // Cache hits never wait on the generation queue
    if (fs.existsSync(cacheFile)) {
      return toMediaUrl(cacheFile);
    }

    await acquireThumbSlot(priority);
    try {
      if (fs.existsSync(cacheFile)) {
        return toMediaUrl(cacheFile);
      }
      if (isGif && await renderGifFirstFrameThumb(abs, cacheFile)) {
        // GIF thumbnails are intentionally static first frames. Do not use the
        // animated source as the sidebar base image.
      } else {
        const img = nativeImage.createFromPath(abs);
        if (img.isEmpty()) return null;
        const thumb = img.resize({ height: 100, quality: 'better' });
        await fs.promises.writeFile(cacheFile, thumb.toJPEG(80));
      }
      evictThumbCache(thumbCachePath);
      return toMediaUrl(cacheFile);
    } finally {
      releaseThumbSlot();
    }
  } catch (e) {
    return null;
  }
});

ipcMain.handle('save-image', async (event, { filePath, rotation, buffer, createCopy, copySuffix }) => {
  try {
    if (!filePath) return { success: false, error: 'Ruta no proporcionada' };

    const cleanPath = resolveAllowedPath(filePath);
    let targetPath = cleanPath;

    if (createCopy) {
      const dir = path.dirname(cleanPath);
      const ext = path.extname(cleanPath);
      const base = path.basename(cleanPath, ext);
      const suffix = (typeof copySuffix === 'string' && copySuffix) ? copySuffix : '_resized';
      let candidate = path.join(dir, `${base}${suffix}${ext}`);
      let counter = 1;
      while (fs.existsSync(candidate)) {
        counter++;
        candidate = path.join(dir, `${base}${suffix} (${counter})${ext}`);
      }
      targetPath = candidate;
      pathAllowlist.allow(targetPath);
    }

    let dataToWrite;
    if (buffer) {
      dataToWrite = Buffer.from(buffer, 'base64');
    } else {
      let img = nativeImage.createFromPath(cleanPath);
      if (img.isEmpty()) {
        try {
          const raw = fs.readFileSync(cleanPath);
          img = nativeImage.createFromBuffer(raw);
        } catch (e) {
          return { success: false, error: `No se pudo leer la imagen: ${e.message}` };
        }
      }
      if (img.isEmpty()) {
        return { success: false, error: 'Formato de imagen no soportado por el motor nativo' };
      }
      const times = Math.floor((rotation || 0) / 90);
      for (let i = 0; i < times; i++) img = img.rotate(90);
      const ext = path.extname(targetPath).toLowerCase();
      dataToWrite = (ext === '.png') ? img.toPNG() : img.toJPEG(95);
    }

    const tmpPath = targetPath + '.cybertmp.' + Date.now();
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const dir = path.dirname(targetPath);
        try {
          fs.accessSync(dir, fs.constants.W_OK);
        } catch (e) {
          return { success: false, error: `No hay permisos de escritura en: ${dir}` };
        }

        fs.writeFileSync(tmpPath, dataToWrite);
        if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
        fs.renameSync(tmpPath, targetPath);
        return { success: true, filePath: targetPath };
      } catch (e) {
        console.warn(`Save retry ${attempt + 1} failed:`, e.message);
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) { /* ignore */ }
        await new Promise((r) => setTimeout(r, 200));
      }
    }

    return { success: false, error: 'No se pudo escribir el archivo (archivo en uso o permisos insuficientes)' };
  } catch (e) {
    if (e.code === 'PATH_NOT_ALLOWED') {
      return { success: false, error: 'Ruta no permitida' };
    }
    console.error('save-image error:', e.message);
    return { success: false, error: e.message };
  }
});

ipcMain.on('copy-image', (event, filePath) => {
  try {
    const cleanPath = resolveAllowedPath(filePath);
    fs.readFile(cleanPath, (err, data) => {
      if (err) {
        console.error('Failed to read file for clipboard:', err);
        return;
      }
      const img = nativeImage.createFromBuffer(data);
      if (!img.isEmpty()) clipboard.writeImage(img);
    });
  } catch (e) {
    console.error('Error copying image to clipboard:', e);
  }
});

ipcMain.on('copy-image-buffer', (event, base64) => {
  try {
    if (!base64 || typeof base64 !== 'string') return;
    const img = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
    if (!img.isEmpty()) clipboard.writeImage(img);
  } catch (e) {
    console.error('Error copying image buffer to clipboard:', e);
  }
});

ipcMain.handle('clipboard:read-image', () => {
  try {
    const img = clipboard.readImage();
    if (!img || img.isEmpty()) {
      return { ok: false, error: 'NO_IMAGE' };
    }
    const size = img.getSize();
    return {
      ok: true,
      buffer: img.toPNG().toString('base64'),
      width: size.width,
      height: size.height,
      mime: 'image/png'
    };
  } catch (e) {
    console.error('Error reading clipboard image:', e);
    return { ok: false, error: String((e && e.message) || e) };
  }
});

async function trashFile(filePath) {
  const abs = resolveAllowedPath(filePath);
  await shell.trashItem(abs);
  return { success: true };
}

ipcMain.handle('move-to-trash', async (event, filePath) => {
  try {
    return await trashFile(filePath);
  } catch (e) {
    console.error('Error moving file to trash:', e);
    return { success: false, error: e.message };
  }
});

ipcMain.on('show-item-in-folder', (event, filePath) => {
  try {
    if (!filePath) return;
    const abs = resolveAllowedPath(filePath);
    if (fs.existsSync(abs)) shell.showItemInFolder(abs);
  } catch (e) {
    console.error('Error showing item in folder:', e);
  }
});

ipcMain.handle('open-containing-folder', async (event, filePath) => {
  try {
    if (!filePath) return { success: false, error: 'BAD_PATH' };
    const abs = resolveAllowedPath(filePath);
    const dir = path.dirname(abs);
    if (!fs.existsSync(dir)) return { success: false, error: 'FOLDER_NOT_FOUND' };
    const error = await shell.openPath(dir);
    return error ? { success: false, error } : { success: true };
  } catch (e) {
    console.error('Error opening containing folder:', e);
    return { success: false, error: e.message || 'OPEN_FOLDER_FAILED' };
  }
});

let propertiesScriptWritten = false;
function openNativeProperties(rawPath) {
  try {
    const absolutePath = resolveAllowedPath(rawPath);
    const folderPath = path.dirname(absolutePath).replace(/\//g, '\\');
    const fileName = path.basename(absolutePath);
    const propsWsfPath = path.join(app.getPath('temp'), 'cyberviewer_properties.wsf');
    const wsfContent = `<?xml version="1.0" encoding="utf-8" ?>
<package>
   <job id="GetProperties">
      <script language="VBScript">
         <![CDATA[
         If WScript.Arguments.Count >= 2 Then
            Set objShell = CreateObject("Shell.Application")
            Set objFolder = objShell.NameSpace(WScript.Arguments(0))
            If Not objFolder Is Nothing Then
               Set objFolderItem = objFolder.ParseName(WScript.Arguments(1))
               If Not objFolderItem Is Nothing Then
                  objFolderItem.InvokeVerb "Properties"
                  WScript.Sleep 1800000
               End If
            End If
         End If
         ]]>
      </script>
   </job>
</package>`;
    if (!propertiesScriptWritten || !fs.existsSync(propsWsfPath)) {
      fs.writeFileSync(propsWsfPath, wsfContent, 'utf-8');
      propertiesScriptWritten = true;
    }
    execFile('wscript.exe', [propsWsfPath, folderPath, fileName]);
  } catch (e) {
    console.error('Error opening file properties via WSF:', e);
  }
}

ipcMain.on('open-native-properties', (event, filePath) => {
  if (filePath) openNativeProperties(filePath);
});

ipcMain.handle('get-file-info', (event, filePath) => {
  try {
    const stats = fs.statSync(resolveAllowedPath(filePath));
    return { size: stats.size, modified: stats.mtimeMs, created: stats.birthtimeMs };
  } catch (e) {
    return null;
  }
});

/**
 * Check which paths still exist as image files.
 * Does NOT expand the allowlist — call register-paths after for paths you will open.
 */
ipcMain.handle('validate-paths', (event, paths) => {
  try {
    if (!Array.isArray(paths)) return [];
    return paths.filter((p) => {
      try {
        return isExistingImageFile(p);
      } catch (_) {
        return false;
      }
    }).map((p) => {
      try {
        return cleanFsPath(p);
      } catch (_) {
        return p;
      }
    });
  } catch (e) {
    console.error('Error validating paths:', e);
    return [];
  }
});

function runRegCommands(commands) {
  return new Promise((resolve) => {
    if (!commands.length) {
      resolve({ success: true });
      return;
    }
    const runNext = (i) => {
      if (i >= commands.length) {
        resolve({ success: true });
        return;
      }
      const [cmd, ...args] = commands[i];
      execFile(cmd, args, (err) => {
        if (err && cmd === 'reg' && args[0] === 'delete') {
          // ignore missing keys
        } else if (err) {
          console.error('Registry command failed:', err.message);
          resolve({ success: false, error: err.message });
          return;
        }
        runNext(i + 1);
      });
    };
    runNext(0);
  });
}

ipcMain.handle('register-context-menu', async (event, enable, lang) => {
  try {
    const isPackaged = app.isPackaged;
    let exePath = process.execPath;
    if (!isPackaged) {
      exePath = path.join(app.getAppPath(), 'dist', 'win-unpacked', 'CyberViewer.exe');
    }

    const extensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.ico'];
    const progIds = ['BMP Image', 'GIF Image', 'JPEG Image', 'PNG Image', 'WebP Image', 'TIFF Image', 'icofile'];

    if (enable) {
      if (!fs.existsSync(exePath)) {
        return { success: false, error: 'No se encontró el ejecutable. Construye la app primero.' };
      }

      const label = lang === 'es' ? 'Ver con CyberViewer' : 'View with CyberViewer';
      const assocLabel = lang === 'es' ? 'Abrir con CyberViewer' : 'Open with CyberViewer';
      const commands = [];

      for (const ext of extensions) {
        const regPath = `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\CyberViewer`;
        commands.push(['reg', 'add', regPath, '/ve', '/d', label, '/f']);
        commands.push(['reg', 'add', regPath, '/v', 'Icon', '/d', exePath, '/f']);
        commands.push(['reg', 'add', `${regPath}\\command`, '/ve', '/d', `"${exePath}" "%1"`, '/f']);
      }
      for (const progId of progIds) {
        const regPath = `HKCU\\Software\\Classes\\${progId}\\shell\\open`;
        commands.push(['reg', 'add', regPath, '/ve', '/d', assocLabel, '/f']);
        commands.push(['reg', 'add', regPath, '/v', 'Icon', '/d', exePath, '/f']);
      }
      return runRegCommands(commands);
    }

    const commands = [];
    for (const ext of extensions) {
      const regPath = `HKCU\\Software\\Classes\\SystemFileAssociations\\${ext}\\shell\\CyberViewer`;
      commands.push(['reg', 'delete', regPath, '/f']);
    }
    for (const progId of progIds) {
      const regPath = `HKCU\\Software\\Classes\\${progId}\\shell\\open`;
      commands.push(['reg', 'add', regPath, '/ve', '/d', 'Open with CyberViewer', '/f']);
      commands.push(['reg', 'delete', regPath, '/v', 'Icon', '/f']);
    }
    return runRegCommands(commands);
  } catch (e) {
    console.error('Error in register-context-menu handler:', e);
    return { success: false, error: e.message };
  }
});

ipcMain.on('save-settings', (event, newSettings) => {
  saveSettings({ app: newSettings });

  if (newSettings.checkUpdatesOnStartup !== undefined) {
    setAutoCheckEnabled(!!newSettings.checkUpdatesOnStartup);
  }

  if (newSettings.autoStart !== undefined) {
    app.setLoginItemSettings({
      openAtLogin: newSettings.autoStart,
      path: app.getPath('exe'),
      args: ['--startup']
    });
  }

  const trayAllowed = !(allowMultipleInstances && instanceHasInitialFile);
  if (newSettings.closeToTray && trayAllowed && !tray) {
    createTray();
  } else if (!newSettings.closeToTray && tray) {
    hideTrayMenu();
    if (trayMenuWin && !trayMenuWin.isDestroyed()) {
      trayMenuWin.destroy();
      trayMenuWin = null;
    }
    tray.destroy();
    tray = null;
  } else if (tray) {
    // Refresh the context menu in place. Do NOT destroy() + createTray() here:
    // recreating the Tray resets Windows per-icon "always show" pinning, sending the
    // icon back to the overflow area. updateTrayMenu() updates labels (e.g. on language
    // change) without changing the icon identity.
    updateTrayMenu();
  }

  // (Re)apply the global toggle hotkey whenever the setting may have changed.
  if (newSettings.toggleHotkey !== undefined) {
    applyToggleHotkey(newSettings.toggleHotkey);
  }
});

ipcMain.on('show-context-menu', (event, props) => {
  const settings = loadSettings();
  const lang = settings.app.language || 'en';
  const t = menuI18n[lang] || menuI18n.en;
  const browserWin = BrowserWindow.fromWebContents(event.sender);
  let template = [];

  if (props.isEditable) {
    template = [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' }
    ];
  } else if (props.type === 'image' || props.type === 'main-image') {
    template = [
      {
        label: t.file,
        submenu: [
          {
            label: t.copy_image,
            click: () => {
              try {
                const abs = resolveAllowedPath(props.path);
                fs.readFile(abs, (err, data) => {
                  if (!err) {
                    const img = nativeImage.createFromBuffer(data);
                    clipboard.writeImage(img);
                  }
                });
              } catch (_) { /* ignore */ }
            }
          },
          {
            label: t.copy_path,
            enabled: !!props.path,
            click: () => { if (props.path) clipboard.writeText(props.path); }
          },
          {
            label: t.save_as,
            click: async () => {
              const ext = path.extname(props.path || '');
              const base = path.basename(props.path || 'image', ext) || 'image';
              const dir = props.path ? path.dirname(props.path) : app.getPath('pictures');
              const result = await dialog.showSaveDialog(browserWin, {
                title: tMenu('dialog_save_as_title', lang),
                defaultPath: path.join(dir, `${base}_copy.png`),
                filters: [
                  { name: 'PNG', extensions: ['png'] },
                  { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
                  { name: tMenu('dialog_save_filter_all', lang), extensions: ['*'] }
                ]
              });
              if (!result.canceled && result.filePath) {
                const targetPath = /\.[^\\/]+$/.test(result.filePath) ? result.filePath : result.filePath + '.png';
                pathAllowlist.allow(targetPath);
                event.sender.send('menu-action', { action: 'save-as', targetPath });
              }
            }
          },
          {
            label: t.close_image,
            click: () => event.sender.send('menu-action', { action: 'close-image' })
          }
        ]
      },
      {
        label: t.edit,
        submenu: [
          {
            label: t.rotate,
            submenu: [
              { label: t.rotate_r, click: () => event.sender.send('menu-action', { action: 'rotate-r-save' }) },
              { label: t.rotate_l, click: () => event.sender.send('menu-action', { action: 'rotate-l-save' }) }
            ]
          },
          { label: t.crop, click: () => event.sender.send('menu-action', { action: 'crop' }) },
          { label: t.resize, click: () => event.sender.send('menu-action', { action: 'resize' }) },
          { label: t.adjust, click: () => event.sender.send('menu-action', { action: 'adjust' }) },
          {
            label: props.isFavorite ? t.favorite_remove : t.favorite_add,
            click: () => event.sender.send('menu-action', { action: 'toggle-favorite' })
          }
        ]
      },
      {
        label: t.view,
        submenu: [
          {
            label: t.show_in_folder,
            click: () => {
              try { shell.showItemInFolder(resolveAllowedPath(props.path)); } catch (_) { /* ignore */ }
            }
          },
          {
            label: t.properties,
            click: () => event.sender.send('menu-action', { action: 'show-properties', path: props.path })
          }
        ]
      },
      { type: 'separator' },
      {
        label: t.move_trash,
        click: () => {
          event.sender.send('menu-action', { action: 'request-delete', index: props.index, path: props.path });
        }
      },
      { type: 'separator' },
      { label: t.hide_session, click: () => event.sender.send('menu-action', { action: 'remove-from-list', index: props.index }) },
      {
        label: t.restore_hidden.replace('{count}', props.hiddenCount || 0),
        enabled: !!props.hiddenCount,
        visible: !!props.hiddenCount,
        click: () => event.sender.send('menu-action', { action: 'restore-hidden' })
      },
      { type: 'separator' },
      { label: t.quit, click: () => browserWin.close() }
    ];
  } else if (props.type === 'thumb') {
    template = [
      {
        label: t.file,
        submenu: [
          {
            label: t.copy_image,
            click: () => {
              try {
                const abs = resolveAllowedPath(props.path);
                fs.readFile(abs, (err, data) => {
                  if (!err) {
                    const img = nativeImage.createFromBuffer(data);
                    clipboard.writeImage(img);
                  }
                });
              } catch (_) { /* ignore */ }
            }
          },
          {
            label: t.show_in_folder,
            click: () => {
              try { shell.showItemInFolder(resolveAllowedPath(props.path)); } catch (_) { /* ignore */ }
            }
          }
        ]
      },
      {
        label: t.navigate,
        submenu: [
          { label: t.go_start, click: () => event.sender.send('menu-action', { action: 'go-start' }) },
          { label: t.go_end, click: () => event.sender.send('menu-action', { action: 'go-end' }) }
        ]
      },
      { type: 'separator' },
      { label: t.hide_session, click: () => event.sender.send('menu-action', { action: 'remove-from-list', index: props.index }) },
      {
        label: t.restore_hidden.replace('{count}', props.hiddenCount || 0),
        enabled: !!props.hiddenCount,
        visible: !!props.hiddenCount,
        click: () => event.sender.send('menu-action', { action: 'restore-hidden' })
      },
      { type: 'separator' },
      {
        label: t.move_trash,
        click: () => {
          event.sender.send('menu-action', { action: 'request-delete', index: props.index, path: props.path });
        }
      },
      { type: 'separator' },
      { label: t.quit, click: () => browserWin.close() }
    ];
  } else {
    const hasImages = !!props.hiddenCount || (props.type === 'canvas' && props.hasImages);
    template = [
      {
        label: t.file,
        submenu: [
          { label: t.open_folder, click: () => event.sender.send('menu-action', { action: 'open-dir' }) },
          {
            label: t.close_image,
            enabled: hasImages,
            visible: hasImages,
            click: () => event.sender.send('menu-action', { action: 'close-image' })
          },
          {
            label: t.copy_path,
            enabled: hasImages && !!props.path,
            click: () => { if (props.path) clipboard.writeText(props.path); }
          }
        ]
      },
      {
        label: t.view,
        submenu: [
          {
            label: t.fit_window,
            enabled: hasImages,
            click: () => event.sender.send('menu-action', { action: 'fit-to-window' })
          },
          {
            label: t.reset_zoom,
            enabled: hasImages,
            click: () => event.sender.send('menu-action', { action: 'reset-zoom' })
          },
          { type: 'separator' },
          {
            label: t.autohide_nav,
            type: 'checkbox',
            checked: !!props.navAutoHide,
            click: () => event.sender.send('menu-action', { action: 'toggle-autohide-nav' })
          }
        ]
      },
      {
        label: t.edit,
        enabled: hasImages,
        submenu: [
          {
            label: t.rotate,
            submenu: [
              { label: t.rotate_r, click: () => event.sender.send('menu-action', { action: 'rotate-r-save' }) },
              { label: t.rotate_l, click: () => event.sender.send('menu-action', { action: 'rotate-l-save' }) }
            ]
          },
          { label: t.crop, click: () => event.sender.send('menu-action', { action: 'crop' }) },
          { label: t.resize, click: () => event.sender.send('menu-action', { action: 'resize' }) },
          { label: t.adjust, click: () => event.sender.send('menu-action', { action: 'adjust' }) },
          {
            label: props.isFavorite ? t.favorite_remove : t.favorite_add,
            click: () => event.sender.send('menu-action', { action: 'toggle-favorite' })
          }
        ]
      },
      { type: 'separator' },
      { label: t.config, click: () => event.sender.send('menu-action', { action: 'show-config' }) },
      { label: t.about, click: () => event.sender.send('menu-action', { action: 'show-about' }) },
      { type: 'separator' },
      {
        label: browserWin.isMaximized() ? t.restore : t.maximize,
        click: () => {
          if (browserWin.isMaximized()) browserWin.unmaximize();
          else browserWin.maximize();
        }
      },
      { type: 'separator' },
      { label: t.quit, click: () => browserWin.close() }
    ];
  }

  if (template.length > 0) {
    Menu.buildFromTemplate(template).popup(browserWin);
  }
});

allowMultipleInstances = loadSettings().app.allowMultipleInstances === true;
const gotTheLock = allowMultipleInstances || app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      const filePath = getFilePathFromArgs(commandLine);
      if (filePath) win.webContents.send('open-file', filePath);
    }
  });

  app.whenReady().then(() => {
    registerMediaProtocol();
    pathAllowlist.allow(thumbCachePath);
    evictThumbCache(thumbCachePath);

    createWindow();
    win.webContents.setBackgroundThrottling(false);

    const settings = loadSettings();
    initUpdater(settings.app, {
      beforeQuitInstall: () => { isQuitting = true; }
    });
    if (wantsTray()) createTray();
    applyToggleHotkey(settings.app && settings.app.toggleHotkey);

    if (initialFilePath) {
      win.webContents.once('did-finish-load', () => {
        win.webContents.send('open-file', initialFilePath);
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
