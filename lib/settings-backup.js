'use strict';

const FORMAT = 'cyberviewer-settings';
const FORMAT_VERSION = 1;
const MAX_FAVORITES = 2000;
const MAX_PATH_LEN = 4096;

const SLIDESHOW_INTERVALS = [2000, 3000, 5000, 10000];
const ALPHA_BG = new Set(['checker-dark', 'checker-light', 'solid']);
const DBL_CLICK = new Set(['fullscreen', 'toggle-zoom', 'fit', 'original', 'none']);
const NAV_ZOOM = new Set(['reset', 'keep']);
const LANGUAGES = new Set(['en', 'es']);

const BOOLEAN_KEYS = [
  'sidebarOpen',
  'statusbarVisible',
  'closeToTray',
  'closeImageOnTray',
  'autoStart',
  'startMinimized',
  'contextMenuEnabled',
  'allowMultipleInstances',
  'animateGifs',
  'showFileName',
  'bannerAutoHide',
  'navAutoHide',
  'showTopHints',
  'disableTooltips',
  'imageOutline',
  'slideshowLoop',
  'slideshowEnterFullscreen',
  'checkUpdatesOnStartup',
  'toolbarOpen'
];

function asBool(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function pickSettings(src) {
  const out = {};
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out;

  for (const key of BOOLEAN_KEYS) {
    const v = asBool(src[key]);
    if (v !== undefined) out[key] = v;
  }

  if (LANGUAGES.has(src.language)) out.language = src.language;

  if (typeof src.accentColor === 'string' && /^#[0-9A-Fa-f]{6}$/.test(src.accentColor)) {
    out.accentColor = src.accentColor.toLowerCase();
  }

  if (src.preferredDisplayId != null && src.preferredDisplayId !== '') {
    const id = String(src.preferredDisplayId).slice(0, 64);
    if (id) out.preferredDisplayId = id;
  }

  if (typeof src.toggleHotkey === 'string') {
    const hk = src.toggleHotkey.trim().slice(0, 80);
    if (hk === 'disabled' || /^[A-Za-z0-9+ ]+$/.test(hk)) out.toggleHotkey = hk;
  }

  const delay = Number(src.hudAutoHideDelay);
  if (Number.isFinite(delay)) {
    const n = Math.round(delay);
    if (n >= 500 && n <= 15000) out.hudAutoHideDelay = n;
  }

  const interval = Number(src.slideshowIntervalMs);
  if (SLIDESHOW_INTERVALS.includes(interval)) out.slideshowIntervalMs = interval;

  if (ALPHA_BG.has(src.alphaBackground)) out.alphaBackground = src.alphaBackground;
  if (DBL_CLICK.has(src.dblClickAction)) out.dblClickAction = src.dblClickAction;
  if (NAV_ZOOM.has(src.navZoomMode)) out.navZoomMode = src.navZoomMode;

  return out;
}

function sanitizeFavorites(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const p = item.trim();
    if (!p || p.length > MAX_PATH_LEN || p.includes('\0')) continue;
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
    if (out.length >= MAX_FAVORITES) break;
  }
  return out;
}

function buildBackup(appSettings, opts) {
  const app = appSettings && typeof appSettings === 'object' ? appSettings : {};
  const settings = pickSettings(app);
  const favorites = sanitizeFavorites(app.favorites);
  return {
    format: FORMAT,
    version: FORMAT_VERSION,
    appVersion: (opts && opts.appVersion) || '',
    exportedAt: (opts && opts.exportedAt) || new Date().toISOString(),
    settings,
    favorites
  };
}

function parseBackup(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch (_) {
      return { ok: false, error: 'INVALID_JSON' };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: 'INVALID_SHAPE' };
  }

  if (data.format === FORMAT) {
    const ver = Number(data.version);
    if (!Number.isInteger(ver) || ver < 1) {
      return { ok: false, error: 'UNSUPPORTED_VERSION' };
    }
    const settingsSrc = (data.settings && typeof data.settings === 'object')
      ? data.settings
      : (data.app && typeof data.app === 'object' ? data.app : {});
    const settings = pickSettings(settingsSrc);
    const favorites = sanitizeFavorites(
      data.favorites || (settingsSrc && settingsSrc.favorites) || []
    );
    if (!Object.keys(settings).length && !favorites.length) {
      return { ok: false, error: 'EMPTY_BACKUP' };
    }
    return { ok: true, settings, favorites };
  }

  const app = (data.app && typeof data.app === 'object') ? data.app : data;
  const settings = pickSettings(app);
  const favorites = sanitizeFavorites(app.favorites);
  if (!Object.keys(settings).length && !favorites.length) {
    return { ok: false, error: 'EMPTY_BACKUP' };
  }
  return { ok: true, settings, favorites };
}

function applyBackup(currentApp, parsed) {
  const current = currentApp && typeof currentApp === 'object' ? currentApp : {};
  const patch = parsed && parsed.ok ? parsed : parseBackup(parsed);
  if (!patch || !patch.ok) return { ok: false, error: (patch && patch.error) || 'INVALID_SHAPE' };
  return {
    ok: true,
    app: {
      ...current,
      ...patch.settings,
      favorites: patch.favorites
    }
  };
}

module.exports = {
  FORMAT,
  FORMAT_VERSION,
  BOOLEAN_KEYS,
  pickSettings,
  sanitizeFavorites,
  buildBackup,
  parseBackup,
  applyBackup
};
