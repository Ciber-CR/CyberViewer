
// ── Media / format helpers (from js/media-helpers.js) ──
const CVMedia = (typeof window !== 'undefined' && window.CVMedia) ? window.CVMedia : {};
const mediaUrl = CVMedia.mediaUrl || function () { return ''; };
const canvasExport = CVMedia.canvasExport || function (c, p) { return { buffer: '', filePath: p }; };
const formatBytes = CVMedia.formatBytes || function () { return '-'; };
const buildCssFilter = CVMedia.buildCssFilter || function () { return 'none'; };
const isIdentityAdjust = CVMedia.isIdentityAdjust || function () { return true; };
const mimeFromPath = CVMedia.mimeFromPath || function () { return ''; };
const formatAspectRatio = CVMedia.formatAspectRatio || function () { return '-'; };
const formatMegapixels = CVMedia.formatMegapixels || function () { return '-'; };
const formatLikelyHasAlpha = CVMedia.formatLikelyHasAlpha || function () { return false; };
const screenCaptureZoom = CVMedia.screenCaptureZoom || function (dpr) {
  const scale = Number(dpr);
  return Number.isFinite(scale) && scale > 0 ? 1 / scale : 1;
};

function syncCurrentIndex(idx) {
  state.currentIdx = idx;
  state.current = idx;
}

// ── BASE CONSTANTS & ELECTRON BRIDGE ──
const isElectron = (typeof window.electronAPI !== 'undefined');
const $ = id => document.getElementById(id);

function setCyberTooltip(el, text) {
  if (typeof el === 'string') el = $(el);
  if (!el) return;
  el.setAttribute('data-tooltip', text);
  el.removeAttribute('title');
  el.classList.add('cyber-tooltip');
}

const ZOOM_MIN = 0.05;
const ZOOM_MAX = 20;
const PRELOAD_RANGE = 2;
/** Idle window after zoom/pan/nav before folder thumb scanning resumes. */
const SCAN_PAUSE_GRACE_MS = 3000;

// ── ELEMENTS ──
const app        = $('app');
const sidebar    = $('sidebar');
const viewerWrap = $('viewer-wrap');
const canvasL    = $('canvas-layer');
const mainImg    = $('main-img');
const spinner    = $('spinner');
const dropZone   = $('drop-zone');
const fileInput  = $('file-input');
const zoomHud    = $('zoom-hud');
const zoomVal    = $('zoom-val');
const btnOpen    = $('btn-open');
const btnConfig  = $('btn-config');
const btnAbout   = $('btn-about');

// ── STATE ──
let thumbObserver = null;
/** Coalesce concurrent loadThumb IPC for the same index */
const thumbLoadInflight = new Map();
const state = {
  images: [],          // {file, url, w, h, loaded}
  currentIdx: -1,
  current: -1,
  viewMode: 'fit',     // 'fit', 'original', or 'custom'
  selectedViewMode: 'fit', // user's chosen view mode; restored on navigation when navZoomMode === 'reset'
  zoom: 1,
  panX: 0,
  panY: 0,
  dragging: false,
  dragStartX: 0,
  dragStartY: 0,
  panStartX: 0,
  panStartY: 0,
  transitioning: false,
  sidebarOpen: false,
  toolbarOpen: true,
  /** Monotonic token bumped per open so stale folder scans never merge. */
  openSeq: 0,
  scanInProgress: false,
  /** Resolves when the current main image has been displayed (or failed) */
  mainImageReady: Promise.resolve(),
  /** True after the active main image finished loading for this index */
  mainImageReadyIdx: -1,
  preloadCache: new Map(),
  currentRotation: 0,
  visualRotation: 0,
  hasChanges: false,
  isCropping: false,
  isGhost: false,
  zoomTimer: null,
  lastZoomTime: 0,
  lastCanvasInteraction: 0,
  showingFavs: false,
  nonFavImages: [],
  nonFavCurrent: -1,
  settings: { 
    app: { 
      sidebarOpen: false, 
      statusbarVisible: true, 
      closeToTray: false, 
      closeImageOnTray: true, 
      autoStart: false, 
      accentColor: '#00d4ff',
      language: 'en',
      favorites: [],
      animateGifs: true,
      showTopHints: true,
      checkUpdatesOnStartup: true,
      // Toast once per version; badge stays until update is applied
      updateNotify: {
        lastNotifiedAvailable: null,
        lastNotifiedDownloaded: null
      },
      // Bottom action bar (kbd-hint); collapsible like sidebar
      toolbarOpen: true,
      // Transparency grid behind alpha pixels: checker-dark | checker-light | solid
      alphaBackground: 'checker-dark',
      imageOutline: false,
      recentFiles: [],
      recentFolders: [],
      // Slideshow
      slideshowIntervalMs: 3000,
      slideshowLoop: true,
      slideshowEnterFullscreen: true,
      allowMultipleInstances: false,
      showFileName: true,
      navZoomMode: 'reset'
    } 
  },
  // Runtime slideshow (not persisted)
  slideshowActive: false,
  slideshowPlaying: false,
  slideshowTimer: null,
  slideshowEnteredFs: false
};

/** Max entries in File → Recent images / folders (balance usefulness vs menu height). */
const RECENT_MAX = 8;
/** Shorter list for right-click menus (avoid tall nested flyouts). */
const RECENT_CTX_MAX = 5;

// UI strings: i18n/ui.js → window.CV_I18N (source: i18n/ui.json)
const I18N = (typeof window !== 'undefined' && window.CV_I18N) ? window.CV_I18N : { en: {}, es: {} };
// ── MENU ICONS ──
// Maps i18n keys → icon name. Shared by the static burger menu
// (decorated from each label's data-i18n) and the dynamic context menus
// (resolved from the rendered label text via LABEL_TO_ICON below).
const MENU_ICON_BY_I18N = {
  menu_file: 'file', menu_edit: 'edit', menu_view: 'eye', menu_go: 'compass',
  menu_help: 'help-circle', menu_prefs: 'gear', menu_about: 'info',
  menu_updates: 'download',
  menu_open: 'image', menu_open_folder: 'folder', menu_recent: 'clock',
  menu_recent_folders: 'folder', menu_paste: 'clipboard', menu_close_image: 'close',
  menu_show: 'folder-open', menu_open_containing_folder: 'folder-open', menu_save: 'save', menu_copy: 'copy',
  menu_copy_path: 'link', menu_save_as: 'save',
  menu_print: 'printer', menu_export_pdf: 'download',
  menu_props: 'info', menu_trash: 'trash', menu_quit: 'quit',
  menu_close_app: 'x',
  menu_rotate_l: 'rotate-ccw', menu_rotate_r: 'rotate-cw', menu_crop: 'crop',
  menu_resize: 'resize', menu_adjust: 'sliders', menu_flip_h: 'flip-h',
  menu_flip_v: 'flip-v', menu_fit: 'fit', menu_original: 'square',
  menu_fullscreen: 'fullscreen', menu_slideshow: 'play', menu_slideshow_loop: 'loop',
  menu_slideshow_interval: 'clock', menu_sidebar: 'panel-left',
  menu_slideshow_start: 'play', menu_slideshow_pause: 'pause', menu_slideshow_resume: 'play', menu_slideshow_stop: 'stop', menu_slideshow_exit: 'quit',
  menu_toolbar: 'panel-bottom', menu_show_hints: 'keyboard',
  menu_alpha_bg: 'grid', menu_next: 'next', menu_prev: 'prev',
  menu_favorite: 'star', menu_favs_view: 'star',
  menu_go_start: 'skip-start', menu_go_end: 'skip-end',
  menu_hide_session: 'eye-off', menu_restore_hidden: 'eye',
  menu_maximize: 'maximize', menu_autohide_nav: 'eye-off',
  config: 'gear', about: 'info',
  favorite_add: 'star', favorite_remove: 'star'
};

// SVG markup (inner) for each icon name. Rendered as stroke icons that
// inherit currentColor, matching the existing burger-button style.
const MENU_ICONS = {
  'file': '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M14 3v5h5"/>',
  'image': '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-4.5-4.5L7 19"/>',
  'folder': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  'folder-open': '<path d="M4 4h5l2 2h7a2 2 0 0 1 2 2v2H4z"/><path d="M3 9h18l-2 9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/>',
  'clock': '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  'clipboard': '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M8 5H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>',
  'close': '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/>',
  'save': '<path d="M5 3h11l3 3v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M7 3v5h8V3"/><path d="M7 15h10v6H7z"/>',
  'copy': '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 0-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  'link': '<path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/>',
  'info': '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  'help-circle': '<circle cx="12" cy="12" r="9"/><path d="M9.2 9a3 3 0 0 1 5.6 1c0 2-3 2.5-3 4"/><path d="M12 18h.01"/>',
  'trash': '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/>',
  'quit': '<path d="M18.4 6.6a9 9 0 1 1-12.8 0"/><path d="M12 3v9"/>',
  'x': '<path d="M18 6L6 18M6 6l12 12"/>',
  'rotate-ccw': '<path d="M3 12a9 9 0 1 0 2-4.6"/><path d="M3 4v5h5"/>',
  'rotate-cw': '<path d="M21 12a9 9 0 1 1-2-4.6"/><path d="M21 4v5h-5"/>',
  'crop': '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  'resize': '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="M21 3l-7 7"/><path d="M3 21l7-7"/>',
  'sliders': '<path d="M4 9h16"/><path d="M4 15h16"/><path d="M8 5v8"/><path d="M16 11v8"/>',
  'flip-h': '<path d="M12 4v16"/><path d="M9 9l-4 3 4 3"/><path d="M15 9l4 3-4 3"/>',
  'flip-v': '<path d="M4 12h16"/><path d="M9 9l3-4 3 4"/><path d="M9 15l3 4 3-4"/>',
  'fit': '<path d="M4 4h6M4 4v6M20 4h-6M20 4v6M4 20h6M4 20v-6M20 20h-6M20 20v-6"/>',
  'square': '<rect x="5" y="5" width="14" height="14" rx="1"/>',
  'fullscreen': '<path d="M4 4h7M4 4v7M20 4h-7M20 4v7M4 20h7M4 20v-7M20 20h-7M20 20v-7"/>',
  'play': '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M10 9l6 3-6 3z"/>',
  'loop': '<path d="M17 2l4 4-4 4"/><path d="M3 6h18"/><path d="M7 22l-4-4 4-4"/><path d="M21 18H3"/>',
  'panel-left': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  'panel-bottom': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 15h18"/>',
  'keyboard': '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M12 10h.01M17 10h.01M8 14h8"/>',
  'grid': '<path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"/>',
  'next': '<path d="M9 6l6 6-6 6"/>',
  'prev': '<path d="M15 6l-6 6 6 6"/>',
  'star': '<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.9-5.2-2.7-5.2 2.7 1-5.9-4.3-4.1 5.9-.9z"/>',
  'settings': '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M2 12h3M19 12h3M4.9 19.1l2.1-2.1M17 7l2.1-2.1"/>',
  'download': '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  'printer': '<path d="M6 9V3h12v6"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><path d="M6 14h12v7H6z"/>',
  'edit': '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  'eye': '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M3 3l18 18"/><path d="M10.6 10.6a3 3 0 0 0 4.2 4.2"/><path d="M9.9 5.1A9 9 0 0 1 12 5c5 0 9 4 9 7a13 13 0 0 1-1.7 2.8"/><path d="M6.1 6.1A13 13 0 0 0 3 12c0 1.5 3.4 7 9 7a9 9 0 0 0 3-.5"/>',
  'compass': '<circle cx="12" cy="12" r="9"/><path d="M16 8l-2 6-6 2 2-6z"/>',
  'skip-start': '<path d="M19 5L9 12l10 7z"/><path d="M5 5v14"/>',
  'skip-end': '<path d="M5 5l10 7-10 7z"/><path d="M19 5v14"/>',
  'maximize': '<path d="M8 4H6a2 2 0 0 0-2 2v2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M16 20h2a2 2 0 0 0 2-2v-2"/>',
  'pause': '<rect x="8" y="5" width="3" height="14" rx="1"/><rect x="13" y="5" width="3" height="14" rx="1"/>',
  'stop': '<path d="M8 3H16L21 8V16L16 21H8L3 16V8Z"/>',
  'github': '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-1.5 6-6a4.6 4.6 0 0 0-1-3.5 4.2 4.2 0 0 0-.1-3.5S17.5 1 14 3.5a13.4 13.4 0 0 0-8 0C2.5 1 1.6 1.5 1.6 1.5A4.2 4.2 0 0 0 1.5 5a4.6 4.6 0 0 0-1 3.5c0 4.5 3 6 6 6a4.8 4.8 0 0 0-1 3.5v4"/><path d="M9 18c-4.5 2-5-2-7-2"/>',
  'circle-dot': '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5"/>',
  'tag': '<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z"/><circle cx="7" cy="7" r="1"/>'
}

// Glyph (Unicode/emoji) icons rendered as a styled <span>, complementing the
// SVG catalog above. A few items whose best visual is a symbol (e.g. the gear
// used for the Settings/Preferences entry) match the configuration modal
// header. iconSvg()/iconHtml() branch on this map before the SVG path catalog.
const MENU_GLYPHS = {
  'gear': '&#9881;&#xFE0E;'
};

function glyphIconClass(danger) {
  return 'menu-ico menu-ico-glyph' + (danger ? ' menu-ico-danger' : '');
};

// Label text (any language) → icon name, built once at load. Counts and
// trailing parentheticals are stripped so "Restaurar ocultos (3)" still
// resolves to the base entry.
const LABEL_TO_ICON = (() => {
  const map = {};
  ['en', 'es'].forEach(l => {
    const t = I18N[l];
    if (!t) return;
    Object.keys(MENU_ICON_BY_I18N).forEach(k => {
      const v = t[k];
      if (v) map[normalizeMenuLabel(v)] = MENU_ICON_BY_I18N[k];
    });
  });
  return map;
})();

function normalizeMenuLabel(s) {
  return String(s).replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function iconNameForLabel(label) {
  if (!label) return null;
  return LABEL_TO_ICON[normalizeMenuLabel(label)] || null;
}

function iconNameForItem(item) {
  if (item.icon) return item.icon;
  return iconNameForLabel(item.label);
}

function iconSvg(name, danger) {
  const glyph = name && MENU_GLYPHS[name];
  if (glyph) {
    const span = document.createElement('span');
    span.className = glyphIconClass(danger);
    span.setAttribute('aria-hidden', 'true');
    span.innerHTML = glyph;
    return span;
  }
  const inner = name && MENU_ICONS[name];
  if (!inner) return null;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'menu-ico' + (danger ? ' menu-ico-danger' : ''));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = inner;
  return svg;
}

function iconHtml(name, danger) {
  const glyph = name && MENU_GLYPHS[name];
  if (glyph) {
    return '<span class="' + glyphIconClass(danger) + '" aria-hidden="true">' + glyph + '</span>';
  }
  const inner = name && MENU_ICONS[name];
  if (!inner) return '';
  return '<svg class="menu-ico' + (danger ? ' menu-ico-danger' : '') +
    '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>';
}

// Resolve the icon element for a dynamic context-menu item.
function iconForItem(item) {
  const name = iconNameForItem(item);
  if (!name) return null;
  return iconSvg(name, item.danger || name === 'quit');
}

function isCloseToTrayEnabled() {
  return !!(state.settings && state.settings.app && state.settings.app.closeToTray);
}

/** Close-window menu: hide to tray → Close + X; otherwise Exit + power icon. */
function windowCloseMenuSpec() {
  if (isCloseToTrayEnabled()) {
    return { key: 'menu_close_app', icon: 'x', danger: false };
  }
  return { key: 'menu_quit', icon: 'quit', danger: true };
}

function syncWindowCloseMenuItem() {
  const btn = document.querySelector('#main-menu [data-action="quit"]');
  if (!btn) return;
  const spec = windowCloseMenuSpec();
  btn.classList.toggle('danger', spec.danger);
  const lbl = btn.querySelector('.menu-label');
  if (lbl) {
    lbl.dataset.i18n = spec.key;
    const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
    const t = (I18N[lang] && I18N[lang][spec.key]) || (I18N.en && I18N.en[spec.key]) || '';
    if (t) lbl.textContent = t;
  }
  const oldIco = btn.querySelector(':scope > .menu-ico');
  if (oldIco) oldIco.remove();
  const svg = iconSvg(spec.icon, spec.danger);
  if (svg) {
    btn.insertBefore(svg, btn.querySelector(':scope > .menu-check') || lbl);
  }
}

// Decorate the static burger menu items and categories with leading icons,
// derived from each label's data-i18n key. Idempotent → safe to call once.
function decorateMenuIcons(root) {
  if (!root) return;
  root.querySelectorAll('.menu-cat > .menu-label, .menu-item > .menu-label').forEach(lbl => {
    const host = lbl.parentNode;
    if (!host || host.querySelector(':scope > .menu-ico')) return;
    const name = MENU_ICON_BY_I18N[lbl.dataset.i18n];
    if (!name) return;
    const danger = host.classList.contains('danger') || lbl.dataset.i18n === 'menu_quit';
    const svg = iconSvg(name, danger);
    if (svg) host.insertBefore(svg, host.querySelector(':scope > .menu-check') || lbl);
  });
}
// Decorate modal headers (.modal-title) with leading SVG icons so each modal
// header matches its counterpart menu entry. Reuses the shared MENU_ICONS
// catalog (single source of truth): the config gear is the exact same SVG as
// the menu Configuracion gear, and Properties/Resize/Adjust get their
// respective icons. Idempotent (innerHTML reset on each call).
function decorateModalHeaderIcons() {
  document.querySelectorAll('.modal-header-icon[data-modal-icon]').forEach(slot => {
    const html = iconHtml(slot.dataset.modalIcon);
    if (html) slot.innerHTML = html;
  });
}
decorateModalHeaderIcons();

function updateLanguage(lang = 'en') {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n;
    if (I18N[lang] && I18N[lang][key] !== undefined) {
      if (I18N[lang][key].includes('<')) {
        el.innerHTML = I18N[lang][key];
      } else {
        el.textContent = I18N[lang][key];
      }
    }
  });

  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.dataset.i18nTitle;
    if (I18N[lang] && I18N[lang][key] !== undefined) {
      setCyberTooltip(el, I18N[lang][key]);
    }
  });

  document.querySelectorAll('[data-i18n-aria]').forEach(el => {
    const key = el.dataset.i18nAria;
    if (I18N[lang] && I18N[lang][key] !== undefined) {
      el.setAttribute('aria-label', I18N[lang][key]);
    }
  });

  document.querySelectorAll('[data-i18n-tooltip]').forEach(el => {
    const key = el.dataset.i18nTooltip;
    if (I18N[lang] && I18N[lang][key] !== undefined) {
      el.setAttribute('data-tooltip', I18N[lang][key]);
    }
  });

  document.querySelectorAll('[data-i18n-alt]').forEach(el => {
    const key = el.dataset.i18nAlt;
    if (I18N[lang] && I18N[lang][key] !== undefined) {
      el.setAttribute('alt', I18N[lang][key]);
    }
  });
  if (typeof syncFavoritesToggleButtonState === 'function') {
    syncFavoritesToggleButtonState(lang);
  }
  if (typeof updateSidebarFolderHeader === 'function') {
    updateSidebarFolderHeader();
  }
  if (typeof syncSidebarHandleTooltip === 'function') {
    syncSidebarHandleTooltip();
  }
  if (typeof syncWindowCloseMenuItem === 'function') {
    syncWindowCloseMenuItem();
  }
}

function closeImage() {
  if (typeof stopSlideshow === 'function') stopSlideshow({ silent: true });
  state.scanInProgress = false;
  state.images.forEach(im => {
    if (im.url && String(im.url).startsWith('blob:')) URL.revokeObjectURL(im.url);
  });
  state.preloadCache.clear();
  thumbLoadInflight.clear();
  state.mainImageReady = Promise.resolve();
  state.mainImageReadyIdx = -1;
  state.images = [];
  syncCurrentIndex(-1);
  state.viewMode = 'fit';
  state.selectedViewMode = 'fit';
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.currentRotation = 0; state.visualRotation = 0;
  state.hasChanges = false;
  exitCropMode(); // clears isCropping, cropState + overlay + body.crop-mode

  updateSaveButton();
  updateHUDStates();

  dropZone.style.display = 'flex';

  mainImg.src = '';
  mainImg.classList.remove('loaded', 'slide-in-left', 'slide-in-right', 'slide-out-left', 'slide-out-right');
  mainImg.removeAttribute('src');
  
  canvasL.style.transform = '';
  canvasL.style.transition = '';

  const viewerFilename = $('viewer-filename');
  if (viewerFilename) {
    viewerFilename.textContent = '';
    viewerFilename.removeAttribute('data-tooltip');
    viewerFilename.classList.remove('cyber-tooltip', 'tooltip-bottom');
  }

  buildSidebar();
  updateCounter();
  updateFileStats();

  const radarPct = $('radar-pct');
  if (radarPct) radarPct.textContent = '0%';
  const radarCount = $('radar-count');
  if (radarCount) radarCount.textContent = ' [0/0] ';

  zoomVal.textContent = '100%';
  const zoomPct = $('zoom-pct');
  if (zoomPct) zoomPct.textContent = '100%';
  const zoomSlider = $('zoom-slider');
  if (zoomSlider) zoomSlider.value = 500;

  updateFavButtonState();
  syncEmptyState();
}

// ── FILE HANDLING ──
function loadFiles(files, initialIdx = 0) {
  // Cancelar cualquier scan previo antes de reemplazar datos
  state.scanInProgress = false;
  if (state.showingFavs) {
    state.showingFavs = false;
    if (typeof syncFavoritesToggleButtonState === 'function') {
      syncFavoritesToggleButtonState();
    }
  }
  const allowedExts = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'tiff', 'tif', 'ico']);
  const imgs = Array.from(files).filter(f => {
    if (f.type && f.type.startsWith('image/')) return true;
    const ext = (f.name && f.name.split('.').pop() || '').toLowerCase();
    return allowedExts.has(ext);
  });

  if (!imgs.length) {
    console.warn('No se encontraron imágenes válidas.');
    return;
  }

  // Revoke old blob URLs; drop preload entries for the previous folder
  state.images.forEach(im => {
    if (im.url && String(im.url).startsWith('blob:')) URL.revokeObjectURL(im.url);
  });
  state.preloadCache.clear();
  thumbLoadInflight.clear();
  state.images = imgs.map(f => ({
    file: f,
    url: null,
    thumbUrl: null,
    w: 0,
    h: 0,
    loaded: false,
    // File API uses .size; scan-folder returns size on the plain object
    size: (f && (f.size || f.size === 0)) ? f.size : 0
  }));

  const pathsToAllow = state.images.map(im => im.file && im.file.path).filter(Boolean);
  const finishLoad = () => {
    syncCurrentIndex(initialIdx);
    console.log('Archivos cargados:', state.images.length);
    dropZone.style.display = 'none';
    syncEmptyState();
    buildSidebar();
    // Main image first; thumbs after it paints (avoids large-folder decode thrash)
    showImage(initialIdx, null, true);
    // Kick the active thumb immediately with priority (does not wait for full paint)
    schedulePriorityThumb(initialIdx);
    const ready = state.mainImageReady || Promise.resolve();
    ready.then(() => {
      if (state.currentIdx === initialIdx || state.current === initialIdx) {
        startBackgroundScan();
      }
    });
  };

  if (isElectron && pathsToAllow.length && window.electronAPI.registerPaths) {
    // The opener (open-file / dialog / folder-resolve) already allowlisted the parent
    // directory in main, so cvlocal can serve these paths immediately. Show the image
    // now and widen the allowlist for siblings in the background (non-blocking).
    finishLoad();
    window.electronAPI.registerPaths(pathsToAllow).catch(() => { /* ignore */ });
  } else {
    finishLoad();
  }
}

/**
 * Merge background-scanned siblings into the already-displayed single image WITHOUT
 * re-showing the main image. The opened image's entry object is reused by reference so
 * any in-flight mainImg.onload (from showImage) keeps mutating the live entry and the
 * already-decoded image is never fetched twice. Guards with openSeq so a stale scan
 * (e.g. the user opened another file meanwhile) never clobbers the current state.
 */
function mergeNeighbors(neighbors, filePath, seq) {
  if (!Array.isArray(neighbors) || !neighbors.length) return;

  const files = neighbors.map(p => {
    const name = p.path.split(/[\\/]/).pop();
    return { name, path: p.path, size: p.size, type: '' };
  });

  const norm = String(filePath).toLowerCase();
  const targetIdx = neighbors.findIndex(p => p.path.toLowerCase() === norm);
  if (targetIdx === -1) return; // opened file no longer in folder — keep provisional view

  // Reuse the live entry for the opened image so the in-flight onload closure still
  // updates the same object (loaded/w/h land on the entry that ends up in state.images).
  const cur = state.images[state.currentIdx];
  const keepLoaded = !!cur && !!cur.file && cur.file.path &&
    cur.file.path.toLowerCase() === norm;

  state.images = files.map(f => {
    if (keepLoaded && f.path.toLowerCase() === norm) {
      cur.file = f;            // now carries the real on-disk size from the scan
      cur.size = (f.size || f.size === 0) ? f.size : cur.size;
      return cur;             // same object the provisional showImage closure captured
    }
    return {
      file: f,
      url: null,
      thumbUrl: null,
      w: 0,
      h: 0,
      loaded: false,
      size: (f.size || f.size === 0) ? f.size : 0
    };
  });

  syncCurrentIndex(targetIdx);
  buildSidebar();
  updateSidebarActive();
  updateCounter();
  updateFileStats();
  schedulePriorityThumb(targetIdx);

  // finishLoad skipped its background thumb scan (currentIdx != initialIdx after merge),
  // so kick it here for the now-complete neighbor list.
  const ready = state.mainImageReady || Promise.resolve();
  ready.then(() => {
    if (seq === state.openSeq && state.currentIdx === targetIdx && state.sidebarOpen) {
      startBackgroundScan();
    }
  }).catch(() => { /* ignore */ });
}

function getRecentFiles() {
  const list = state.settings && state.settings.app && state.settings.app.recentFiles;
  return Array.isArray(list) ? list : [];
}

function getRecentFolders() {
  const list = state.settings && state.settings.app && state.settings.app.recentFolders;
  return Array.isArray(list) ? list : [];
}

function fileNameFromPath(filePath) {
  if (!filePath) return '';
  const parts = String(filePath).replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function ensureAppSettings() {
  if (!state.settings) state.settings = { app: {} };
  if (!state.settings.app) state.settings.app = {};
  return state.settings.app;
}

function persistAppSettings() {
  if (isElectron && window.electronAPI.saveSettings && state.settings && state.settings.app) {
    window.electronAPI.saveSettings(state.settings.app);
  }
}

/** Open sidebar if closed so folder thumbs + scan are visible. */
function ensureSidebarOpen() {
  if (!state.sidebarOpen && typeof setSidebarOpen === 'function') {
    setSidebarOpen(true);
  }
}

/** Record an opened image path (MRU). Skips blob/clipboard-only entries. */
function pushRecentFile(filePath) {
  if (!filePath || typeof filePath !== 'string') return;
  if (filePath.startsWith('blob:') || filePath.startsWith('data:')) return;
  const app = ensureAppSettings();
  const norm = filePath;
  const prev = getRecentFiles().filter((p) => p && typeof p === 'string' && p.toLowerCase() !== norm.toLowerCase());
  app.recentFiles = [norm, ...prev].slice(0, RECENT_MAX);
  persistAppSettings();
}

/** Record an opened folder path (MRU). */
function pushRecentFolder(dirPath) {
  if (!dirPath || typeof dirPath !== 'string') return;
  if (dirPath.startsWith('blob:') || dirPath.startsWith('data:')) return;
  const app = ensureAppSettings();
  const norm = dirPath.replace(/[\\/]+$/, '');
  const prev = getRecentFolders().filter((p) => p && typeof p === 'string' && p.toLowerCase() !== norm.toLowerCase());
  app.recentFolders = [norm, ...prev].slice(0, RECENT_MAX);
  persistAppSettings();
}

function clearRecentFiles() {
  const app = ensureAppSettings();
  app.recentFiles = [];
  persistAppSettings();
  const lang = app.language || 'en';
  if (typeof showToast === 'function') {
    showToast((I18N[lang] && I18N[lang].toast_recent_cleared) || 'RECENT LIST CLEARED', 'info');
  }
}

function clearRecentFolders() {
  const app = ensureAppSettings();
  app.recentFolders = [];
  persistAppSettings();
  const lang = app.language || 'en';
  if (typeof showToast === 'function') {
    showToast((I18N[lang] && I18N[lang].toast_recent_folders_cleared) || 'RECENT FOLDERS CLEARED', 'info');
  }
}

function removeRecentFile(filePath) {
  if (!filePath || !state.settings || !state.settings.app) return;
  const key = String(filePath).toLowerCase();
  state.settings.app.recentFiles = getRecentFiles().filter((p) => p && String(p).toLowerCase() !== key);
  persistAppSettings();
}

function removeRecentFolder(dirPath) {
  if (!dirPath || !state.settings || !state.settings.app) return;
  const key = String(dirPath).replace(/[\\/]+$/, '').toLowerCase();
  state.settings.app.recentFolders = getRecentFolders().filter(
    (p) => p && String(p).replace(/[\\/]+$/, '').toLowerCase() !== key
  );
  persistAppSettings();
}

/** User-initiated open of a filesystem image (dialog, OS association, recent, folder). */
async function openImagePath(filePath, opts = {}) {
  if (!filePath) return false;
  const addRecent = opts.addRecent !== false;
  if (addRecent) pushRecentFile(filePath);
  if (opts.openSidebar) ensureSidebarOpen();

  // Browser opens File objects via the file input; a string filePath only arrives
  // from Electron (open-file / dialog / recent / folder). Guard defensively.
  if (!isElectron) return true;

  // Show the opened image immediately: its parent directory was already allowlisted
  // by the main process on open-file, so cvlocal serves it without waiting on the
  // folder scan. Siblings are merged in afterwards WITHOUT re-showing the main image.
  const seq = ++state.openSeq;
  const provName = fileNameFromPath(filePath);
  loadFiles([{ name: provName, path: filePath, size: 0, type: '' }], 0);

  try {
    const neighbors = await window.electronAPI.scanFolder(filePath);
    if (seq !== state.openSeq) return true;   // superseded by a newer open
    mergeNeighbors(neighbors, filePath, seq);
  } catch (_) { /* provisional image is already displayed */ }
  return true;
}

/**
 * Load a folder by first image path + optional dir for recents.
 * Opens sidebar so thumbs are usable right away.
 */
async function openFolderResult(res, opts = {}) {
  if (!res || !res.ok || !res.path) return false;
  if (res.dir) pushRecentFolder(res.dir);
  // Always expand sidebar when the user explicitly opens a folder
  if (opts.openSidebar !== false) ensureSidebarOpen();
  await openImagePath(res.path, { addRecent: opts.addRecentFile !== false });
  return true;
}

async function openImageDialog() {
  if (!isElectron || !window.electronAPI.openFile) {
    if (fileInput) fileInput.click();
    return;
  }
  const filePath = await window.electronAPI.openFile();
  if (filePath) await openImagePath(filePath);
}

async function openFolderDialog() {
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en;
  if (!isElectron || !window.electronAPI.openFolder) {
    showToast(t.toast_folder_empty || 'NO IMAGES IN FOLDER', 'warning');
    return;
  }
  const res = await window.electronAPI.openFolder();
  if (!res || res.canceled) return;
  if (!res.ok) {
    if (res.empty) {
      showToast(t.toast_folder_empty || 'NO IMAGES IN FOLDER', 'warning');
    } else {
      showToast((res.error && String(res.error)) || (t.toast_folder_empty || 'ERROR'), 'error');
    }
    return;
  }
  await openFolderResult(res);
}

async function openRecentPath(filePath) {
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en;
  if (!filePath || !isElectron) return;

  try {
    if (window.electronAPI.validatePaths) {
      const valid = await window.electronAPI.validatePaths([filePath]);
      if (!Array.isArray(valid) || !valid.length) {
        removeRecentFile(filePath);
        showToast(t.toast_recent_missing || 'FILE NOT FOUND', 'warning');
        return;
      }
      filePath = valid[0];
    }
    if (window.electronAPI.registerPaths) {
      const reg = await window.electronAPI.registerPaths([filePath]);
      if (!reg || !reg.registered || !reg.registered.length) {
        removeRecentFile(filePath);
        showToast(t.toast_recent_missing || 'FILE NOT FOUND', 'warning');
        return;
      }
      filePath = reg.registered[0];
    }
  } catch (_) {
    removeRecentFile(filePath);
    showToast(t.toast_recent_missing || 'FILE NOT FOUND', 'warning');
    return;
  }

  await openImagePath(filePath);
}

async function openRecentFolder(dirPath) {
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en;
  if (!dirPath || !isElectron || !window.electronAPI.openFolderPath) return;

  const res = await window.electronAPI.openFolderPath(dirPath);
  if (!res || !res.ok) {
    removeRecentFolder(dirPath);
    if (res && res.empty) {
      showToast(t.toast_folder_empty || 'NO IMAGES IN FOLDER', 'warning');
    } else {
      showToast(t.toast_recent_folder_missing || 'FOLDER NOT FOUND', 'warning');
    }
    return;
  }
  await openFolderResult(res);
}

async function startBackgroundScan() {
  const total = state.images.length;
  if (total === 0 || !isElectron) return;

  const seq = state.openSeq;

  // Never compete with the main image decode on open
  if (state.mainImageReady) {
    try { await state.mainImageReady; } catch (_) { /* ignore */ }
  }

  let processed = 0;
  let completedAll = true;
  state.scanInProgress = true;
  let lastProgressPaint = 0;

  // Expand outward from the current index so nearby thumbs warm first
  const start = Math.max(0, state.currentIdx >= 0 ? state.currentIdx : state.current);
  const order = [];
  for (let d = 0; d < total; d++) {
    if (d === 0) {
      order.push(start);
    } else {
      const right = start + d;
      const left = start - d;
      if (right < total) order.push(right);
      if (left >= 0) order.push(left);
    }
  }

  for (const idx of order) {
    if (seq !== state.openSeq || !state.scanInProgress || !state.sidebarOpen) {
      updateThumbProgress(processed, total, true);
      completedAll = false;
      break;
    }

    // Pause/delay background scanning loop when user is actively interacting with the canvas
    let wasPaused = false;
    while (Date.now() - state.lastCanvasInteraction < SCAN_PAUSE_GRACE_MS) {
      if (seq !== state.openSeq || !state.scanInProgress || !state.sidebarOpen) {
        break;
      }
      if (!wasPaused) {
        wasPaused = true;
        const radarEl = $('footer-radar');
        if (radarEl) radarEl.classList.add('paused');
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (wasPaused) {
      const radarEl = $('footer-radar');
      if (radarEl) radarEl.classList.remove('paused');
    }

    const im = state.images[idx];
    if (!im || im.hidden || !im.file?.path) continue;

    if (!im.thumbUrl) {
      try {
        const isCurrent = idx === state.currentIdx || idx === state.current;
        const thumbUrl = await window.electronAPI.getThumbnail(im.file.path, {
          priority: isCurrent
        });
        if (thumbUrl) im.thumbUrl = thumbUrl;
      } catch (_) { /* skip */ }
    }
    processed++;

    // Throttle radar HUD updates (~8/s) to cut layout thrash on large folders
    const now = performance.now();
    if (now - lastProgressPaint > 120 || processed === total) {
      lastProgressPaint = now;
      updateThumbProgress(processed, total);
    }

    const imgEl = sidebar.querySelector(`.thumb-item[data-index="${idx}"] .thumb-static`);
    if (imgEl && im.thumbUrl && imgEl.style.opacity === '0') {
      setSidebarThumbSrc(idx, imgEl);
    }

    // A small polite delay to yield to user UI interaction thread
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  updateThumbProgress(processed, total);
  if (completedAll && seq === state.openSeq) {
    state.scanInProgress = false;
  }
}

// ── SIDEBAR ──
const folderDirFromPath = CVMedia.folderDirFromPath || function (filePath) {
  if (!filePath) return '';
  const norm = String(filePath).replace(/[\\/]+$/, '');
  const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
  return i >= 0 ? norm.slice(0, i) : '';
};

const folderNameFromPath = CVMedia.folderNameFromPath || function (dirPath) {
  if (!dirPath) return '';
  const norm = String(dirPath).replace(/[\\/]+$/, '');
  const parts = norm.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
};

function updateSidebarFolderHeader() {
  const el = $('sidebar-folder');
  const nameEl = $('sidebar-folder-name');
  if (!el || !nameEl) return;

  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en;

  if (state.showingFavs) {
    el.classList.remove('is-empty');
    el.classList.add('is-favs');
    el.setAttribute('aria-hidden', 'false');
    nameEl.textContent = t.sidebar_favorites || 'Favorites';
    setCyberTooltip(el, t.sidebar_favorites || 'Favorites');
    el.classList.add('tooltip-bottom');
    return;
  }

  el.classList.remove('is-favs');

  let filePath = null;
  const cur = state.images[state.currentIdx] || state.images[state.current];
  if (cur && cur.file && cur.file.path) {
    filePath = cur.file.path;
  } else {
    const first = state.images.find((im) => im && !im.hidden && im.file && im.file.path);
    if (first) filePath = first.file.path;
  }

  if (!filePath) {
    el.classList.add('is-empty');
    el.setAttribute('aria-hidden', 'true');
    nameEl.textContent = t.sidebar_folder_empty || '—';
    el.removeAttribute('data-tooltip');
    el.classList.remove('cyber-tooltip', 'tooltip-bottom');
    return;
  }

  const dir = folderDirFromPath(filePath);
  const name = folderNameFromPath(dir) || folderNameFromPath(filePath) || (t.sidebar_folder_empty || '—');
  el.classList.remove('is-empty');
  el.setAttribute('aria-hidden', 'false');
  nameEl.textContent = name;
  setCyberTooltip(el, dir || filePath);
  el.classList.add('tooltip-bottom');
}

function updateCenterBtnVisibility() {
  const navRow = $('sidebar-nav-row');
  const btn = $('btn-center');
  const count = (state.images || []).filter(im => im && !im.hidden).length;
  const hasNavigation = count > 1;
  if (navRow) navRow.style.display = hasNavigation ? '' : 'none';
  if (btn) btn.style.display = hasNavigation ? '' : 'none';
}

function buildSidebar() {
  const container = $('sidebar-inner');
  if (!container) return;
  container.innerHTML = '';

  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const idx = parseInt(entry.target.dataset.index, 10);
        const img = entry.target.querySelector('.thumb-static');
        if (img && img.style.opacity === '0') {
          const isCurrent = idx === state.currentIdx || idx === state.current;
          // Current thumb: priority. Others wait until main image is ready.
          loadThumb(idx, img, { priority: isCurrent });
        }
      }
    });
  }, { root: $('sidebar-scroll'), rootMargin: '400px' });

  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const hasImages = state.images.some(im => !im.hidden);
  const fragment = document.createDocumentFragment();

  if (hasImages) {
    const startIndicator = document.createElement('div');
    startIndicator.className = 'sidebar-boundary-label start';
    startIndicator.textContent = lang === 'es' ? '— INICIO —' : '— START —';
    fragment.appendChild(startIndicator);
  }

  state.images.forEach((im, i) => {
    if (im.hidden) return; // No renderizar si está oculto

    const item = document.createElement('div');
    item.className = 'thumb-item' + (i === state.currentIdx ? ' active' : '');
    item.dataset.index = i;

    const img = document.createElement('img');
    img.className = 'thumb-static';
    img.alt = '';
    img.style.opacity = '0';
    img.style.transition = 'opacity 200ms ease';
    img.draggable = false; // Bloquear drag nativo

    let animatedImg = null;
    if (isGifImage(im)) {
      animatedImg = document.createElement('img');
      animatedImg.className = 'thumb-animated';
      animatedImg.alt = '';
      animatedImg.draggable = false;
    }

    const idx = document.createElement('span');
    idx.className = 'thumb-idx';
    idx.textContent = i + 1;

    item.appendChild(img);
    if (animatedImg) item.appendChild(animatedImg);
    item.appendChild(idx);

    thumbObserver.observe(item);

    item.addEventListener('contextmenu', (e) => {
      showCustomContextMenu(e, 'thumb', { 
        path: im.file.path,
        index: i
      });
    });

    item.addEventListener('click', () => {
      if (state.transitioning) return;
      const dir = i > state.currentIdx ? 'left' : 'right';
      showImage(i, dir);
    });

    item.addEventListener('mouseenter', () => refreshSidebarGifAnimation(i));
    item.addEventListener('mouseleave', () => refreshSidebarGifAnimation(i));

    fragment.appendChild(item);
  });

  if (hasImages) {
    const endIndicator = document.createElement('div');
    endIndicator.className = 'sidebar-boundary-label end';
    endIndicator.textContent = lang === 'es' ? '— FIN —' : '— END —';
    fragment.appendChild(endIndicator);
  }

  container.appendChild(fragment);
  updateNavVisibility();
  updateSidebarFolderHeader();
  updateCenterBtnVisibility();
}

// ── CONTEXT MENU ──
window.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, textarea, [contenteditable="true"]')) return;
  
  e.preventDefault();
  if (state.currentRotation !== 0 && state.hasChanges) return;

  if (e.target.closest('.thumb-item')) return;
  if (e.target.closest('#kbd-hint')) return; // Evitar menú en HUD
  if (e.target.closest('#topbar')) return;    // Evitar menú en barra de título
  if (e.target.closest('#sidebar')) return;   // Evitar menú en barra lateral

  // During an active slideshow, show a presentation-only context menu.
  if (state.slideshowActive) {
    showCustomContextMenu(e, 'slideshow', {});
    return;
  }

  const isInsideViewer = e.target.closest('#viewer-wrap');
  if (isInsideViewer && state.images.length > 0) {
    const rect = mainImg.getBoundingClientRect();
    const onImage = (
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    );
    if (onImage) {
      showCustomContextMenu(e, 'image', { 
        path: state.images[state.currentIdx]?.file?.path || null,
        index: state.currentIdx
      });
    } else {
      showCustomContextMenu(e, 'canvas', { 
        path: state.images[state.currentIdx]?.file?.path || null
      });
    }
  } else {
    showCustomContextMenu(e, 'canvas', {
      path: null
    });
  }
});

function hideInterfaceMenus() {
  const mainMenu = $('main-menu');
  const btnMenu = $('btn-menu');
  if (mainMenu) mainMenu.classList.remove('open');
  if (btnMenu) btnMenu.classList.remove('open');
  hideCustomContextMenu();
}

document.addEventListener('visibilitychange', () => { if (document.hidden) hideInterfaceMenus(); });
window.addEventListener('blur', hideInterfaceMenus);
window.addEventListener('cv-window-blur', hideInterfaceMenus);

function showCustomContextMenu(e, type, data) {
  e.preventDefault();
  e.stopPropagation();

  // Close main/burger menu if open
  const mainMenu = $('main-menu');
  const btnMenu = $('btn-menu');
  if (mainMenu && mainMenu.classList.contains('open')) {
    mainMenu.classList.remove('open');
    if (btnMenu) btnMenu.classList.remove('open');
  }

  // Clear context-active highlight from any previously right-clicked thumbnails
  sidebar.querySelectorAll('.thumb-item.context-active').forEach(el => el.classList.remove('context-active'));

  // Add highlight to current thumbnail if applicable
  if (type === 'thumb') {
    const thumbItem = e.target.closest('.thumb-item');
    if (thumbItem) {
      thumbItem.classList.add('context-active');
    }
  }

  const menu = $('custom-ctx-menu');
  if (!menu) return;

  menu.innerHTML = '';
  menu.className = 'menu-panel context-menu-panel';

  const template = buildMenuTemplate(type, data);
  if (!template || template.length === 0) return;

  renderMenuTemplate(menu, template);

  menu.style.display = 'block';
  menu.style.visibility = 'hidden';

  const menuW = menu.offsetWidth;
  const menuH = menu.offsetHeight;

  let x = e.clientX;
  let y = e.clientY;

  const winW = window.innerWidth;
  const winH = window.innerHeight;

  if (x + menuW > winW) {
    x = winW - menuW - 10;
  }
  if (y + menuH > winH) {
    y = winH - menuH - 10;
  }
  
  x = Math.max(10, x);
  y = Math.max(10, y);

  const submenuW = 216;
  if (x + menuW + submenuW > winW) {
    menu.classList.add('open-left');
  }

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  menu.style.visibility = 'visible';
  menu.classList.add('open');

  const closeListener = (evt) => {
    if (!menu.contains(evt.target)) {
      hideCustomContextMenu();
      document.removeEventListener('pointerdown', closeListener);
      document.removeEventListener('contextmenu', closeListener);
    }
  };
  
  setTimeout(() => {
    document.addEventListener('pointerdown', closeListener);
    document.addEventListener('contextmenu', closeListener);
  }, 50);
}

function hideCustomContextMenu() {
  const menu = $('custom-ctx-menu');
  if (menu) {
    menu.style.display = 'none';
    menu.classList.remove('open');
  }
  sidebar.querySelectorAll('.thumb-item.context-active').forEach(el => el.classList.remove('context-active'));
}

function buildMenuTemplate(type, data) {
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const getTxt = (key, count) => {
    let t = I18N[lang][key] || I18N.en[key] || '';
    if (count !== undefined) t = t.replace('{count}', count);
    return t;
  };

  const hasImages = state.images.length > 0;
  const isFav = hasImages && state.settings.app.favorites && state.images[state.currentIdx]?.file?.path && state.settings.app.favorites.includes(state.images[state.currentIdx].file.path);

  if (type === 'thumb') {
    const hiddenCount = state.images.filter(im => im.hidden).length;
    const isFavThumb = !!(state.settings.app.favorites && data.path && state.settings.app.favorites.includes(data.path));
    return [
      {
        label: getTxt('menu_file'),
        isSub: true,
        items: [
          {
            label: getTxt('menu_copy'),
            action: () => window.electronAPI.copyImage(data.path)
          },
          {
            label: getTxt('menu_show'),
            action: () => window.electronAPI.showItemInFolder(data.path)
          },
          {
            label: getTxt('menu_copy_path'),
            enabled: !!data.path,
            visible: !!data.path,
            action: () => {
              if (data.path) {
                navigator.clipboard.writeText(data.path);
                const _lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
                showToast(_lang === 'es' ? 'RUTA COPIADA' : 'PATH COPIED', 'success');
              }
            }
          },
          {
            label: getTxt('menu_props'),
            enabled: !!data.path,
            visible: !!data.path,
            action: () => showPropertiesPanel(data.path)
          }
        ]
      },
      {
        label: getTxt('menu_go'),
        isSub: true,
        items: [
          {
            label: getTxt('menu_go_start'),
            action: () => goToBoundary('start')
          },
          {
            label: getTxt('menu_go_end'),
            action: () => goToBoundary('end')
          },
          { type: 'separator' },
          {
            label: isFavThumb ? getTxt('favorite_remove') : getTxt('favorite_add'),
            icon: 'star',
            action: () => toggleFavoritePath(data.path)
          }
        ]
      },
      { type: 'separator' },
      {
        label: getTxt('menu_hide_session'),
        action: () => executeAction({ action: 'remove-from-list', index: data.index })
      },
      {
        label: getTxt('menu_restore_hidden', hiddenCount),
        enabled: hiddenCount > 0,
        visible: hiddenCount > 0,
        action: () => executeAction({ action: 'restore-hidden' })
      },
      { type: 'separator' },
      {
        label: getTxt('menu_trash'),
        shortcut: 'Del',
        danger: true,
        action: () => executeAction({ action: 'request-delete', index: data.index, path: data.path })
      }
    ];
  } else if (type === 'image') {
    const hiddenCount = state.images.filter(im => im.hidden).length;
    return [
      {
        label: getTxt('menu_save_as'),
        action: () => showSaveAsDialog(data.path)
      },
      {
        label: getTxt('menu_close_image'),
        action: () => closeImage()
      },
      { type: 'separator' },
      {
        label: getTxt('menu_edit'),
        isSub: true,
        items: [
          {
            label: getTxt('menu_rotate_r'),
            shortcut: 'E',
            action: () => rotate(90)
          },
          {
            label: getTxt('menu_rotate_l'),
            shortcut: 'Q',
            action: () => rotate(-90)
          },
          { type: 'separator' },
          {
            label: getTxt('menu_crop'),
            shortcut: 'C',
            action: () => $('btn-crop').click()
          },
          {
            label: getTxt('menu_resize'),
            shortcut: 'R',
            action: () => $('btn-resize').click()
          },
          {
            label: getTxt('menu_adjust'),
            shortcut: 'J',
            action: () => { const b = $('btn-adjust'); if (b) b.click(); }
          },
          { type: 'separator' },
          {
            label: getTxt('menu_flip_h'),
            shortcut: 'H',
            action: () => flipImage('h')
          },
          {
            label: getTxt('menu_flip_v'),
            shortcut: 'Shift+H',
            action: () => flipImage('v')
          },
          { type: 'separator' },
          {
            label: isFav ? getTxt('favorite_remove') : getTxt('favorite_add'),
            shortcut: 'Ctrl+D',
            action: () => toggleFavorite()
          }
        ]
      },
      {
        label: getTxt('menu_go'),
        isSub: true,
        items: [
          {
            label: getTxt('menu_next'),
            shortcut: 'D',
            action: () => next()
          },
          {
            label: getTxt('menu_prev'),
            shortcut: 'A',
            action: () => prev()
          },
          { type: 'separator' },
          {
            label: getTxt('menu_go_start'),
            action: () => goToBoundary('start')
          },
          {
            label: getTxt('menu_go_end'),
            action: () => goToBoundary('end')
          }
        ]
      },
      { type: 'separator' },
      {
        label: getTxt('menu_copy'),
        shortcut: 'Ctrl+C',
        action: () => copyToClipboard()
      },
      {
        label: getTxt('menu_copy_path'),
        enabled: !!data.path,
        visible: !!data.path,
        action: () => {
          if (data.path) {
            navigator.clipboard.writeText(data.path);
            showToast(lang === 'es' ? 'RUTA COPIADA' : 'PATH COPIED', 'success');
          }
        }
      },
      {
        label: getTxt('menu_paste'),
        shortcut: 'Ctrl+V',
        action: () => pasteFromClipboard()
      },
      {
        label: getTxt('menu_trash'),
        shortcut: 'Del',
        danger: true,
        action: () => executeAction({ action: 'request-delete', index: data.index, path: data.path })
      },
      { type: 'separator' },
      {
        label: getTxt('menu_open_containing_folder'),
        enabled: !!data.path,
        visible: !!data.path,
        action: () => window.electronAPI.openContainingFolder(data.path)
      },
      {
        label: getTxt('menu_props'),
        shortcut: 'Ctrl+I',
        action: () => showPropertiesPanel(data.path)
      },
      {
        label: getTxt('menu_restore_hidden', hiddenCount),
        enabled: hiddenCount > 0,
        visible: hiddenCount > 0,
        action: () => executeAction({ action: 'restore-hidden' })
      }
    ];
  } else if (type === 'slideshow') {
    // Presentation (slideshow) context menu — only useful controls while presenting
    const intervalSec = (getSlideshowIntervalMs() / 1000) + 's';
    return [
      {
        label: state.slideshowPlaying ? getTxt('menu_slideshow_pause') : getTxt('menu_slideshow_resume'),
        shortcut: 'Space',
        action: () => toggleSlideshowPlay()
      },
      { type: 'separator' },
      {
        label: getTxt('menu_prev'),
        shortcut: 'A',
        action: () => slideshowAdvance(-1)
      },
      {
        label: getTxt('menu_next'),
        shortcut: 'D',
        action: () => slideshowAdvance(1)
      },
      { type: 'separator' },
      {
        label: getTxt('menu_slideshow_loop'),
        type: 'checkbox',
        checked: isSlideshowLoop(),
        action: () => toggleSlideshowLoop()
      },
      {
        label: getTxt('menu_slideshow_interval'),
        shortcut: intervalSec,
        action: () => cycleSlideshowInterval()
      },
      { type: 'separator' },
      {
        label: getTxt('menu_slideshow_stop'),
        shortcut: 'Esc',
        action: () => stopSlideshow({ keepFullscreen: true })
      },
      {
        label: getTxt('menu_slideshow_exit'),
        icon: 'quit',
        danger: true,
        action: () => stopSlideshow()
      }
    ];
  } else {
    // Canvas / empty-state context menu
    const tMenu = I18N[lang] || I18N.en;
    const closeSpec = windowCloseMenuSpec();
    return [
      ...buildOpenFileContextItems(tMenu),
      { type: 'separator' },
      {
        label: getTxt('menu_paste'),
        shortcut: 'Ctrl+V',
        action: () => pasteFromClipboard()
      },
      { type: 'separator' },
      {
        label: getTxt('menu_view'),
        isSub: true,
        items: [
          {
            label: getTxt('menu_fit'),
            shortcut: 'F',
            enabled: hasImages,
            action: () => { const b = $('btn-fit-hud'); if (b) b.click(); }
          },
          {
            label: getTxt('menu_original'),
            shortcut: '1',
            enabled: hasImages,
            action: () => { const b = $('btn-orig-hud'); if (b) b.click(); }
          },
          {
            label: getTxt('menu_fullscreen'),
            shortcut: 'Enter',
            enabled: hasImages,
            action: () => { const b = $('btn-fs-hud'); if (b) b.click(); }
          },
          { type: 'separator' },
          {
            label: getTxt('menu_toolbar'),
            type: 'checkbox',
            checked: state.toolbarOpen !== false,
            action: () => setToolbarOpen(!(state.toolbarOpen !== false))
          },
          {
            label: getTxt('menu_autohide_nav'),
            type: 'checkbox',
            checked: state.settings.app.navAutoHide !== false,
            action: () => {
              state.settings.app.navAutoHide = !state.settings.app.navAutoHide;
              if (isElectron) window.electronAPI.saveSettings(state.settings.app);
              applySettings();
              resetHudTimer();
            }
          },
          {
            label: getTxt('menu_show_hints'),
            type: 'checkbox',
            checked: state.settings.app.showTopHints !== false,
            action: () => {
              state.settings.app.showTopHints = (state.settings.app.showTopHints !== false) ? false : true;
              if (isElectron) window.electronAPI.saveSettings(state.settings.app);
              applySettings();
            }
          }
        ]
      },
      {
        label: getTxt('menu_slideshow'),
        isSub: true,
        items: [
          {
            label: getTxt('menu_slideshow_start'),
            shortcut: 'S',
            enabled: hasImages,
            action: () => startSlideshow()
          },
          { type: 'separator' },
          {
            label: getTxt('menu_slideshow_loop'),
            type: 'checkbox',
            checked: state.settings.app.slideshowLoop !== false,
            enabled: hasImages,
            action: () => toggleSlideshowLoop()
          },
          {
            label: getTxt('menu_slideshow_interval'),
            enabled: hasImages,
            action: () => cycleSlideshowInterval()
          }
        ]
      },
      { type: 'separator' },
      {
        label: getTxt('config'),
        action: () => openConfig()
      },
      {
        label: getTxt('about'),
        action: () => {
          if (typeof window.openAbout === 'function') window.openAbout();
          else if ($('btn-about')) $('btn-about').click();
        }
      },
      { type: 'separator' },
      {
        label: getTxt(closeSpec.key),
        icon: closeSpec.icon,
        danger: closeSpec.danger,
        action: () => window.electronAPI.close()
      }
    ];
  }
}

function renderMenuTemplate(container, template) {
  template.forEach(item => {
    if (item.type === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'menu-divider';
      container.appendChild(sep);
      return;
    }

    if (item.visible === false) return;

    if (item.isSub) {
      const cat = document.createElement('div');
      cat.className = 'menu-cat';
      cat.setAttribute('data-sub', '');
      if (item.enabled === false) cat.classList.add('disabled');

      const subIcon = iconForItem(item);
      if (subIcon) cat.appendChild(subIcon);

      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = item.label;
      cat.appendChild(label);

      const arrow = document.createElement('span');
      arrow.className = 'menu-arrow';
      arrow.innerHTML = '&#8250;';
      cat.appendChild(arrow);

      const sub = document.createElement('div');
      sub.className = 'menu-sub menu-recent-sub';
      renderMenuTemplate(sub, item.items || []);
      cat.appendChild(sub);

      cat.addEventListener('mouseenter', () => {
        if (item.enabled === false) return;
        sub.style.top = '';
        sub.style.left = '';
        sub.style.right = '';
        
        let rect = sub.getBoundingClientRect();
        const winH = window.innerHeight;
        if (rect.bottom > winH) {
          const parentRect = cat.getBoundingClientRect();
          let topVal = winH - 10 - parentRect.top - rect.height;
          if (parentRect.top + topVal < 10) {
            topVal = 10 - parentRect.top;
          }
          sub.style.top = topVal + 'px';
        }
        
        rect = sub.getBoundingClientRect();
        const winW = window.innerWidth;
        if (rect.right > winW) {
          sub.style.left = 'auto';
          sub.style.right = 'calc(100% + 4px)';
        } else if (rect.left < 0) {
          sub.style.left = 'calc(100% + 4px)';
          sub.style.right = 'auto';
        }
      });

      container.appendChild(cat);
    } else {
      const btn = document.createElement('button');
      btn.className = 'menu-item';
      if (item.enabled === false) {
        btn.classList.add('disabled');
        btn.classList.add('menu-recent-empty');
      }
      if (item.recent) btn.classList.add('menu-recent-item');
      if (item.type === 'checkbox') {
        const check = document.createElement('span');
        check.className = 'menu-check';
        check.innerHTML = '&#10003;';
        btn.appendChild(check);
        if (item.checked) btn.classList.add('checked');
      }

      const label = document.createElement('span');
      label.className = 'menu-label';
      label.textContent = item.label;
      btn.appendChild(label);
      if (item.title) btn.title = item.title;

      if (item.shortcut) {
        const shortcut = document.createElement('span');
        shortcut.className = 'menu-shortcut';
        shortcut.textContent = item.shortcut;
        btn.appendChild(shortcut);
      }

      if (item.danger) {
        btn.classList.add('danger');
      }

      const itemIcon = iconForItem(item);
      if (itemIcon) btn.insertBefore(itemIcon, btn.firstChild);

      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.enabled === false) return;
        hideCustomContextMenu();
        if (item.action) item.action();
      });

      container.appendChild(btn);
    }
  });
}

/** Compact recent lists for context menus (top N). */
function buildRecentContextItems(kind, t) {
  const isFolder = kind === 'folder';
  const all = isFolder ? getRecentFolders() : getRecentFiles();
  const list = all.slice(0, RECENT_CTX_MAX);
  if (!list.length) {
    return [{
      label: isFolder
        ? (t.menu_recent_folders_empty || 'No recent folders')
        : (t.menu_recent_empty || 'No recent images'),
      icon: isFolder ? 'folder' : 'image',
      enabled: false
    }];
  }
  return list.map((entryPath) => ({
    label: fileNameFromPath(entryPath),
    title: entryPath,
    icon: isFolder ? 'folder' : 'image',
    recent: true,
    action: () => {
      if (isFolder) openRecentFolder(entryPath);
      else openRecentPath(entryPath);
    }
  }));
}

/** Shared File-open block for canvas / empty context menus. */
function buildOpenFileContextItems(t) {
  return [
    {
      label: t.menu_open || 'Open image',
      shortcut: 'Ctrl+O',
      action: () => openImageDialog()
    },
    {
      label: t.menu_open_folder || 'Open folder',
      shortcut: 'Ctrl+Shift+F',
      action: () => openFolderDialog()
    },
    { type: 'separator' },
    {
      label: t.menu_recent || 'Recent images',
      isSub: true,
      items: buildRecentContextItems('file', t)
    },
    {
      label: t.menu_recent_folders || 'Recent folders',
      isSub: true,
      items: buildRecentContextItems('folder', t)
    }
  ];
}

async function showSaveAsDialog(filePath) {
  if (!isElectron) return;
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const im = state.images[state.current];
  const sourcePath = filePath || imageDiskPath(im);
  const sourceName = sourcePath ? sourcePath.split(/[\\/]/).pop() : ((im && im.file && im.file.name) || 'image');
  const baseName = sourceName.replace(/\.[^.]+$/, '') || 'image';
  const defaultName = `${baseName}_copy.png`;
  const t = I18N[lang] || I18N.en || {};

  const result = await window.electronAPI.showSaveDialog({
    title: lang === 'es' ? 'Guardar como' : 'Save As',
    defaultPath: defaultName,
    filters: [
      { name: t.dialog_filter_png || (lang === 'es' ? 'PNG' : 'PNG'), extensions: ['png'] },
      { name: t.dialog_filter_jpeg || (lang === 'es' ? 'JPEG' : 'JPEG'), extensions: ['jpg', 'jpeg'] },
      { name: t.dialog_save_filter_all || (lang === 'es' ? 'Todos los archivos' : 'All Files'), extensions: ['*'] }
    ]
  });
  if (result && !result.canceled && result.filePath) {
    await saveAsPath(/\.[^\\/]+$/.test(result.filePath) ? result.filePath : result.filePath + '.png');
  }
}

function executeAction(data) {
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  switch (data.action) {
    case 'remove-from-list':
      if (data.index !== undefined) {
        const removed = state.images[data.index];
        removed.hidden = true;
        
        const visible = state.images.filter(im => !im.hidden);
        if (visible.length === 0) {
          window.location.reload();
        } else {
          // Buscar siguiente visible
          let next = data.index;
          while(next < state.images.length && state.images[next].hidden) next++;
          if (next >= state.images.length) {
             next = data.index;
             while(next >= 0 && state.images[next].hidden) next--;
          }
          
          buildSidebar();
          showImage(next, null);
          const lang = state.settings.app.language || 'en';
          showToast((I18N[lang].toast_hidden || 'HIDDEN: ') + removed.file.name.toUpperCase());
        }
      }
      break;
    case 'restore-hidden':
      state.images.forEach(im => im.hidden = false);
      buildSidebar();
      showToast(I18N[lang].toast_restored, 'success');
      break;
    case 'go-start':
      goToBoundary('start');
      break;
    case 'go-end':
      goToBoundary('end');
      break;
    case 'request-delete':
      if (data.index !== undefined && data.path) {
        const name = data.path.split(/[\\/]/).pop();
        showCyberConfirm({
          title: lang === 'es' ? 'Mover a la papelera' : 'Move to Trash',
          message: lang === 'es' 
            ? '¿Estás seguro de que quieres mover esta imagen a la papelera de reciclaje?' 
            : 'Are you sure you want to move this image to the Recycle Bin?',
          detail: name,
          danger: true,
          onConfirm: async () => {
            try {
              const result = await window.electronAPI.moveToTrash(data.path);
              if (result && result.success) {
                handleFileDeleted(data.index);
              }
            } catch (err) {
              console.error('Error al mover a la papelera:', err);
            }
          }
        });
      }
      break;
    case 'file-deleted':
      if (data.index !== undefined) {
        handleFileDeleted(data.index);
      }
      break;
    case 'open-dir':
      btnOpen.click();
      break;
    case 'show-config':
      btnConfig.click();
      break;
    case 'toggle-autohide-nav':
      state.settings.app.navAutoHide = !state.settings.app.navAutoHide;
      if (isElectron) {
        window.electronAPI.saveSettings(state.settings.app);
      }
      applySettings();
      resetHudTimer();
      break;
    case 'rotate-r-save':
      rotate(90);
      break;
    case 'rotate-l-save':
      rotate(-90);
      break;
    case 'crop':
      const btnCrop = $('btn-crop');
      if (btnCrop) btnCrop.click();
      break;
    case 'resize':
      const btnResize = $('btn-resize');
      if (btnResize) btnResize.click();
      break;
    case 'adjust': {
      const btnAdjust = $('btn-adjust');
      if (btnAdjust) btnAdjust.click();
      break;
    }
    case 'toggle-favorite':
      toggleFavorite();
      break;
    case 'show-about':
      btnAbout.click();
      break;
    case 'fit-to-window': {
      const im = state.images[state.current];
      if (im && im.w) {
        state.viewMode = 'fit';
        state.selectedViewMode = 'fit';
        fitToWindow(im.w, im.h);
      }
      break;
    }
    case 'reset-zoom': {
      const im = state.images[state.current];
      if (im && im.w) {
        setOriginalView(false);
        updateFileStats();
      }
      break;
    }
    case 'save-changes':
      saveCurrent();
      break;
    case 'save-as':
      if (data.targetPath) {
        saveAsPath(data.targetPath);
      }
      break;
    case 'show-properties':
      showPropertiesPanel(data.path);
      break;
    case 'close-image':
      closeImage();
      break;
    case 'toggle-hints':
      state.settings.app.showTopHints = (state.settings.app.showTopHints !== false) ? false : true;
      if (isElectron) window.electronAPI.saveSettings(state.settings.app);
      applySettings();
      break;
  }
}

  if (isElectron) {
    window.electronAPI.onMenuAction((data) => {
      executeAction(data);
    });
  }

async function saveAsPath(targetPath) {
  if (state.current === -1) return;
  const im = state.images[state.current];
  if (!mainImg.complete || mainImg.naturalWidth === 0) {
    const lang = state.settings.app.language || 'en';
    showToast(I18N[lang].toast_image_not_ready, 'error');
    return;
  }

  const lang = state.settings.app.language || 'en';
  showToast(lang === 'es' ? 'GUARDANDO COPIA...' : 'SAVING COPY...', 'info');

  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const iw = mainImg.naturalWidth;
    const ih = mainImg.naturalHeight;
    const rotation = state.currentRotation;

    if (rotation === 90 || rotation === 270) {
      canvas.width = ih;
      canvas.height = iw;
    } else {
      canvas.width = iw;
      canvas.height = ih;
    }

    const rad = rotation * Math.PI / 180;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(mainImg, -iw / 2, -ih / 2);

    const exported = canvasExport(canvas, targetPath);
    const result = await window.electronAPI.saveImage({
      filePath: exported.filePath,
      buffer: exported.buffer
    });

    if (result.success) {
      const currentPath = imageDiskPath(im);
      const savedPath = result.filePath || exported.filePath;
      if (window.electronAPI.registerPaths) {
        await window.electronAPI.registerPaths([savedPath]);
      }

      if (currentPath) {
        const currentDir = currentPath.substring(0, Math.max(currentPath.lastIndexOf('\\'), currentPath.lastIndexOf('/')));
        const targetDir = savedPath.substring(0, Math.max(savedPath.lastIndexOf('\\'), savedPath.lastIndexOf('/')));

        if (currentDir && targetDir && currentDir.toLowerCase() === targetDir.toLowerCase() &&
            currentPath.toLowerCase() !== savedPath.toLowerCase()) {
          const newImg = {
            file: {
              name: savedPath.split(/[\\/]/).pop(),
              path: savedPath,
              size: 0
            }
          };
          state.images.splice(state.current + 1, 0, newImg);
          buildSidebar();
          showImage(state.current + 1, null);
          showToast(lang === 'es' ? 'COPIA GUARDADA' : 'COPY SAVED', 'success');
          return;
        }
      }

      bindImageToDiskPath(im, savedPath);

      state.currentRotation = 0; state.visualRotation = 0;
      state.hasChanges = false;
      buildSidebar();
      showImage(state.current, null, true);
      showToast(lang === 'es' ? 'IMAGEN GUARDADA' : 'IMAGE SAVED', 'success');
    } else {
      showToast(result.error || 'ERROR', 'error');
    }
  } catch (e) {
    console.error('Error in saveAsPath:', e);
    showToast('ERROR: ' + (e.message || 'Unknown'), 'error');
  }
}

/**
 * Load a sidebar thumbnail.
 * Non-current thumbs wait for mainImageReady so opening a large file is not
 * starved by bulk nativeImage thumb work on a heavy folder.
 * @param {number} i
 * @param {HTMLImageElement} imgEl
 * @param {{ priority?: boolean }} [opts]
 */
async function loadThumb(i, imgEl, opts) {
  if (!state.sidebarOpen || !imgEl) return;
  const im = state.images[i];
  if (!im) return;

  const isCurrent = i === state.currentIdx || i === state.current;
  const priority = !!(opts && opts.priority) || isCurrent;

  // Let the opened image claim disk/CPU first
  if (!priority && state.mainImageReady && state.mainImageReadyIdx !== i) {
    try { await state.mainImageReady; } catch (_) { /* ignore */ }
  }

  // Reuse cached thumb URL — avoids duplicate IPC when background scan already warmed the cache
  if (im.thumbUrl) {
    setSidebarThumbSrc(i, imgEl);
    return;
  }

  // Coalesce concurrent requests for the same index
  if (thumbLoadInflight.has(i)) {
    try { await thumbLoadInflight.get(i); } catch (_) { /* ignore */ }
    if (im.thumbUrl) {
      setSidebarThumbSrc(i, imgEl);
    }
    return;
  }

  const work = (async () => {
    if (isElectron && im.file && im.file.path && window.electronAPI.getThumbnail) {
      const thumbUrl = await window.electronAPI.getThumbnail(im.file.path, { priority });
      if (thumbUrl) {
        im.thumbUrl = thumbUrl;
        return;
      }
    }
  })();

  thumbLoadInflight.set(i, work);
  try {
    await work;
  } finally {
    thumbLoadInflight.delete(i);
  }

  if (im.thumbUrl) {
    setSidebarThumbSrc(i, imgEl);
    return;
  }

  setSidebarThumbSrc(i, imgEl);
}

function isGifImage(im) {
  const pathOrName = (im && imageDiskPath(im)) || (im && im.file && im.file.name) || '';
  return /\.gif$/i.test(pathOrName);
}

function areAnimatedGifsEnabled() {
  return !state.settings || !state.settings.app || state.settings.app.animateGifs !== false;
}

/**
 * Capture one GIF frame as a data URL so Chromium cannot continue animating it.
 * The original media URL remains in the image entry and is restored when the
 * setting is enabled again.
 */
function freezeGifFrame(im, sourceUrl) {
  if (!im || !isGifImage(im) || areAnimatedGifsEnabled()) return Promise.resolve('');
  if (im.staticUrl) return Promise.resolve(im.staticUrl);

  return new Promise((resolve) => {
    const source = mainImg && mainImg.naturalWidth > 0 && mainImg.src === sourceUrl
      ? mainImg
      : new Image();
    const capture = () => {
      try {
        const width = source.naturalWidth || source.width;
        const height = source.naturalHeight || source.height;
        if (!width || !height) return resolve('');
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(source, 0, 0, width, height);
        im.staticUrl = canvas.toDataURL('image/png');
        resolve(im.staticUrl);
      } catch (_) {
        // A cached static thumbnail is a lower-resolution but still non-animated
        // fallback if the browser refuses to export the source frame.
        resolve(im.thumbUrl || '');
      }
    };

    if (source === mainImg) {
      capture();
    } else {
      source.onload = capture;
      source.onerror = () => resolve(im.thumbUrl || '');
      source.src = sourceUrl;
    }
  });
}

function syncGifAnimationSetting() {
  if (sidebar) {
    state.images.forEach((_, i) => refreshSidebarGifAnimation(i));
  }

  const im = state.images[state.current];
  if (!im || !isGifImage(im)) return;
  const sourceUrl = getUrl(state.current);
  if (!sourceUrl) return;

  if (areAnimatedGifsEnabled()) {
    // Re-capture if the user disables playback again later.
    im.staticUrl = null;
    if (mainImg.src !== sourceUrl) mainImg.src = sourceUrl;
    return;
  }

  freezeGifFrame(im, sourceUrl).then((staticUrl) => {
    if (staticUrl && state.images[state.current] === im && !areAnimatedGifsEnabled()) {
      mainImg.src = staticUrl;
    }
  });
}

function getSidebarThumbUrl(i) {
  const im = state.images[i];
  if (!im) return '';
  if (im.thumbUrl) return im.thumbUrl;
  if (isGifImage(im)) return '';
  return getUrl(i);
}

function getSidebarGifAnimatedUrl(i) {
  const im = state.images[i];
  if (!im || !isGifImage(im)) return '';
  return getUrl(i);
}

function shouldAnimateSidebarThumb(i, item) {
  const im = state.images[i];
  return !!(areAnimatedGifsEnabled() && im && isGifImage(im) && item &&
    (item.classList.contains('active') || item.matches(':hover')));
}

function setSidebarThumbSrc(i, imgEl) {
  if (!imgEl) return;
  const nextSrc = getSidebarThumbUrl(i);
  if (!nextSrc) return;
  imgEl.onload = () => {
    imgEl.style.opacity = '1';
    refreshSidebarGifAnimation(i);
  };
  if (imgEl.src !== nextSrc) {
    imgEl.src = nextSrc;
  } else if (imgEl.complete && imgEl.naturalWidth > 0) {
    imgEl.style.opacity = '1';
    refreshSidebarGifAnimation(i);
  }
}

function refreshSidebarGifAnimation(i) {
  if (!sidebar) return;
  const item = sidebar.querySelector(`.thumb-item[data-index="${i}"]`);
  if (!item) return;
  const im = state.images[i];
  const staticImg = item.querySelector('.thumb-static');
  const animatedImg = item.querySelector('.thumb-animated');
  if (!animatedImg) return;

  const shouldAnimate = shouldAnimateSidebarThumb(i, item);
  const staticReady = !!(im && im.thumbUrl && staticImg && staticImg.style.opacity !== '0');
  if (!shouldAnimate || !staticReady) {
    animatedImg.classList.remove('is-visible');
    return;
  }

  const nextSrc = getSidebarGifAnimatedUrl(i);
  if (!nextSrc) return;
  if (animatedImg.src === nextSrc && animatedImg.complete && animatedImg.naturalWidth > 0) {
    animatedImg.classList.add('is-visible');
    return;
  }
  animatedImg.classList.remove('is-visible');
  animatedImg.onload = () => {
    if (shouldAnimateSidebarThumb(i, item)) animatedImg.classList.add('is-visible');
  };
  animatedImg.onerror = () => { animatedImg.classList.remove('is-visible'); };
  if (animatedImg.src !== nextSrc) animatedImg.src = nextSrc;
}

/** Ensure the active sidebar thumb is requested with high priority. */
function schedulePriorityThumb(idx) {
  if (!state.sidebarOpen) return;
  const item = sidebar && sidebar.querySelector(`.thumb-item[data-index="${idx}"]`);
  const img = item && item.querySelector('.thumb-static');
  if (img) loadThumb(idx, img, { priority: true });
}

function registerCanvasInteraction() {
  state.lastCanvasInteraction = Date.now();
  const radarEl = $('footer-radar');
  if (radarEl && radarEl.classList.contains('scanning')) {
    radarEl.classList.add('paused');
  }
}

function updateThumbProgress(p, t, _paused = false) {
  const total = t !== undefined ? t : state.images.length;
  const pct = total > 0 ? Math.round((p / total) * 100) : 0;
  $('radar-pct').textContent = pct + '%';
  $('radar-count').textContent = `[${p}/${total}]`;

  const radarEl = $('footer-radar');
  if (radarEl) {
    const active = state.scanInProgress && p < total && !_paused;
    if (active) {
      radarEl.classList.add('scanning');
      const isPaused = Date.now() - state.lastCanvasInteraction < SCAN_PAUSE_GRACE_MS;
      radarEl.classList.toggle('paused', isPaused);
    } else {
      radarEl.classList.remove('scanning');
      radarEl.classList.remove('paused');
    }
  }
}

function getUrl(i) {
  const im = state.images[i];
  if (!im) return '';
  if (im.url) return im.url;

  if (im.file && im.file.path) {
    // Stable cvlocal URL (no random bust) so preloadCache / browser cache can hit
    im.url = mediaUrl(im.file.path);
  } else if (im.file) {
    im.url = URL.createObjectURL(im.file);
  }
  return im.url;
}

function updateSidebarActive() {
  const items = sidebar.querySelectorAll('.thumb-item');
  items.forEach((el) => {
    const idx = parseInt(el.dataset.index, 10);
    el.classList.toggle('active', idx === state.current);
    const img = el.querySelector('.thumb-static');
    if (img) setSidebarThumbSrc(idx, img);
    refreshSidebarGifAnimation(idx);
  });
  // Scroll into view
  const active = sidebar.querySelector('.thumb-item.active');
  if (active) active.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── SHOW IMAGE ──
// One-shot chrome settle after first paint (no polling).
function stabilizeUI() {
  const tb = $('topbar');
  const sb = $('statusbar');
  if (tb) {
    tb.style.display = 'flex';
    tb.style.height = '48px';
    tb.style.background = 'var(--cyber-panel)';
  }
  if (sb) {
    sb.style.display = 'flex';
    sb.style.height = '28px';
  }
}
if (document.readyState === 'complete') stabilizeUI();
else window.addEventListener('load', stabilizeUI, { once: true });

function showImage(idx, direction, isInitial = false) {
  if (idx < 0 || idx >= state.images.length) return;
  if (state.transitioning && direction !== null) return;

  clearImageError();
  state.transitioning = true;

  let resolveMainReady = null;
  state.mainImageReadyIdx = idx;
  state.mainImageReady = new Promise((resolve) => {
    resolveMainReady = resolve;
  });
  const markMainReady = () => {
    if (typeof resolveMainReady === 'function') {
      resolveMainReady();
      resolveMainReady = null;
    }
  };

  const doLoad = () => {
    syncCurrentIndex(idx);
    updateSidebarActive();
    updateCounter();
    updateFileStats();
    updateFavButtonState();

    // Reset rotation al cambiar
    state.currentRotation = 0; state.visualRotation = 0;
    state.hasChanges = false;
    // Exit any leftover crop mode (e.g. new image opened from the OS while a
    // previous crop was unconfirmed - common with close-to-tray + file association).
    exitCropMode();
    updateSaveButton();

    mainImg.style.transform = `rotate(0deg)`; // Limpiar rotación visual

    spinner.classList.add('active');
    mainImg.classList.remove('loaded', 'slide-in-left', 'slide-in-right', 'slide-out-left', 'slide-out-right');
    
    // Scroll inteligente: 'center' para carga inicial/manual, 'nearest' para navegación
    const activeThumb = sidebar.querySelector(`.thumb-item[data-index="${idx}"]`);
    if (activeThumb) {
      activeThumb.scrollIntoView({ 
        behavior: isInitial ? 'auto' : 'smooth', 
        block: isInitial ? 'center' : 'nearest' 
      });
    }

    // Active thumb ASAP (priority IPC); bulk thumbs wait for main paint
    schedulePriorityThumb(idx);

    const url = getUrl(idx);
    const im = state.images[idx];
    
    // Update filename info
    const viewerFilename = $('viewer-filename');
    if (viewerFilename) {
      viewerFilename.textContent = im.file.name;
      if (im.file && im.file.path) {
        setCyberTooltip(viewerFilename, im.file.path);
        viewerFilename.classList.add('tooltip-bottom');
      } else {
        viewerFilename.removeAttribute('data-tooltip');
        viewerFilename.classList.remove('cyber-tooltip', 'tooltip-bottom');
      }
    }

    if (im.loaded) {
      if (areAnimatedGifsEnabled() || !isGifImage(im)) {
        displayImage(url, im.w, im.h, direction);
        markMainReady();
      } else {
        freezeGifFrame(im, url).then((staticUrl) => {
          if (state.images[state.current] !== im) {
            markMainReady();
            return;
          }
          const displayUrl = areAnimatedGifsEnabled() ? url : (staticUrl || url);
          displayImage(displayUrl, im.w, im.h, direction);
          markMainReady();
        });
      }
    } else {
      // Decode directly on mainImg instead of a throwaway Image(). displayImage()
      // reassigning the same URL is a no-op once loaded, so this is one fetch + decode
      // (the previous temp Image() forced a redundant second fetch + decode).
      const isCurrentImage = () => state.images[state.current] === im;
      const onMainLoad = () => {
        if (!isCurrentImage()) {
          if (mainImg.onload === onMainLoad) mainImg.onload = null;
          if (mainImg.onerror === onMainError) mainImg.onerror = null;
          markMainReady();
          return;
        }
        im.loaded = true;
        im.w = mainImg.naturalWidth;
        im.h = mainImg.naturalHeight;
        if (mainImg.onload === onMainLoad) mainImg.onload = null;
        clearImageError();
        freezeGifFrame(im, url).then((staticUrl) => {
          if (state.images[state.current] !== im) {
            markMainReady();
            return;
          }
          const displayUrl = (!areAnimatedGifsEnabled() && staticUrl) ? staticUrl : url;
          displayImage(displayUrl, im.w, im.h, direction);
          markMainReady();
        });
      };
      const onMainError = () => {
        const isCurrent = isCurrentImage();
        if (mainImg.onload === onMainLoad) mainImg.onload = null;
        if (mainImg.onerror === onMainError) mainImg.onerror = null;
        if (!isCurrent) {
          markMainReady();
          return;
        }
        spinner.classList.remove('active');
        state.transitioning = false;
        im.loaded = false;
        im.w = 0; im.h = 0;
        clearImageError();
        setImageError(im);
        markMainReady();
      };
      mainImg.onload = onMainLoad;
      mainImg.onerror = onMainError;
      mainImg.src = url;
    }

    // Preload adjacent only after main has a chance to start (and prefers short range)
    setTimeout(() => {
      // Delay adjacent full-res preload slightly more on initial open
      preloadAdjacent(idx);
    }, isInitial ? 200 : 80);
  };

  // Animate OUT current image
  if (direction && mainImg.classList.contains('loaded')) {
    const outClass = direction === 'left' ? 'slide-out-left' : 'slide-out-right';
    mainImg.classList.add(outClass);
    setTimeout(doLoad, 80);
  } else {
    // Clear stale inline opacity so removing .loaded actually hides the previous
    // image (CSS opacity:0) while the new one decodes — without this the inline
    // '1' kept the old frame visible until the new src finished loading.
    mainImg.style.opacity = '';
    mainImg.style.transition = 'none'; // Sin transición para máxima velocidad inicial
    doLoad();
  }
}

function displayImage(url, w, h, direction) {
  // On navigation, return to the user's selected view mode (Fit / 1:1) when the
  // "reset to selected" preference is on; otherwise keep the live zoom ('custom').
  if (state.settings && state.settings.app && state.settings.app.navZoomMode !== 'keep' && state.selectedViewMode) {
    state.viewMode = state.selectedViewMode;
  }
  spinner.classList.remove('active');
  mainImg.src = url;
  mainImg.classList.remove('slide-in-left', 'slide-in-right', 'slide-out-left', 'slide-out-right');

  mainImg.style.width  = w + 'px';
  mainImg.style.height = h + 'px';

  if (state.viewMode === 'original') {
    state.zoom = getOriginalZoom();
    state.panX = 0;
    state.panY = 0;
  } else if (state.viewMode === 'custom') {
    state.panX = 0;
    state.panY = 0;
  } else { // 'fit'
    const { vw, vh } = viewerFitSize();
    if (w && h) {
      state.zoom = Math.min(vw / w, vh / h);
    } else {
      state.zoom = 1;
    }
    state.panX = 0;
    state.panY = 0;
  }
  applyTransform(false);
  updateFileStats();

  if (direction) {
    const inClass = direction === 'left' ? 'slide-in-left' : 'slide-in-right';
    mainImg.style.opacity = ''; // Limpiar opacidad inline para dejar que el CSS actúe
    mainImg.classList.add('loaded', inClass);
    mainImg.addEventListener('animationend', () => {
      mainImg.classList.remove('slide-in-left', 'slide-in-right');
      state.transitioning = false;
    }, { once: true });
  } else {
    mainImg.style.opacity = ''; // Limpiar opacidad inline
    mainImg.classList.add('loaded');
    state.transitioning = false;
  }
}

// ── PRELOAD ──
function preloadAdjacent(idx) {
  for (let d = 1; d <= PRELOAD_RANGE; d++) {
    [idx + d, idx - d].forEach(i => {
      if (i >= 0 && i < state.images.length && !state.images[i].loaded) {
        const url = getUrl(i);
        if (state.preloadCache.has(url)) return;

        const tmp = new Image();
        
        // Mantener el tamaño de la caché bajo control (ej. máximo 15 imágenes precargadas)
        if (state.preloadCache.size > 15) {
          const firstKey = state.preloadCache.keys().next().value;
          state.preloadCache.delete(firstKey);
        }
        
        state.preloadCache.set(url, tmp);

        tmp.onload = () => {
          state.images[i].loaded = true;
          state.images[i].w = tmp.naturalWidth;
          state.images[i].h = tmp.naturalHeight;
        };
        tmp.src = url;
      }
    });
  }
}
// ── IMAGE ROTATION & SAVE ──
function rotate(deg) {
  if (state.current === -1) return;
  
  // Seguridad: Si estamos recortando, cancelar recorte antes de rotar
  if (state.isCropping) {
    state.isCropping = false;
    $('crop-overlay').classList.remove('active');
  }

  // visualRotation accumulates continuously (no wrap) so the CSS animation always
  // turns the short way toward the pressed direction; currentRotation stays
  // normalized [0,360) for save/dimension logic.
  state.visualRotation += deg;
  state.currentRotation = ((state.visualRotation % 360) + 360) % 360;
  
  mainImg.style.transition = 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
  mainImg.style.transform = `rotate(${state.visualRotation}deg)`;
  state.hasChanges = true;
  updateSaveButton();
  updateHUDStates();
}

// ── IMAGE FLIP (permanent copy) ──
async function flipImage(axis) {
  // 'h' = horizontal mirror (X), 'v' = vertical mirror (Y)
  if (!checkImageLoaded()) return;
  const idx = state.current;
  if (idx === undefined || idx === -1) return;
  const im = state.images[idx];
  if (!im || !mainImg || !mainImg.naturalWidth) return;

  // Cancel any pending (unconfirmed) rotation — flip always applies to the original
  if (state.currentRotation !== 0 || state.hasChanges) {
    state.currentRotation = 0; state.visualRotation = 0;
    state.hasChanges = false;
    mainImg.style.transition = 'none';
    mainImg.style.transform = 'none';
    updateSaveButton();
    updateHUDStates();
  }

  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const i18nLang = I18N[lang] || I18N.en || {};

  let fpath = imageDiskPath(im);
  if (!fpath) {
    fpath = await ensureImageDiskPath(im);
    if (!fpath) return;
  }

  showToast(i18nLang.toast_flipping || 'FLIPPING IMAGE...', 'info');

  const iw = mainImg.naturalWidth;
  const ih = mainImg.naturalHeight;
  const canvas = document.createElement('canvas');
  canvas.width = iw;
  canvas.height = ih;
  const ctx = canvas.getContext('2d');

  ctx.save();
  ctx.translate(iw / 2, ih / 2);
  if (axis === 'h') ctx.scale(-1, 1);
  else ctx.scale(1, -1);
  ctx.drawImage(mainImg, -iw / 2, -ih / 2);
  ctx.restore();

  const exported = canvasExport(canvas, fpath);
  const result = await window.electronAPI.saveImage({
    filePath: exported.filePath,
    buffer: exported.buffer,
    createCopy: true,
    copySuffix: '_flipped'
  });

  if (result.success) {
    const successKey = axis === 'h' ? 'toast_flip_h_success' : 'toast_flip_v_success';
    const fallback = axis === 'h'
      ? 'IMAGE FLIPPED HORIZONTALLY (COPY CREATED)'
      : 'IMAGE FLIPPED VERTICALLY (COPY CREATED)';
    showToast(i18nLang[successKey] || fallback, 'success');
    const newImg = {
      file: {
        name: result.filePath.split(/[\\/]/).pop(),
        path: result.filePath,
        size: 0
      }
    };
    state.images.splice(idx + 1, 0, newImg);
    buildSidebar();
    showImage(idx + 1, null);
  } else {
    showToast(lang === 'es' ? 'ERROR AL VOLTEAR' : 'ERROR FLIPPING IMAGE', 'error');
  }
}

/**
 * Floating discard/save chip — only for pending *rotation* preview.
 * Clipboard paste is a different flow (save-as / path), so it must not open this chip.
 */
function updateSaveButton() {
  const bar = $('pending-actions');
  const cluster = $('edit-cluster');
  if (!bar) return;
  const pendingRotation = state.current >= 0 && !state.isCropping &&
    !!state.hasChanges && state.currentRotation !== 0;
  // Keep the element rendered so the slide-up transition runs; .visible drives
  // opacity/transform/visibility/pointer-events instead of display.
  bar.hidden = false;
  bar.classList.toggle('visible', pendingRotation);
  if (cluster) cluster.classList.toggle('has-pending', pendingRotation);
}

/** Silently cancel any pending (unconfirmed) rotation so another action (crop/resize/adjust)
 *  operates on the original orientation. No toast — mirrors the flip behaviour. */
function discardPendingRotationSilently() {
  if (!state.hasChanges && state.currentRotation === 0) return;
  state.currentRotation = 0; state.visualRotation = 0;
  state.hasChanges = false;
  mainImg.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
  mainImg.style.transform = 'none';
  updateSaveButton();
  updateHUDStates();
}

/** Discard preview rotation (and leave toolbar layout untouched). */
function discardPendingChanges() {
  if (state.isCropping) {
    // Crop has its own cancel path
    const cancelBtn = $('btn-crop-cancel');
    if (cancelBtn) cancelBtn.click();
    return;
  }

  const hadRotation = state.currentRotation !== 0 || state.hasChanges;
  state.currentRotation = 0; state.visualRotation = 0;
  state.hasChanges = false;
  mainImg.style.transition = 'transform 0.35s cubic-bezier(0.4, 0, 0.2, 1)';
  mainImg.style.transform = 'rotate(0deg)';
  updateSaveButton();
  updateHUDStates();

  if (hadRotation) {
    const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
    const t = I18N[lang] || I18N.en || {};
    showToast(t.toast_changes_discarded || 'CHANGES DISCARDED', 'info');
  }
}

// ── CROP LOGIC PRO ──
const cropState = {
  active: false,
  x: 50, y: 50, w: 200, h: 200,
  isResizing: false,
  isMoving: false,
  handle: null,
  startX: 0, startY: 0,
  startRect: {}
};

/** Single source of truth for leaving crop mode: clears cropState, the overlay,
 *  body.crop-mode (via updateHUDStates) and the HUD hide classes. Idempotent. */
function exitCropMode() {
  if (!state.isCropping && !cropState.active) return;
  cropState.active = false;
  state.isCropping = false;
  const overlay = $('crop-overlay');
  if (overlay) overlay.classList.remove('active');
  const kbd = $('kbd-hint');
  if (kbd) kbd.classList.remove('hud-hidden');
  const filename = $('viewer-filename');
  if (filename) filename.classList.remove('hud-hidden-fade');
  updateSaveButton();
  updateHUDStates(); // drops body.crop-mode and refreshes HUD states
  if (typeof resetHudTimer === 'function') resetHudTimer();
}

function startCrop() {
  discardPendingRotationSilently();
  if (state.current === -1) return;
  if (!mainImg.complete || mainImg.naturalWidth === 0) {
    showToast(I18N[state.settings.app.language || 'en'].toast_initializing_engine, 'info');
    return;
  }
  
  // Enter crop mode BEFORE measuring: crop-mode removes the toolbar + statusbar
  // (window mode), so the framing must use the *final* viewport - otherwise the
  // floating crop panel ends up in stale space and looks misplaced (fullscreen
  // already has no chrome, so it was fine there).
  state.isCropping = true;
  updateHUDStates(); // toggles body.crop-mode synchronously
  
  // Smart crop framing: leave room below for crop action panel + handles
  const vw = viewerWrap.clientWidth;
  const vh = viewerWrap.clientHeight;
  const iw = mainImg.naturalWidth;
  const ih = mainImg.naturalHeight;
  const isVert = state.currentRotation === 90 || state.currentRotation === 270;
  const curW = isVert ? ih : iw;
  const curH = isVert ? iw : ih;

  // Keep handles clear of chrome: top handles stick out ~8px past the rect
  const SIDE = 32;
  const ABOVE = 48; // breathing room above top handles (was flush against edge)
  const BELOW = 124; // gap + crop-actions (buttons + single-line copy toggle)
  const availW = Math.max(120, vw - SIDE * 2);
  const availH = Math.max(120, vh - ABOVE - BELOW);

  state.viewMode = 'custom';
  state.zoom = Math.min(availW / curW, availH / curH, 1);
  state.panX = 0;
  // Bias upward so leftover space sits under the image for controls
  state.panY = (ABOVE - BELOW) / 2;
  applyTransform(true);
  
  showToast(I18N[state.settings.app.language || 'en'].toast_focusing_workspace, 'info', 700);
  
  // Wait for transform, then calibrate crop overlay to the visible image
  setTimeout(() => { calibrateAndShowCrop(); }, 260);
}

function calibrateAndShowCrop() {
  dismissToasts();
  // DETECCIÓN POR CONTACTO FÍSICO
  const imgB = mainImg.getBoundingClientRect();
  const wrapB = viewerWrap.getBoundingClientRect();
  
  const realX = imgB.left - wrapB.left;
  const realY = imgB.top - wrapB.top;
  const realW = imgB.width;
  const realH = imgB.height;

  cropState.active = true;
  state.isCropping = true;
  if (typeof pauseSlideshow === 'function') pauseSlideshow();
  $('crop-overlay').classList.add('active');
  $('kbd-hint').classList.add('hud-hidden');
  const filename = $('viewer-filename');
  if (filename) filename.classList.add('hud-hidden-fade');
  const nav = $('nav-container');
  if (nav) nav.classList.add('hud-hidden-fade');
  const ssHud = $('slideshow-hud');
  if (ssHud) ssHud.classList.add('hud-hidden-fade');
  
  // El marco nace ABRAZANDO los bordes reales
  cropState.x = realX;
  cropState.y = realY;
  cropState.w = realW;
  cropState.h = realH;
  
  // Guardamos la referencia base para el cálculo de píxeles
  cropState.imgRealRect = { x: realX, y: realY, w: realW, h: realH };
  
  updateCropUI();
  updateCropSaveEnabled();
  updateSaveButton();
  updateHUDStates();
}

function updateCropActionsPlacement() {
  const actions = $('crop-actions');
  if (!actions || !cropState.active) return;
  const wrapH = viewerWrap.clientHeight;
  const gap = 14;
  const needed = actions.offsetHeight + gap;
  const spaceBelow = wrapH - (cropState.y + cropState.h);
  if (spaceBelow < needed + 4) {
    actions.style.top = 'auto';
    actions.style.bottom = `calc(100% + ${gap}px)`;
  } else {
    actions.style.top = `calc(100% + ${gap}px)`;
    actions.style.bottom = 'auto';
  }
}

function updateCropSaveEnabled() {
  const btn = $('btn-crop-confirm');
  if (!btn) return;
  // "Guardar" stays apagado until the crop frame actually differs from the
  // original image bounds (moved or resized). At calibrate the frame embraces
  // the whole image, so the button starts disabled.
  let changed = false;
  if (cropState.active && cropState.imgRealRect) {
    const r = cropState.imgRealRect;
    changed = cropState.x !== r.x || cropState.y !== r.y ||
              cropState.w !== r.w || cropState.h !== r.h;
  }
  btn.disabled = !changed;
}

function updateCropUI() {
  const rect = $('crop-rect');
  rect.style.left = cropState.x + 'px';
  rect.style.top = cropState.y + 'px';
  rect.style.width = cropState.w + 'px';
  rect.style.height = cropState.h + 'px';
  updateCropActionsPlacement();
  updateCropSaveEnabled();
}

$('btn-crop').onclick = startCrop;
$('btn-crop-cancel').onclick = () => exitCropMode();

$('crop-rect').onmousedown = (e) => {
  if (!cropState.active) return;
  if (e.target.closest('#crop-actions')) return;
  e.stopPropagation();
  
  if (e.target.classList.contains('crop-handle')) {
    cropState.isResizing = true;
    cropState.handle = e.target.className.split(' ').find(c => c.startsWith('ch-'));
  } else {
    cropState.isMoving = true;
  }
  
  cropState.startX = e.clientX;
  cropState.startY = e.clientY;
  cropState.startRect = { x: cropState.x, y: cropState.y, w: cropState.w, h: cropState.h };
};

window.addEventListener('mousemove', (e) => {
  if (!cropState.active) return;
  if (!cropState.isMoving && !cropState.isResizing) return;
  
  const dx = e.clientX - cropState.startX;
  const dy = e.clientY - cropState.startY;
  
  if (cropState.isMoving) {
    const img = cropState.imgRealRect;
    let nx = cropState.startRect.x + dx;
    let ny = cropState.startRect.y + dy;
    // Constrain within image bounds
    nx = Math.max(img.x, Math.min(nx, img.x + img.w - cropState.w));
    ny = Math.max(img.y, Math.min(ny, img.y + img.h - cropState.h));
    cropState.x = nx;
    cropState.y = ny;
  } else if (cropState.isResizing) {
    const h = cropState.handle;
    const r = cropState.startRect;
    const minSize = 50;

    // Image bounds — crop cannot expand beyond the image
    const img = cropState.imgRealRect;
    const maxX = img.x + img.w;
    const maxY = img.y + img.h;

    const isCorner = (h === 'ch-tl' || h === 'ch-tr' || h === 'ch-bl' || h === 'ch-br');
    const aspect = r.w / r.h;

    // Corner classes are ch-tl/tr/bl/br — substring checks like '-l' fail on those.
    const resizeLeft = (h === 'ch-l' || h === 'ch-tl' || h === 'ch-bl');
    const resizeRight = (h === 'ch-r' || h === 'ch-tr' || h === 'ch-br');
    const resizeTop = (h === 'ch-t' || h === 'ch-tl' || h === 'ch-tr');
    const resizeBottom = (h === 'ch-b' || h === 'ch-bl' || h === 'ch-br');

    let x = r.x;
    let y = r.y;
    let w = r.w;
    let ht = r.h;

    if (resizeRight) {
      w = Math.max(minSize, r.w + dx);
    }
    if (resizeBottom) {
      ht = Math.max(minSize, r.h + dy);
    }
    if (resizeLeft) {
      const newW = Math.max(minSize, r.w - dx);
      x = r.x + (r.w - newW);
      w = newW;
    }
    if (resizeTop) {
      const newH = Math.max(minSize, r.h - dy);
      y = r.y + (r.h - newH);
      ht = newH;
    }

    // Corner handles: maintain aspect ratio
    if (isCorner) {
      if (resizeRight && resizeBottom) {
        // Bottom-right: prioritize width, adjust height
        ht = w / aspect;
      } else if (resizeLeft && resizeTop) {
        // Top-left: prioritize width, adjust height
        ht = w / aspect;
        y = r.y + (r.h - ht);
      } else if (resizeRight && resizeTop) {
        // Top-right: prioritize width, adjust height
        ht = w / aspect;
        y = r.y + (r.h - ht);
      } else if (resizeLeft && resizeBottom) {
        // Bottom-left: prioritize width, adjust height
        ht = w / aspect;
      }
    }

    // Constrain within image bounds
    x = Math.max(img.x, x);
    y = Math.max(img.y, y);
    w = Math.min(w, maxX - x);
    ht = Math.min(ht, maxY - y);

    cropState.x = x;
    cropState.y = y;
    cropState.w = w;
    cropState.h = ht;
  }
  
  updateCropUI();
});

window.addEventListener('mouseup', () => {
  cropState.isMoving = false;
  cropState.isResizing = false;
});

$('btn-crop-confirm').onclick = async () => {
  showToast(I18N[state.settings.app.language || 'en'].toast_saving_crop, 'info');
  
  // 1. Extraer el ratio de escala respecto a los píxeles originales
  const isVert = state.currentRotation === 90 || state.currentRotation === 270;
  const origW = isVert ? mainImg.naturalHeight : mainImg.naturalWidth;
  const origH = isVert ? mainImg.naturalWidth : mainImg.naturalHeight;
  
  const scale = origW / cropState.imgRealRect.w;
  
  // 2. Renderizar imagen completa con rotación
  const fullCanvas = document.createElement('canvas');
  fullCanvas.width = origW;
  fullCanvas.height = origH;
  const fctx = fullCanvas.getContext('2d');
  
  fctx.translate(fullCanvas.width/2, fullCanvas.height/2);
  fctx.rotate(state.currentRotation * Math.PI / 180);
  fctx.drawImage(mainImg, -mainImg.naturalWidth/2, -mainImg.naturalHeight/2);
  
  // 3. Recorte preciso sobre el canvas rotado
  // Usamos Math.round para evitar sangrado de píxeles
  const relX = Math.round((cropState.x - cropState.imgRealRect.x) * scale);
  const relY = Math.round((cropState.y - cropState.imgRealRect.y) * scale);
  const finalW = Math.round(cropState.w * scale);
  const finalH = Math.round(cropState.h * scale);
  
  // Validar dimensiones mínimas
  if (finalW < 1 || finalH < 1) {
    showToast(I18N[state.settings.app.language || 'en'].toast_invalid_crop, 'error');
    return;
  }

  const cropCanvas = document.createElement('canvas');
  cropCanvas.width = finalW;
  cropCanvas.height = finalH;
  const cctx = cropCanvas.getContext('2d');
  
  cctx.drawImage(fullCanvas, relX, relY, finalW, finalH, 0, 0, finalW, finalH);
  
  const im = state.images[state.current];
  const idx = state.current;
  let fpath = imageDiskPath(im);
  const isPasted = !fpath;
  if (!fpath) {
    // Pasted image: build a disk path under the OS Pictures folder (no dialog)
    // so save-image mirrors disk behaviour (suffix + dedup when createCopy is on).
    fpath = await resolvePastedImagePath(im);
    if (!fpath) return;
  }
  const createCopy = !!($('cfg-crop-copy') && $('cfg-crop-copy').checked);
  const exported = canvasExport(cropCanvas, fpath);
  const result = await window.electronAPI.saveImage({
    filePath: exported.filePath,
    buffer: exported.buffer,
    createCopy,
    copySuffix: '_cropped'
  });

  if (result.success) {
    showToast(I18N[state.settings.app.language || 'en'].toast_crop_saved, 'success');
    exitCropMode();

    const savedPath = result.filePath || exported.filePath;

    if (createCopy) {
      const newImg = {
        file: {
          name: savedPath.split(/[\\/]/).pop(),
          path: savedPath,
          size: 0
        }
      };
      state.images.splice(idx + 1, 0, newImg);
      if (window.electronAPI.registerPaths) {
        await window.electronAPI.registerPaths([savedPath]);
      }
      buildSidebar();
      showImage(idx + 1, null);
      updateHUDStates();
      return;
    }

    if (isPasted) {
      bindImageToDiskPath(im, savedPath, { revokeBlob: true });
      buildSidebar();
    } else {
      if (im.file) im.file.path = savedPath;
      im.path = savedPath;
    }
    
    // Recargar con cache-buster
    mainImg.src = mediaUrl(savedPath, Date.now());
    
    // Esperar a que la imagen cargue para actualizar HUD y dimensiones en el estado
    mainImg.onload = () => {
      // RESETEAR TRANSFORMACIONES SOLO CUANDO LA IMAGEN ESTÁ LISTA
      state.currentRotation = 0; state.visualRotation = 0;
      state.panX = 0;
      state.panY = 0;
      mainImg.style.transition = 'none';
      mainImg.style.transform = 'none';

      im.w = mainImg.naturalWidth;
      im.h = mainImg.naturalHeight;
      state.hasChanges = false;
      updateSaveButton();
      updateHUDStates();
      updateFileStats();
      // Auto-fit de la nueva imagen con dimensiones reales
      fitToWindow(im.w, im.h);
      
      // Restaurar transición suave después de un frame
      requestAnimationFrame(() => {
        mainImg.style.transition = 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
      });

      mainImg.onload = null; // Limpiar listener
    };
  } else {
    showToast('ERROR: ' + result.error, 'error');
  }
};

async function saveCurrent() {
  if (state.current === -1) return;
  const im = state.images[state.current];
  const needsSave = state.hasChanges || !imageDiskPath(im);
  if (!needsSave) return;

  let fpath = imageDiskPath(im);
  if (!fpath) {
    // Pasted images do not have a disk path yet. Use the automatic Pictures
    // path so committing a rotation never opens a Save As dialog.
    fpath = await resolvePastedImagePath(im);
    if (!fpath) return;
  }
  if (!mainImg.complete || mainImg.naturalWidth === 0) {
    showToast(I18N[state.settings.app.language || 'en'].toast_image_not_ready, 'error');
    return;
  }

  showToast(I18N[state.settings.app.language || 'en'].toast_saving_changes, 'info');

  try {
    // ── Renderizar imagen rotada en canvas ──
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    const iw = mainImg.naturalWidth;
    const ih = mainImg.naturalHeight;
    const rotation = state.currentRotation;

    if (rotation === 90 || rotation === 270) {
      canvas.width = ih;
      canvas.height = iw;
    } else {
      canvas.width = iw;
      canvas.height = ih;
    }

    const rad = rotation * Math.PI / 180;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(mainImg, -iw / 2, -ih / 2);

    // Exportar como PNG base64 (sin pérdida, preserva transparencia)
    const dataUrl = canvas.toDataURL('image/png');
    const base64Data = dataUrl.substring(dataUrl.indexOf(',') + 1);

    const result = await window.electronAPI.saveImage({
      filePath: fpath,
      buffer: base64Data
    });

    if (result.success) {
      bindImageToDiskPath(im, result.filePath || fpath);
      if (window.electronAPI.registerPaths) {
        await window.electronAPI.registerPaths([result.filePath || fpath]);
      }

      // Escuchar el load de la nueva imagen para actualizar dimensiones en el estado
      mainImg.onload = () => {
        // RESETEAR TRANSFORMACIONES SOLO CUANDO LA IMAGEN ESTÁ LISTA
        state.currentRotation = 0; state.visualRotation = 0;
        state.hasChanges = false;
        mainImg.style.transition = 'none';
        mainImg.style.transform = 'none';

        im.w = mainImg.naturalWidth;
        im.h = mainImg.naturalHeight;
        updateSaveButton();
        updateHUDStates();
        updateFileStats();
        fitToWindow(im.w, im.h);

        // Restaurar transición suave después de un frame
        requestAnimationFrame(() => {
          mainImg.style.transition = 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
        });

        mainImg.onload = null;
      };

      mainImg.src = mediaUrl(imageDiskPath(im), Date.now());
      showToast(I18N[state.settings.app.language || 'en'].toast_changes_saved, 'success');
    } else {
      showToast(result.error || 'ERROR', 'error');
    }
  } catch (e) {
    console.error('Error en saveCurrent:', e);
    showToast('ERROR: ' + (e.message || 'Unknown'), 'error');
  }
}
// ── RESIZE MODAL LOGIC ──
const resizeState = {
  aspectRatio: 1,
  lockAspect: true,
  currentAlgo: 'nearest'
};

function openResizeModal() {
  try {
    const idx = state.current;
    const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
    const i18nLang = I18N[lang] || I18N.en || {};

    discardPendingRotationSilently();

    if (idx === undefined || idx === -1) {
      showToast(i18nLang.toast_image_not_ready || 'IMAGE NOT READY', 'error');
      return;
    }
    const im = state.images[idx];
    if (!im || !im.w) {
      showToast(i18nLang.toast_image_not_ready || 'IMAGE NOT READY', 'error');
      return;
    }
    
    const wInput = $('resize-width');
    const hInput = $('resize-height');
    
    wInput.value = im.w;
    hInput.value = im.h;
    $('resize-slider').value = 100;
    $('resize-slider-w').value = 100;
    $('resize-slider-h').value = 100;
    $('slider-w-pct').textContent = '100%';
    $('slider-h-pct').textContent = '100%';
    
    resizeState.aspectRatio = im.w / im.h;
    resizeState.lockAspect = true;
    updateAspectLockButton();
    syncSliderVisibility();
    
    selectResampleAlgo('nearest');
    
    $('hud-orig-dims').innerHTML = `${im.w} <span style="font-size: 13px; color: var(--cyber-muted);">×</span> ${im.h} <span style="font-size: 11px; color: var(--cyber-muted);">PX</span>`;
    updateResizeDestInfo();

    if (typeof pauseSlideshow === 'function') pauseSlideshow();
    openModal('modal-resize');
  } catch (e) {
    console.error('Error opening resize modal:', e);
    showToast('ERROR: ' + e.message, 'error');
  }
}

const SVG_LOCKED = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display: block;"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>`;
const SVG_UNLOCKED = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display: block;"><path d="M18.84 12.2a4.49 4.49 0 0 0-6.36-6.36l-1.54 1.54"></path><path d="M8.9 14.9L7.36 16.4a4.49 4.49 0 0 0 6.36 6.36l1.54-1.54"></path></svg>`;

function updateAspectLockButton() {
  const btn = $('btn-aspect-lock');
  if (resizeState.lockAspect) {
    btn.classList.add('active');
    $('aspect-lock-icon').innerHTML = SVG_LOCKED;
  } else {
    btn.classList.remove('active');
    $('aspect-lock-icon').innerHTML = SVG_UNLOCKED;
  }
}

function syncSliderVisibility() {
  if (resizeState.lockAspect) {
    $('slider-locked-container').style.display = 'block';
    $('slider-unlocked-container').style.display = 'none';
  } else {
    $('slider-locked-container').style.display = 'none';
    $('slider-unlocked-container').style.display = 'flex';
  }
}

function syncSlidersFromInputs() {
  const idx = state.current;
  if (idx === undefined || idx === -1) return;
  const im = state.images[idx];
  if (!im || !im.w || !im.h) return;

  const w = parseFloat($('resize-width').value) || 0;
  const h = parseFloat($('resize-height').value) || 0;

  const pctW = Math.round((w / im.w) * 100);
  const pctH = Math.round((h / im.h) * 100);

  if (resizeState.lockAspect) {
    $('resize-slider').value = Math.min(400, Math.max(10, pctW));
  } else {
    $('resize-slider-w').value = Math.min(400, Math.max(10, pctW));
    $('resize-slider-h').value = Math.min(400, Math.max(10, pctH));
    $('slider-w-pct').textContent = `${pctW}%`;
    $('slider-h-pct').textContent = `${pctH}%`;
  }
}

$('btn-aspect-lock').addEventListener('click', () => {
  resizeState.lockAspect = !resizeState.lockAspect;
  updateAspectLockButton();
  syncSliderVisibility();
  if (resizeState.lockAspect) {
    let w = parseFloat($('resize-width').value) || 0;
    if (w > 16384) {
      w = 16384;
      $('resize-width').value = 16384;
    }
    if (w > 0) {
      let h = Math.round(w / resizeState.aspectRatio);
      if (h > 16384) {
        h = 16384;
        $('resize-width').value = Math.round(h * resizeState.aspectRatio);
      }
      $('resize-height').value = h;
    }
  }
  syncSlidersFromInputs();
  updateResizeDestInfo();
});

$('resize-width').addEventListener('input', () => {
  let w = parseFloat($('resize-width').value) || 0;
  if (w > 16384) {
    w = 16384;
    $('resize-width').value = 16384;
  }
  if (resizeState.lockAspect && w > 0) {
    let h = Math.round(w / resizeState.aspectRatio);
    if (h > 16384) {
      h = 16384;
      $('resize-width').value = Math.round(h * resizeState.aspectRatio);
      w = parseFloat($('resize-width').value) || 0;
    }
    $('resize-height').value = h;
  }
  syncSlidersFromInputs();
  updateResizeDestInfo();
});

$('resize-height').addEventListener('input', () => {
  let h = parseFloat($('resize-height').value) || 0;
  if (h > 16384) {
    h = 16384;
    $('resize-height').value = 16384;
  }
  if (resizeState.lockAspect && h > 0) {
    let w = Math.round(h * resizeState.aspectRatio);
    if (w > 16384) {
      w = 16384;
      $('resize-height').value = Math.round(w / resizeState.aspectRatio);
      h = parseFloat($('resize-height').value) || 0;
    }
    $('resize-width').value = w;
  }
  syncSlidersFromInputs();
  updateResizeDestInfo();
});

$('resize-slider').addEventListener('input', (e) => {
  const idx = state.current;
  if (idx === undefined || idx === -1) return;
  const im = state.images[idx];
  if (!im) return;
  const pct = parseInt(e.target.value);
  
  let w = Math.round(im.w * (pct / 100));
  let h = Math.round(im.h * (pct / 100));
  if (w > 16384) {
    w = 16384;
    h = Math.round(w / resizeState.aspectRatio);
  }
  if (h > 16384) {
    h = 16384;
    w = Math.round(h * resizeState.aspectRatio);
  }
  $('resize-width').value = w;
  $('resize-height').value = h;
  updateResizeDestInfo();
});

$('resize-slider-w').addEventListener('input', (e) => {
  const idx = state.current;
  if (idx === undefined || idx === -1) return;
  const im = state.images[idx];
  if (!im) return;
  const pct = parseInt(e.target.value);
  
  let w = Math.round(im.w * (pct / 100));
  if (w > 16384) w = 16384;
  $('resize-width').value = w;
  $('slider-w-pct').textContent = `${pct}%`;
  updateResizeDestInfo();
});

$('resize-slider-h').addEventListener('input', (e) => {
  const idx = state.current;
  if (idx === undefined || idx === -1) return;
  const im = state.images[idx];
  if (!im) return;
  const pct = parseInt(e.target.value);
  
  let h = Math.round(im.h * (pct / 100));
  if (h > 16384) h = 16384;
  $('resize-height').value = h;
  $('slider-h-pct').textContent = `${pct}%`;
  updateResizeDestInfo();
});

function updateResizeDestInfo() {
  const idx = state.current;
  if (idx === undefined || idx === -1) return;
  const im = state.images[idx];
  if (!im || !im.w || !im.h) return;

  const w = parseInt($('resize-width').value) || 0;
  const h = parseInt($('resize-height').value) || 0;
  
  // 1. Update preset highlights
  updatePresetActiveStates(w, h);

  // 2. Calculate Scale Factor & Alteration percentage
  const scaleW = w / im.w;
  const scalePercent = Math.round(scaleW * 100);
  const alteration = scalePercent - 100;
  const sign = alteration > 0 ? '+' : '';
  
  $('hud-scale-stats').textContent = `${scalePercent}% (${sign}${alteration}%)`;

  // 3. Estimate disk weight
  let origWeightText = '0 KB';
  let estWeightText = '0 KB';
  if (im.size) {
    origWeightText = formatBytes(im.size);
    // Area scaling factor (w * h) / (im.w * im.h)
    const areaScale = (w * h) / (im.w * im.h);
    
    // Apply empirical multiplier based on selected algorithm to reflect complexity/weight difference
    let algoMultiplier = 1.0;
    if (resizeState.currentAlgo === 'nearest') {
      algoMultiplier = 0.85; // Fast (Nearest Neighbor) is usually smaller/less complex
    } else if (resizeState.currentAlgo === 'bicubic') {
      algoMultiplier = 1.15; // High Quality (Bicubic) preserves more fine details/gradients (larger file)
    } // Bilinear (balanced) is 1.0
    
    const estimatedSize = im.size * areaScale * algoMultiplier;
    estWeightText = formatBytes(estimatedSize);
  }
  
  $('hud-weight-stats').textContent = `${origWeightText} → ~${estWeightText}`;
  updateResizeSaveEnabled(im);
}

function updatePresetActiveStates(w, h) {
  const idx = state.current;
  if (idx === undefined || idx === -1) return;
  const im = state.images[idx];
  if (!im || !im.w || !im.h) return;

  const presets = [
    { el: $('preset-1080'), type: 'dims', w: 1080, h: 1080 },
    { el: $('preset-720'), type: 'dims', w: 1280, h: 720 },
    { el: $('preset-1080p'), type: 'dims', w: 1920, h: 1080 },
    { el: $('preset-pct25'), type: 'scale', val: 0.25 },
    { el: $('preset-pct50'), type: 'scale', val: 0.50 },
    { el: $('preset-pct200'), type: 'scale', val: 2.00 }
  ];

  presets.forEach(p => {
    if (!p.el) return;
    let isActive = false;
    if (p.type === 'dims') {
      if (resizeState.lockAspect) {
        isActive = (w === p.w);
      } else {
        isActive = (w === p.w && h === p.h);
      }
    } else if (p.type === 'scale') {
      const scaleW = w / im.w;
      const scaleH = h / im.h;
      if (Math.abs(scaleW - scaleH) < 0.005) {
        const currentScale = scaleW;
        isActive = (Math.abs(currentScale - p.val) < 0.005);
      }
    }
    p.el.classList.toggle('active', isActive);
  });
}

// Preset helpers kept for potential HUD bindings / future UI
function _applyResizePreset(w, h) {
  $('resize-width').value = w;
  if (resizeState.lockAspect) {
    $('resize-height').value = Math.round(w / resizeState.aspectRatio);
  } else {
    $('resize-height').value = h;
  }
  syncSlidersFromInputs();
  updateResizeDestInfo();
}

function _applyResizeScalePreset(scale) {
  const idx = state.current;
  if (idx === undefined || idx === -1) return;
  const im = state.images[idx];
  if (!im) return;
  $('resize-width').value = Math.round(im.w * scale);
  $('resize-height').value = Math.round(im.h * scale);
  syncSlidersFromInputs();
  updateResizeDestInfo();
}

function selectResampleAlgo(algo) {
  resizeState.currentAlgo = algo;
  ['nearest', 'bilinear', 'bicubic'].forEach(a => {
    $(`btn-algo-${a}`).classList.toggle('active', a === algo);
  });
  updateResizeDestInfo();
}

function updateResizeSaveEnabled(im) {
  const btn = $('btn-confirm-resize');
  if (!btn) return;
  if (!im || !im.w || !im.h) { btn.disabled = true; return; }
  const w = parseInt($('resize-width').value) || 0;
  const h = parseInt($('resize-height').value) || 0;
  const dimsChanged = w !== im.w || h !== im.h;
  const algoChanged = resizeState.currentAlgo !== 'nearest';
  btn.disabled = !(dimsChanged || algoChanged);
}

$('btn-resize').addEventListener('click', openResizeModal);
$('preset-1080').addEventListener('click', () => _applyResizePreset(1080, 1080));
$('preset-720').addEventListener('click', () => _applyResizePreset(1280, 720));
$('preset-1080p').addEventListener('click', () => _applyResizePreset(1920, 1080));
$('preset-pct25').addEventListener('click', () => _applyResizeScalePreset(0.25));
$('preset-pct50').addEventListener('click', () => _applyResizeScalePreset(0.50));
$('preset-pct200').addEventListener('click', () => _applyResizeScalePreset(2.00));
$('btn-algo-nearest').addEventListener('click', () => selectResampleAlgo('nearest'));
$('btn-algo-bilinear').addEventListener('click', () => selectResampleAlgo('bilinear'));
$('btn-algo-bicubic').addEventListener('click', () => selectResampleAlgo('bicubic'));

// ── ADJUST MODAL LOGIC ──
const adjustState = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  blur: 0,
  grayscale: false,
  invert: false,
  previewZoom: 100, // % relative to fit-in-stage
  compareOriginal: false,
  compareSticky: false,
  previewRaf: 0,
  fitScale: 1
};

function defaultAdjustControls() {
  return {
    brightness: 0,
    contrast: 0,
    saturation: 0,
    blur: 0,
    grayscale: false,
    invert: false
  };
}

function readAdjustControls() {
  return {
    brightness: parseInt($('adj-brightness') && $('adj-brightness').value, 10) || 0,
    contrast: parseInt($('adj-contrast') && $('adj-contrast').value, 10) || 0,
    saturation: parseInt($('adj-saturation') && $('adj-saturation').value, 10) || 0,
    blur: parseInt($('adj-blur') && $('adj-blur').value, 10) || 0,
    grayscale: !!( $('adj-grayscale') && $('adj-grayscale').checked ),
    invert: !!( $('adj-invert') && $('adj-invert').checked )
  };
}

function writeAdjustControls(vals) {
  const v = Object.assign(defaultAdjustControls(), vals || {});
  if ($('adj-brightness')) $('adj-brightness').value = v.brightness;
  if ($('adj-contrast')) $('adj-contrast').value = v.contrast;
  if ($('adj-saturation')) $('adj-saturation').value = v.saturation;
  if ($('adj-blur')) $('adj-blur').value = v.blur;
  if ($('adj-grayscale')) $('adj-grayscale').checked = !!v.grayscale;
  if ($('adj-invert')) $('adj-invert').checked = !!v.invert;
  syncAdjustValueLabels();
}

function updateAdjustSaveEnabled() {
  const btn = $('btn-confirm-adjust');
  if (!btn) return;
  btn.disabled = isIdentityAdjust(readAdjustControls());
}

function syncAdjustValueLabels() {
  const s = readAdjustControls();
  Object.assign(adjustState, s);
  const fmt = (n) => (n > 0 ? '+' : '') + String(n);
  if ($('adj-brightness-val')) $('adj-brightness-val').textContent = fmt(s.brightness);
  if ($('adj-contrast-val')) $('adj-contrast-val').textContent = fmt(s.contrast);
  if ($('adj-saturation-val')) $('adj-saturation-val').textContent = fmt(s.saturation);
  if ($('adj-blur-val')) $('adj-blur-val').textContent = String(s.blur);
  updateAdjustSaveEnabled();
}

function setAdjustPreviewZoom(pct) {
  const z = Math.max(50, Math.min(300, Math.round(Number(pct) || 100)));
  adjustState.previewZoom = z;
  if ($('adj-preview-zoom')) $('adj-preview-zoom').value = z;
  if ($('adj-zoom-val')) $('adj-zoom-val').textContent = z + '%';
}

function setAdjustCompare(on, opts) {
  adjustState.compareOriginal = !!on;
  if (opts && opts.sticky != null) adjustState.compareSticky = !!opts.sticky;
  const btn = $('btn-adjust-compare');
  if (btn) {
    // Active style reflects sticky latch (not momentary hold)
    const latched = !!adjustState.compareSticky;
    btn.classList.toggle('active', latched);
    btn.setAttribute('aria-pressed', latched ? 'true' : 'false');
  }
}

function scheduleAdjustPreview() {
  if (adjustState.previewRaf) cancelAnimationFrame(adjustState.previewRaf);
  adjustState.previewRaf = requestAnimationFrame(() => {
    adjustState.previewRaf = 0;
    updateAdjustPreview();
  });
}

function updateAdjustPreview() {
  const canvas = $('adjust-preview-canvas');
  if (!canvas || !mainImg || !mainImg.naturalWidth) return;

  const stage = $('adjust-preview-stage');
  // Leave a couple px so fit never overflows stage and creates ghost scrollbars
  const maxW = stage ? Math.max(160, stage.clientWidth - 6) : 420;
  const maxH = stage ? Math.max(140, Math.min(300, (stage.clientHeight || 260) - 6)) : 260;
  const iw = mainImg.naturalWidth;
  const ih = mainImg.naturalHeight;
  const fitScale = Math.min(1, maxW / iw, maxH / ih);
  adjustState.fitScale = fitScale;
  const zoomMul = (adjustState.previewZoom || 100) / 100;
  const scale = fitScale * zoomMul;
  const w = Math.max(1, Math.floor(iw * scale));
  const h = Math.max(1, Math.floor(ih * scale));

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  // Display size matches backing store (avoid CSS max-height fighting zoom)
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';

  if (stage) {
    stage.classList.toggle('is-zoomed', (adjustState.previewZoom || 100) > 100);
  }

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  let filters = readAdjustControls();
  Object.assign(adjustState, filters);
  if (adjustState.compareOriginal) {
    filters = defaultAdjustControls();
  }
  // Blur in canvas px scales with draw size so preview ≈ full-res look
  ctx.filter = buildCssFilter(filters, { blurScale: scale });
  ctx.drawImage(mainImg, 0, 0, w, h);
  ctx.filter = 'none';
}

function openAdjustModal() {
  try {
    const idx = state.current;
    const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
    const i18nLang = I18N[lang] || I18N.en || {};

    discardPendingRotationSilently();

    if (idx === undefined || idx === -1) {
      showToast(i18nLang.toast_image_not_ready || 'IMAGE NOT READY', 'error');
      return;
    }
    const im = state.images[idx];
    if (!im || !mainImg || !mainImg.naturalWidth) {
      showToast(i18nLang.toast_image_not_ready || 'IMAGE NOT READY', 'error');
      return;
    }

    writeAdjustControls(defaultAdjustControls());
    setAdjustPreviewZoom(100);
    adjustState.compareSticky = false;
    setAdjustCompare(false);

    if (typeof pauseSlideshow === 'function') pauseSlideshow();
    openModal('modal-adjust');
    // Layout needs a frame before measuring the preview stage
    requestAnimationFrame(() => {
      updateAdjustPreview();
      requestAnimationFrame(updateAdjustPreview);
    });
  } catch (e) {
    console.error('Error opening adjust modal:', e);
    showToast('ERROR: ' + e.message, 'error');
  }
}

function onAdjustControlInput() {
  syncAdjustValueLabels();
  scheduleAdjustPreview();
}

['adj-brightness', 'adj-contrast', 'adj-saturation', 'adj-blur'].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener('input', onAdjustControlInput);
});
['adj-grayscale', 'adj-invert'].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener('change', onAdjustControlInput);
});

if ($('adj-preview-zoom')) {
  $('adj-preview-zoom').addEventListener('input', (e) => {
    setAdjustPreviewZoom(e.target.value);
    scheduleAdjustPreview();
  });
}
if ($('btn-adjust-zoom-out')) {
  $('btn-adjust-zoom-out').addEventListener('click', () => {
    setAdjustPreviewZoom((adjustState.previewZoom || 100) - 25);
    scheduleAdjustPreview();
  });
}
if ($('btn-adjust-zoom-in')) {
  $('btn-adjust-zoom-in').addEventListener('click', () => {
    setAdjustPreviewZoom((adjustState.previewZoom || 100) + 25);
    scheduleAdjustPreview();
  });
}
if ($('btn-adjust-zoom-fit')) {
  $('btn-adjust-zoom-fit').addEventListener('click', () => {
    setAdjustPreviewZoom(100);
    scheduleAdjustPreview();
  });
}

// Compare UX: short click toggles sticky A/B; hold peeks original until release
(function wireAdjustCompare() {
  const cmp = $('btn-adjust-compare');
  if (!cmp) return;
  let holdActive = false;
  let pointerDownAt = 0;

  cmp.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    holdActive = true;
    pointerDownAt = Date.now();
    try { cmp.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    setAdjustCompare(true);
    scheduleAdjustPreview();
  });
  const releaseHold = (e) => {
    if (!holdActive) return;
    holdActive = false;
    try { cmp.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const brief = Date.now() - pointerDownAt < 220;
    if (brief) {
      adjustState.compareSticky = !adjustState.compareSticky;
    }
    setAdjustCompare(adjustState.compareSticky);
    scheduleAdjustPreview();
  };
  cmp.addEventListener('pointerup', releaseHold);
  cmp.addEventListener('pointercancel', () => {
    holdActive = false;
    setAdjustCompare(adjustState.compareSticky);
    scheduleAdjustPreview();
  });
  cmp.addEventListener('lostpointercapture', () => {
    if (!holdActive) return;
    holdActive = false;
    setAdjustCompare(adjustState.compareSticky);
    scheduleAdjustPreview();
  });
})();

if ($('btn-adjust-reset')) {
  $('btn-adjust-reset').addEventListener('click', () => {
    writeAdjustControls(defaultAdjustControls());
    scheduleAdjustPreview();
  });
}

if ($('btn-adjust')) {
  $('btn-adjust').addEventListener('click', openAdjustModal);
}

if ($('btn-confirm-adjust')) {
  $('btn-confirm-adjust').addEventListener('click', async () => {
    try {
      const idx = state.current;
      if (idx === undefined || idx === -1) return;
      const im = state.images[idx];
      if (!im || !mainImg || !mainImg.naturalWidth) return;

      const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
      const i18nLang = I18N[lang] || I18N.en || {};
      const filters = readAdjustControls();
      Object.assign(adjustState, filters);

      if (isIdentityAdjust(filters)) {
        showToast(i18nLang.toast_adjust_none || 'NO CHANGES TO APPLY', 'info');
        return;
      }

      const isPasted = !imageDiskPath(im);
      const createCopy = !!( $('cfg-adjust-copy') && $('cfg-adjust-copy').checked );

      let fpath = imageDiskPath(im);
      if (!fpath) {
        // Pasted (clipboard) images have no disk path: build one under the OS
        // Pictures folder (no dialog) so save-image works like disk images — it
        // adds the copy suffix (_adjusted) and dedups when createCopy is on, or
        // writes in place otherwise.
        fpath = await resolvePastedImagePath(im);
        if (!fpath) return;
      }
      showToast(i18nLang.toast_adjusting || 'APPLYING ADJUSTMENTS...', 'info');

      const iw = mainImg.naturalWidth;
      const ih = mainImg.naturalHeight;
      const rotation = state.currentRotation || 0;
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (rotation === 90 || rotation === 270) {
        canvas.width = ih;
        canvas.height = iw;
      } else {
        canvas.width = iw;
        canvas.height = ih;
      }

      // Bake pending rotation first, then apply color filters (full-res blurScale = 1)
      ctx.save();
      ctx.translate(canvas.width / 2, canvas.height / 2);
      if (rotation) ctx.rotate((rotation * Math.PI) / 180);
      ctx.filter = buildCssFilter(filters, { blurScale: 1 });
      ctx.drawImage(mainImg, -iw / 2, -ih / 2);
      ctx.restore();

      const exported = canvasExport(canvas, fpath);
      // Disk + pasted images both honor createCopy: save-image writes
      // name_adjusted.ext next to the original/pasted path (dedup) when on, or
      // overwrites in place when off. No dialog either way.
      const result = await window.electronAPI.saveImage({
        filePath: exported.filePath,
        buffer: exported.buffer,
        createCopy: createCopy,
        copySuffix: '_adjusted'
      });
      if (result.success) {
        showToast(i18nLang.toast_adjust_success || 'ADJUSTMENTS APPLIED', 'success');
        closeModal('modal-adjust');

        const reloadAfterSave = (savedPath) => {
          mainImg.src = mediaUrl(savedPath, Date.now());
          mainImg.onload = () => {
            state.currentRotation = 0; state.visualRotation = 0;
            state.panX = 0;
            state.panY = 0;
            mainImg.style.transition = 'none';
            mainImg.style.transform = 'none';

            im.w = mainImg.naturalWidth;
            im.h = mainImg.naturalHeight;
            state.hasChanges = false;
            updateSaveButton();
            updateHUDStates();
            updateFileStats();
            fitToWindow(im.w, im.h);

            requestAnimationFrame(() => {
              mainImg.style.transition = 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
            });
            mainImg.onload = null;
          };
        };

        if (!isPasted && createCopy) {
          const newImg = {
            file: {
              name: result.filePath.split(/[\\/]/).pop(),
              path: result.filePath,
              size: 0
            }
          };
          state.images.splice(idx + 1, 0, newImg);
          buildSidebar();
          showImage(idx + 1, null);
        } else if (isPasted) {
          // Pasted image now lives on disk as the modified output file the user just
          // picked: bind it as a real disk image, reload, and refresh the sidebar so
          // the filename + thumbnail reflect the saved file (drops the stale blob).
          const savedPath = result.filePath || exported.filePath;
          bindImageToDiskPath(im, savedPath, { revokeBlob: true });
          reloadAfterSave(savedPath);
          buildSidebar();
        } else {
          const savedPath = result.filePath || exported.filePath;
          if (im.file) im.file.path = savedPath;
          im.path = savedPath;
          reloadAfterSave(savedPath);
        }
      } else {
        showToast((i18nLang.toast_adjust_error || 'ERROR') + ': ' + (result.error || ''), 'error');
      }
    } catch (e) {
      console.error('Error confirming adjust:', e);
      showToast('ERROR: ' + e.message, 'error');
    }
  });
}

$('btn-confirm-resize').addEventListener('click', async () => {
  try {
    const idx = state.current;
    if (idx === undefined || idx === -1) return;
    const im = state.images[idx];
    if (!im) return;
    const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
    const i18nLang = I18N[lang] || I18N.en || {};

    let fpath = imageDiskPath(im);
    const isPasted = !fpath;
    if (!fpath) {
      // Pasted image: build a disk path under the OS Pictures folder (no dialog)
      // so save-image mirrors disk behaviour (suffix + dedup when createCopy is on).
      fpath = await resolvePastedImagePath(im);
      if (!fpath) return;
    }    
    const targetW = parseInt($('resize-width').value) || 0;
    const targetH = parseInt($('resize-height').value) || 0;
    
    if (targetW < 1 || targetH < 1) {
      showToast(i18nLang.toast_invalid_crop || 'Dimensiones inválidas', 'error');
      return;
    }
    
    showToast(lang === 'es' ? 'REDIMENSIONANDO IMAGEN...' : 'RESIZING IMAGE...', 'info');
    
    // Realizar redimensión en un canvas offscreen
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    
    const algo = resizeState.currentAlgo;
    if (algo === 'nearest') {
      ctx.imageSmoothingEnabled = false;
    } else if (algo === 'bilinear') {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'medium';
    } else { // bicubic
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
    }
    
    // Dibujar la imagen en las nuevas dimensiones
    ctx.drawImage(mainImg, 0, 0, targetW, targetH);
    
    const exported = canvasExport(canvas, fpath);
    const createCopy = $('cfg-resize-copy').checked;
    
    const result = await window.electronAPI.saveImage({
      filePath: exported.filePath,
      buffer: exported.buffer,
      createCopy: createCopy
    });
    
    if (result.success) {
      showToast(i18nLang.toast_resize_success || 'IMAGEN REDIMENSIONADA', 'success');
      closeModal('modal-resize');
      
      if (createCopy) {
        // Generar objeto de nueva imagen
        const newImg = {
          file: {
            name: result.filePath.split(/[\\/]/).pop(),
            path: result.filePath,
            size: 0
          }
        };
        // Insertarla justo después de la actual
        state.images.splice(idx + 1, 0, newImg);
        
        // Reconstruir la barra y mostrar la nueva imagen
        buildSidebar();
        showImage(idx + 1, null);
      } else {
        const savedPath = result.filePath || exported.filePath;
        if (isPasted) {
          bindImageToDiskPath(im, savedPath, { revokeBlob: true });
          buildSidebar();
        } else {
          if (im.file) im.file.path = savedPath;
          im.path = savedPath;
        }
        // Recargar imagen con cache-buster
        mainImg.src = mediaUrl(savedPath, Date.now());
        
        mainImg.onload = () => {
          state.currentRotation = 0; state.visualRotation = 0;
          state.panX = 0;
          state.panY = 0;
          mainImg.style.transition = 'none';
          mainImg.style.transform = 'none';
          
          im.w = mainImg.naturalWidth;
          im.h = mainImg.naturalHeight;
          state.hasChanges = false;
          updateSaveButton();
          updateHUDStates();
          updateFileStats();
          fitToWindow(im.w, im.h);
          
          requestAnimationFrame(() => {
            mainImg.style.transition = 'transform 0.4s cubic-bezier(0.4, 0, 0.2, 1)';
          });
          mainImg.onload = null;
        };
      }
    } else {
      showToast('ERROR: ' + result.error, 'error');
    }
  } catch (e) {
    console.error('Error confirming resize:', e);
    showToast('ERROR: ' + e.message, 'error');
  }
});

// ── ZOOM & PAN ──
/** Usable viewer size (excludes docked toolbar strip in window mode). */
function viewerFitSize() {
  const pad = 24;
  // Prefer live canvas-layer box (CSS already insets bottom for docked chrome)
  const layer = $('canvas-layer');
  if (layer && layer.clientWidth > 40 && layer.clientHeight > 40) {
    return {
      vw: Math.max(1, layer.clientWidth - pad),
      vh: Math.max(1, layer.clientHeight - pad)
    };
  }
  const docked = !state.isGhost && state.images.length > 0 && !document.body.classList.contains('empty-state');
  const dockH = docked ? 60 : 0;
  return {
    vw: Math.max(1, viewerWrap.clientWidth - pad),
    vh: Math.max(1, viewerWrap.clientHeight - pad - dockH)
  };
}

function fitToWindow(w, h) {
  const { vw, vh } = viewerFitSize();
  if (!w || !h) { state.zoom = 1; return; }
  const scale = Math.min(vw / w, vh / h);
  state.zoom = scale;
  state.panX = 0;
  state.panY = 0;
  mainImg.style.width  = w + 'px';
  mainImg.style.height = h + 'px';
  applyTransform(false);
}

function applyTransform(animate, opts = {}) {
  const t = `translate(${state.panX}px, ${state.panY}px) scale(${state.zoom})`;
  canvasL.style.transition = animate ? 'transform 200ms cubic-bezier(.25,.46,.45,.94)' : 'none';
  canvasL.style.transform = t;
  updateZoomHUD(opts);
}

/**
 * The image bitmap is measured in physical pixels, while CSS px in Electron
 * are logical display pixels. Compensate for Windows display scaling so a
 * screenshot appears at the same on-screen size as the captured widget.
 */
function getOriginalZoom() {
  return screenCaptureZoom(typeof window !== 'undefined' ? window.devicePixelRatio : 1);
}

function setOriginalView(animate = false) {
  state.viewMode = 'original';
  state.selectedViewMode = 'original';
  state.zoom = getOriginalZoom();
  state.panX = 0;
  state.panY = 0;
  applyTransform(animate);
}

/** Reflect the active view mode on the Fit / 1:1 action buttons (like the fullscreen button). */
function syncViewModeButtons() {
  const fitBtn = $('btn-fit-hud');
  const origBtn = $('btn-orig-hud');
  if (fitBtn) fitBtn.classList.toggle('active', state.viewMode === 'fit');
  if (origBtn) origBtn.classList.toggle('active', state.viewMode === 'original');
}

function sliderToZoom(val) {
  if (CVMedia.sliderToZoom) return CVMedia.sliderToZoom(val, ZOOM_MIN, ZOOM_MAX);
  const minL = Math.log10(ZOOM_MIN);
  const maxL = Math.log10(ZOOM_MAX);
  const t = Math.max(0, Math.min(1, val / 1000));
  return Math.pow(10, minL + (maxL - minL) * t);
}

function zoomToSlider(zoom) {
  if (CVMedia.zoomToSlider) return CVMedia.zoomToSlider(zoom, ZOOM_MIN, ZOOM_MAX);
  const minL = Math.log10(ZOOM_MIN);
  const maxL = Math.log10(ZOOM_MAX);
  const t = (Math.log10(zoom) - minL) / (maxL - minL);
  return Math.round(Math.max(0, Math.min(1000, t * 1000)));
}

/**
 * @param {{ userZoom?: boolean }} [opts]
 *   userZoom — wheel/keyboard zoom. Floating badge only in fullscreen (not window slideshow;
 *   restored window already has the statusbar slider + %).
 */
function updateZoomHUD(opts = {}) {
  syncViewModeButtons();
  // Report zoom relative to the calibrated screen-capture size. Internally
  // state.zoom still contains the CSS-pixel transform (1 / devicePixelRatio
  // at capture 1:1), but the user-facing 1:1 view must read as 100%.
  const baseZoom = getOriginalZoom();
  const displayZoom = baseZoom > 0 ? state.zoom / baseZoom : state.zoom;
  const pct = Math.round(displayZoom * 100);
  zoomVal.textContent = pct + '%';
  $('zoom-pct').textContent = pct + '%';
  const slider = $('zoom-slider');
  if (slider) slider.value = zoomToSlider(displayZoom);
  if (!zoomHud) return;

  // Floating badge is fullscreen-only
  if (!state.isGhost) {
    zoomHud.classList.remove('visible', 'hud-hidden-fade');
    clearTimeout(state.zoomTimer);
    return;
  }

  // Fullscreen presentation: show badge only on intentional user zoom, never on fit/slide
  if (state.slideshowActive && !opts.userZoom) {
    zoomHud.classList.remove('visible');
    zoomHud.classList.add('hud-hidden-fade');
    clearTimeout(state.zoomTimer);
    return;
  }

  // User zoom (or normal FS zoom) — show badge; own short fade so slideshow idle-hide won't kill it instantly
  zoomHud.classList.add('visible');
  zoomHud.classList.remove('hud-hidden-fade');
  clearTimeout(state.zoomTimer);
  // Don't call resetHudTimer here during slideshow — it was re-hiding the badge on every tick
  if (state.slideshowActive) {
    state.zoomTimer = setTimeout(() => {
      zoomHud.classList.remove('visible');
      zoomHud.classList.add('hud-hidden-fade');
    }, 1200);
  } else if (typeof resetHudTimer === 'function') {
    resetHudTimer();
  }
}

$('zoom-slider').addEventListener('input', (e) => {
  if (state.images.length === 0) return;
  registerCanvasInteraction();
  const val = parseInt(e.target.value, 10);
  const newZoom = sliderToZoom(val) * getOriginalZoom();
  state.viewMode = 'custom';
  state.zoom = newZoom;
  state.panX = 0;
  state.panY = 0;
  applyTransform(true, { userZoom: true });
});

$('zoom-slider').addEventListener('wheel', (e) => {
  if (state.images.length === 0) return;
  e.preventDefault();
  e.stopPropagation();
  // Slightly larger steps so the slider tracks wheel zoom better
  const delta = e.deltaY < 0 ? -22 : 22;
  let val = parseInt($('zoom-slider').value, 10) + delta;
  val = Math.max(0, Math.min(1000, val));
  $('zoom-slider').value = val;
  $('zoom-slider').dispatchEvent(new Event('input'));
}, { passive: false });

function updateFileStats() {
  const dimsEl = $('img-dims');
  const weightEl = $('img-weight');
  if (!dimsEl || !weightEl) return;

  if (state.current === -1 || !state.images[state.current]) {
    dimsEl.textContent = '—';
    weightEl.textContent = '—';
    return;
  }

  const im = state.images[state.current];
  const w = im.w || mainImg.naturalWidth || 0;
  const h = im.h || mainImg.naturalHeight || 0;
  dimsEl.textContent = (w && h) ? `${w} × ${h}px` : '—';

  // Prefer known size on the image entry / File object
  let bytes = Number(im.size);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    bytes = Number(im.file && im.file.size);
  }
  if (Number.isFinite(bytes) && bytes > 0) {
    im.size = bytes;
    weightEl.textContent = formatBytes(bytes);
  } else {
    weightEl.textContent = '…';
    // Resolve from disk when size wasn't provided by the open/scan path
    const fpath = im.file && im.file.path;
    if (isElectron && fpath && window.electronAPI.getFileInfo) {
      const token = fpath + '@' + state.current;
      weightEl.dataset.pending = token;
      window.electronAPI.getFileInfo(fpath).then((info) => {
        if (!info || weightEl.dataset.pending !== token) return;
        if (state.current < 0 || !state.images[state.current]) return;
        const cur = state.images[state.current];
        if (!cur.file || cur.file.path !== fpath) return;
        if (Number.isFinite(info.size) && info.size >= 0) {
          cur.size = info.size;
          if (cur.file) cur.file.size = info.size;
          weightEl.textContent = formatBytes(info.size);
        } else {
          weightEl.textContent = '—';
        }
        delete weightEl.dataset.pending;
      }).catch(() => {
        if (weightEl.dataset.pending === token) {
          weightEl.textContent = '—';
          delete weightEl.dataset.pending;
        }
      });
    } else {
      weightEl.textContent = '—';
    }
  }
}

/** Slightly faster than before (0.001 → 0.00145) so full range needs fewer wheel notches. */
const WHEEL_ZOOM_FACTOR = 0.00145;

function zoomAt(delta, cx, cy) {
  registerCanvasInteraction();
  state.viewMode = 'custom';
  const rect = viewerWrap.getBoundingClientRect();
  const ox = cx - rect.left - rect.width / 2;
  const oy = cy - rect.top  - rect.height / 2;

  const oldZoom = state.zoom;
  let newZoom = state.zoom * (1 + delta * WHEEL_ZOOM_FACTOR);
  const baseZoom = getOriginalZoom();
  newZoom = Math.max(ZOOM_MIN * baseZoom, Math.min(ZOOM_MAX * baseZoom, newZoom));

  const ratio = newZoom / oldZoom;
  state.panX = ox + (state.panX - ox) * ratio;
  state.panY = oy + (state.panY - oy) * ratio;
  state.zoom = newZoom;
  applyTransform(false, { userZoom: true });
}

// ── NAVIGATION ──
function goToBoundary(which) {
  if (!state.images.length) return;
  const idx = which === 'start' ? 0 : state.images.length - 1;
  if (idx === state.current && state.current >= 0) {
    updateSidebarActive();
    return;
  }
  // Use a null direction so this explicit command is never rejected while
  // another image transition is still settling.
  showImage(idx, null, true);
}

function prev() {
  registerCanvasInteraction();
  if (state.images.length === 0 || state.transitioning) return;
  const next = (state.current - 1 + state.images.length) % state.images.length;
  showImage(next, 'right');
  hideActionBarOnNavigate();
  if (state.slideshowPlaying) scheduleSlideshowTick();
}

function next() {
  registerCanvasInteraction();
  if (state.images.length === 0 || state.transitioning) return;
  const nxt = (state.current + 1) % state.images.length;
  showImage(nxt, 'left');
  hideActionBarOnNavigate();
  if (state.slideshowPlaying) scheduleSlideshowTick();
}

// ── SLIDESHOW ──
const SLIDESHOW_INTERVALS = [2000, 3000, 5000, 10000];

function getSlideshowIntervalMs() {
  const raw = state.settings && state.settings.app && state.settings.app.slideshowIntervalMs;
  const n = parseInt(raw, 10);
  if (SLIDESHOW_INTERVALS.includes(n)) return n;
  return 3000;
}

function isSlideshowLoop() {
  return !(state.settings && state.settings.app && state.settings.app.slideshowLoop === false);
}

function isSlideshowEnterFs() {
  return !(state.settings && state.settings.app && state.settings.app.slideshowEnterFullscreen === false);
}

function setSlideshowLoop(on) {
  const app = ensureAppSettings();
  app.slideshowLoop = !!on;
  persistAppSettings();
  updateSlideshowUI();
}

function setSlideshowIntervalMs(ms) {
  const app = ensureAppSettings();
  const n = parseInt(ms, 10);
  app.slideshowIntervalMs = SLIDESHOW_INTERVALS.includes(n) ? n : 3000;
  persistAppSettings();
  updateSlideshowUI();
  if (state.slideshowPlaying) scheduleSlideshowTick();
}

function clearSlideshowTimer() {
  if (state.slideshowTimer) {
    clearTimeout(state.slideshowTimer);
    state.slideshowTimer = null;
  }
}

function scheduleSlideshowTick() {
  clearSlideshowTimer();
  if (!state.slideshowActive || !state.slideshowPlaying) return;
  const ms = getSlideshowIntervalMs();
  state.slideshowTimer = setTimeout(() => {
    state.slideshowTimer = null;
    slideshowAdvance(1, { fromTimer: true });
  }, ms);
}

/**
 * Advance slideshow by ±1, skipping hidden images.
 * When loop is off, stop at ends instead of wrapping.
 */
function slideshowAdvance(dir, opts = {}) {
  if (!state.slideshowActive) return;
  const n = state.images.length;
  if (n === 0) {
    stopSlideshow({ silent: true });
    return;
  }

  const loop = isSlideshowLoop();
  let idx = state.current;
  if (idx < 0) idx = 0;

  for (let step = 0; step < n; step++) {
    let candidate = idx + dir;
    if (candidate < 0 || candidate >= n) {
      if (loop) {
        candidate = dir > 0 ? 0 : n - 1;
      } else {
        // End of set
        pauseSlideshow();
        const lang = (state.settings.app && state.settings.app.language) || 'en';
        const t = I18N[lang] || I18N.en;
        if (opts.fromTimer && typeof showToast === 'function') {
          showToast(t.toast_slideshow_end || 'SLIDESHOW END', 'info');
        }
        updateSlideshowUI(); // keep fade state; end of set
        return;
      }
    }
    idx = candidate;
    const im = state.images[idx];
    if (im && !im.hidden) {
      state.viewMode = 'fit';
      showImage(idx, dir > 0 ? 'left' : 'right');
      if (state.slideshowPlaying) scheduleSlideshowTick();
      // Labels/counter only — do not reveal chrome or reset HUD timer
      updateSlideshowUI();
      return;
    }
  }

  // No visible images
  stopSlideshow({ silent: true });
}

function startSlideshow(opts = {}) {
  if (!checkImageLoaded()) return;
  if (visibleImageCount() <= 0) return;

  const lang = (state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en;

  const wasActive = state.slideshowActive;
  state.slideshowActive = true;
  state.slideshowPlaying = true;
  document.body.classList.add('slideshow-active');

  // Enter immersive fullscreen once when starting (optional)
  const wantFs = opts.enterFullscreen !== undefined ? opts.enterFullscreen : isSlideshowEnterFs();
  if (wantFs && !state.isGhost) {
    state.slideshowEnteredFs = true;
    if (typeof applyImmersiveFullscreen === 'function') {
      applyImmersiveFullscreen(true);
    } else if (typeof toggleFullscreen === 'function') {
      toggleFullscreen();
    }
  }

  // Always fit for a clean presentation (reflow after dock hides via .slideshow-active)
  state.viewMode = 'fit';
  const refit = () => {
    const im = state.images[state.current];
    if (im && im.w && im.h) fitToWindow(im.w, im.h);
  };
  refit();
  requestAnimationFrame(refit);

  // Presentation chrome: hidden until the user moves the mouse
  updateSlideshowUI({ hide: true });
  hideFloatingChromeForSlideshow();
  if (typeof updateNavVisibility === 'function') updateNavVisibility();
  scheduleSlideshowTick();

  syncGhostCloseTooltip();

  if (!wasActive && typeof showToast === 'function') {
    const modeTip = state.isGhost
      ? (t.toast_slideshow_start_fs || t.toast_slideshow_start || 'SLIDESHOW')
      : (t.toast_slideshow_start_win || t.toast_slideshow_start || 'SLIDESHOW');
    showToast(modeTip, 'info', 1000);
  }
}

function pauseSlideshow() {
  if (!state.slideshowActive) return;
  state.slideshowPlaying = false;
  clearSlideshowTimer();
  updateSlideshowUI(); // no force reveal
}

function resumeSlideshow() {
  if (!state.slideshowActive) {
    startSlideshow();
    return;
  }
  state.slideshowPlaying = true;
  scheduleSlideshowTick();
  updateSlideshowUI(); // keep current visibility
}

/** Fade all floating chrome (incl. presentation bar). Mouse move re-shows via resetHudTimer. */
function hideFloatingChromeForSlideshow() {
  clearTimeout(hudTimer);
  const fade = (id, cls) => {
    const el = $(id);
    if (el) el.classList.add(cls);
  };
  fade('slideshow-hud', 'hud-hidden-fade');
  fade('ghost-close', 'hud-hidden-fade');
  fade('viewer-filename', 'hud-hidden-fade');
  fade('nav-container', 'hud-hidden-fade');
  fade('zoom-hud', 'hud-hidden-fade');
  const kbd = $('kbd-hint');
  if (kbd && state.isGhost) kbd.classList.add('hud-hidden');
  const zh = $('zoom-hud');
  if (zh) zh.classList.remove('visible');

  // Re-arm hide timer only after next mouse reveal (mousemove → resetHudTimer)
}

function toggleSlideshowPlay() {
  if (!state.slideshowActive) {
    startSlideshow();
    return;
  }
  if (state.slideshowPlaying) pauseSlideshow();
  else resumeSlideshow();
}

/**
 * End presentation. Optionally leave fullscreen only if we entered FS for this slideshow
 * (or re-entered FS while it was running). X / Enter alone never call this.
 * @param {{ silent?: boolean, keepFullscreen?: boolean }} [opts]
 */
function stopSlideshow(opts = {}) {
  const wasActive = state.slideshowActive;
  clearSlideshowTimer();
  state.slideshowActive = false;
  state.slideshowPlaying = false;
  document.body.classList.remove('slideshow-active');

  // Leave FS only if presentation "owns" it (started in FS or user re-entered FS while playing)
  const leaveFs = state.slideshowEnteredFs && state.isGhost && opts.keepFullscreen !== true;
  state.slideshowEnteredFs = false;

  updateSlideshowUI();
  syncGhostCloseTooltip();

  if (leaveFs && typeof applyImmersiveFullscreen === 'function') {
    // keepFullscreen path handled above; avoid re-entrancy on slideshowEnteredFs
    applyImmersiveFullscreen(false);
  }

  // Dock strip + side nav return — reflow fit layout
  if (wasActive) {
    if (typeof updateNavVisibility === 'function') updateNavVisibility();
    requestAnimationFrame(() => {
      const im = state.images[state.current];
      if (im && im.w && im.h && state.viewMode === 'fit') fitToWindow(im.w, im.h);
    });
  }

  if (wasActive && !opts.silent) {
    const lang = (state.settings.app && state.settings.app.language) || 'en';
    const t = I18N[lang] || I18N.en;
    if (typeof showToast === 'function') {
      showToast(t.toast_slideshow_stop || 'SLIDESHOW STOPPED', 'info', 800);
    }
  }
}

/**
 * Sync slideshow chrome.
 * @param {{ reveal?: boolean, hide?: boolean }} [opts]
 *   reveal — show bar (mouse interaction / explicit)
 *   hide — start faded (presentation idle; mouse will reveal)
 * Never thrash classes on every slide tick.
 */
function updateSlideshowUI(opts = {}) {
  const hud = $('slideshow-hud');
  if (!hud) return;
  const active = !!state.slideshowActive;
  hud.hidden = !active;
  hud.setAttribute('aria-hidden', active ? 'false' : 'true');
  hud.classList.toggle('visible', active);

  if (!active) {
    hud.classList.remove('hud-hidden-fade', 'visible');
  } else if (opts.hide) {
    hud.classList.add('hud-hidden-fade');
  } else if (opts.reveal) {
    hud.classList.remove('hud-hidden-fade');
  }
  // else: leave current fade state alone (advance/tick only updates labels)

  const playBtn = $('ss-play');
  if (playBtn) {
    playBtn.classList.toggle('is-playing', state.slideshowPlaying);
    const lang = (state.settings.app && state.settings.app.language) || 'en';
    const t = I18N[lang] || I18N.en;
    const tip = state.slideshowPlaying
      ? (t.ss_pause_title || 'Pause (Space)')
      : (t.ss_play_title || 'Play (Space)');
    setCyberTooltip(playBtn, tip);
    playBtn.setAttribute('aria-label', tip);
    const iconPlay = playBtn.querySelector('.ss-ico-play');
    const iconPause = playBtn.querySelector('.ss-ico-pause');
    if (iconPlay) iconPlay.hidden = !!state.slideshowPlaying;
    if (iconPause) iconPause.hidden = !state.slideshowPlaying;
  }

  const loopBtn = $('ss-loop');
  if (loopBtn) {
    const loopOn = isSlideshowLoop();
    loopBtn.classList.toggle('active', loopOn);
    loopBtn.setAttribute('aria-pressed', loopOn ? 'true' : 'false');
    const lang = (state.settings.app && state.settings.app.language) || 'en';
    const t = I18N[lang] || I18N.en;
    setCyberTooltip(loopBtn, loopOn
      ? (t.ss_loop_on_title || 'Loop: on (click to disable)')
      : (t.ss_loop_off_title || 'Loop: off (click to enable)'));
  }

  const sel = $('ss-interval');
  if (sel) {
    const ms = getSlideshowIntervalMs();
    if (String(sel.value) !== String(ms)) sel.value = String(ms);
  }

  // Counter only — cheap update, no class thrashing
  const status = $('ss-status');
  if (status && state.images.length && state.current >= 0) {
    status.textContent = (state.current + 1) + ' / ' + state.images.length;
  } else if (status) {
    status.textContent = '';
  }

  const tb = $('btn-slideshow');
  if (tb) {
    tb.classList.toggle('active', state.slideshowActive && state.slideshowPlaying);
  }

  syncGhostCloseTooltip();
}

function toggleSlideshowLoop() {
  setSlideshowLoop(!isSlideshowLoop());
  const lang = (state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en;
  if (typeof showToast === 'function') {
    showToast(
      isSlideshowLoop()
        ? (t.toast_slideshow_loop_on || 'LOOP ON')
        : (t.toast_slideshow_loop_off || 'LOOP OFF'),
      'info',
      800
    );
  }
}

function cycleSlideshowInterval() {
  const cur = getSlideshowIntervalMs();
  const i = SLIDESHOW_INTERVALS.indexOf(cur);
  const next = SLIDESHOW_INTERVALS[(i + 1) % SLIDESHOW_INTERVALS.length];
  setSlideshowIntervalMs(next);
  const lang = (state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en;
  const sec = (next / 1000).toFixed(next % 1000 === 0 ? 0 : 1);
  if (typeof showToast === 'function') {
    showToast((t.toast_slideshow_interval || 'INTERVAL: {sec}s').replace('{sec}', sec), 'info', 800);
  }
}

// ── UI UPDATES ──
function visibleImageCount() {
  return state.images.filter(im => !im.hidden).length;
}

function updateNavVisibility() {
  const nav = $('nav-container');
  if (!nav) return;
  // Side arrows hidden entirely during presentation (slideshow HUD has prev/next)
  if (state.slideshowActive) {
    nav.classList.add('nav-useless');
    return;
  }
  nav.classList.toggle('nav-useless', visibleImageCount() <= 1);
}

function updateCounter() {
  const el = $('img-counter');
  if (!el) return;

  if (state.images.length === 0) {
    el.textContent = '';
    el.removeAttribute('data-tooltip');
    el.classList.remove('cyber-tooltip');
    updateNavVisibility();
    syncEmptyState();
    return;
  }

  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en;

  const currentNum = state.current + 1;
  const totalNum = state.images.length;

  const labelText = currentNum + ' / ' + totalNum;

  let tooltipText = t.image_counter_tooltip || 'Current image: {current} | Total in folder: {total}';
  tooltipText = tooltipText.replace('{current}', currentNum).replace('{total}', totalNum);

  el.textContent = labelText;
  setCyberTooltip(el, tooltipText);
  el.classList.add('tooltip-top');

  updateNavVisibility();
  syncEmptyState();
  if (state.slideshowActive && typeof updateSlideshowUI === 'function') {
    updateSlideshowUI();
  }
}

/**
 * Empty-state chrome: body.empty-state drives CSS (hide hints/status/nav noise).
 * Toolbar tools that need an image are disabled (and hidden via CSS in empty).
 */
function syncEmptyState() {
  const empty = !state.images.length || state.current < 0;
  if (empty && document.body.classList.contains('image-error')) {
    // Returning from an invalid favorite to an empty gallery must show only
    // the welcome banner, never the stale invalid-image banner as well.
    clearImageError();
  }
  document.body.classList.toggle('empty-state', empty);

  const needs = document.querySelectorAll('#kbd-hint .needs-image, #kbd-hint .needs-image .kbd-btn');
  needs.forEach((el) => {
    if (el.classList && el.classList.contains('kbd-sep')) return;
    if (el.tagName === 'BUTTON' || el.classList.contains('kbd-btn')) {
      el.disabled = empty;
      el.classList.toggle('is-disabled', empty);
      if (empty) el.setAttribute('aria-disabled', 'true');
      else el.removeAttribute('aria-disabled');
    }
  });

  // Nested buttons inside .control-group.needs-image
  ['btn-show-folder', 'btn-fit-hud', 'btn-orig-hud', 'btn-fs-hud', 'btn-slideshow',
    'btn-rot-l', 'btn-rot-r', 'btn-crop', 'btn-resize', 'btn-adjust', 'btn-props', 'btn-copy', 'btn-trash', 'btn-print', 'btn-fav',
    'btn-center', 'btn-go-start', 'btn-go-end'
  ].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.disabled = empty;
    el.classList.toggle('is-disabled', empty);
  });

  updateHUDStates();
  updateCenterBtnVisibility();
}

/**
 * Invalid-image state: when the current image fails to decode (corrupted,
 * not a real image, or an unsupported container), show the error banner over
 * the canvas and disable the toolbar tools that can't operate without pixels.
 * Unlike empty-state (0 images), here state.images has an entry but the frame
 * is blank, so chrome is driven by a dedicated body.image-error class.
 *
 * Tools kept enabled (allowlist): Abrir, Propiedades, Borrar, Mostrar ruta.
 * Everything else under #kbd-hint (needs-image + rotate) is disabled.
 */
const IMAGE_ERROR_TOOLBAR_KEEP = new Set(['btn-open-hud', 'btn-props', 'btn-trash', 'btn-show-folder']);

function applyImageErrorToolbars(active) {
  const buttons = document.querySelectorAll('#kbd-hint button');
  buttons.forEach((b) => {
    if (!b || !b.id) return;
    if (IMAGE_ERROR_TOOLBAR_KEEP.has(b.id)) return;
    if (active) {
      b.disabled = true;
      b.classList.add('is-disabled');
      b.setAttribute('aria-disabled', 'true');
    } else {
      // Only re-enable tools that would be live for a real image. Empty-state
      // owns the 0-image case (it re-disables as needed via syncEmptyState).
      const empty = !state.images.length || state.current < 0;
      if (!empty) {
        b.disabled = false;
        b.classList.remove('is-disabled');
        b.removeAttribute('aria-disabled');
      }
    }
  });
}

function setImageError(im) {
  document.body.classList.add('image-error');
  applyImageErrorToolbars(true);

  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en || {};
  const sub = $('error-banner-sub');
  if (sub) {
    const name = (im && im.file && im.file.name) ? im.file.name : '';
    const tpl = t.error_image_sub;
    if (name && tpl) sub.textContent = tpl.replace('{name}', name);
    else sub.textContent = (lang === 'es'
      ? 'No se pudo cargar la imagen. El archivo está dañado, no es una imagen o el formato no es compatible.'
      : 'Could not load the image. The file is corrupted, not an image, or uses an unsupported format.');
  }
  if (mainImg) {
    mainImg.classList.remove('loaded');
    mainImg.style.opacity = '0';
  }
  if (typeof updateSaveButton === 'function') updateSaveButton();
  if (typeof updateFileStats === 'function') updateFileStats();
}

function clearImageError() {
  document.body.classList.remove('image-error');
  applyImageErrorToolbars(false);
  const banner = $('error-banner');
  if (banner) { banner.hidden = true; banner.setAttribute('aria-hidden', 'true'); }
  if (mainImg) mainImg.style.opacity = '';
}

// ── MOUSE / TOUCH ──
viewerWrap.addEventListener('wheel', e => {
  if (state.images.length === 0 || state.isCropping) return;
  e.preventDefault();
  const delta = -e.deltaY;
  zoomAt(delta, e.clientX, e.clientY);
}, { passive: false });

viewerWrap.addEventListener('mousedown', e => {
  if (e.target.closest('#kbd-hint') || e.target.closest('#topbar') || e.target.closest('#sidebar')) return;
  if (e.button !== 0 || state.images.length === 0 || state.isCropping) return;
  state.dragging = true;
  state.dragStartX = e.clientX;
  state.dragStartY = e.clientY;
  state.panStartX  = state.panX;
  state.panStartY  = state.panY;
  viewerWrap.classList.add('dragging');
});

window.addEventListener('mousemove', e => {
  if (!state.dragging) return;
  registerCanvasInteraction();
  state.panX = state.panStartX + (e.clientX - state.dragStartX);
  state.panY = state.panStartY + (e.clientY - state.dragStartY);
  applyTransform(false);
});

window.addEventListener('mouseup', () => {
  state.dragging = false;
  viewerWrap.classList.remove('dragging');
});

// Double click action (configurable: fullscreen / toggle zoom (fit<->1:1) / fit / original / none)
viewerWrap.addEventListener('dblclick', e => {
  if (e.target.closest('#kbd-hint') || e.target.closest('#topbar') || e.target.closest('#sidebar') || e.target.closest('#nav-container')) return;
  // The drop-zone buttons already handle their own clicks; don't open the dialog twice on double-click.
  if (e.target.closest('#btn-drop-open') || e.target.closest('#btn-drop-paste')) return;
  const action = state.settings && state.settings.app ? normalizeDblClickAction(state.settings.app.dblClickAction) : 'fullscreen';
  if (action === 'none') return;
  // Empty canvas: double-click opens an image (Photoshop-style), independent of the action setting.
  if (state.images.length === 0) {
    openImageDialog();
    return;
  }
  if (action === 'fullscreen') {
    toggleFullscreen();
    return;
  }
  const im = state.images[state.current];
  if (!im || !im.w) return;
  const vw = viewerWrap.clientWidth, vh = viewerWrap.clientHeight;
  const fitScale = Math.min((vw - 24) / im.w, (vh - 24) / im.h, 1);
  if (action === 'fit') {
    state.viewMode = 'fit';
    state.zoom = fitScale;
    state.panX = 0;
    state.panY = 0;
    applyTransform(true);
    return;
  }
  if (action === 'original') {
    setOriginalView(true);
    return;
  }
  // action === 'toggle-zoom' (legacy fit <-> 1:1)
  if (state.viewMode === 'original') {
    state.viewMode = 'fit';
    state.zoom = fitScale;
    state.panX = 0;
    state.panY = 0;
  } else {
    setOriginalView(true);
    return;
  }
  applyTransform(true);
});

// Touch pinch
let lastPinchDist = 0;
viewerWrap.addEventListener('touchstart', e => {
  if (e.target.closest('#kbd-hint') || e.target.closest('#topbar') || e.target.closest('#sidebar')) return;
  if (e.touches.length === 2) {
    lastPinchDist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
  } else if (e.touches.length === 1) {
    state.dragging = true;
    state.dragStartX = e.touches[0].clientX;
    state.dragStartY = e.touches[0].clientY;
    state.panStartX  = state.panX;
    state.panStartY  = state.panY;
  }
});

viewerWrap.addEventListener('touchmove', e => {
  e.preventDefault();
  if (e.touches.length === 2) {
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const cx = (e.touches[0].clientX + e.touches[1].clientX) / 2;
    const cy = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    if (lastPinchDist > 0) {
      const ratio = dist / lastPinchDist;
      const rect = viewerWrap.getBoundingClientRect();
      const ox = cx - rect.left - rect.width / 2;
      const oy = cy - rect.top  - rect.height / 2;
      state.viewMode = 'custom';
      const oldZoom = state.zoom;
      const baseZoom = getOriginalZoom();
      const newZoom = Math.max(ZOOM_MIN * baseZoom, Math.min(ZOOM_MAX * baseZoom, state.zoom * ratio));
      const r = newZoom / oldZoom;
      state.panX = ox + (state.panX - ox) * r;
      state.panY = oy + (state.panY - oy) * r;
      state.zoom = newZoom;
      applyTransform(false);
    }
    lastPinchDist = dist;
  } else if (e.touches.length === 1 && state.dragging) {
    state.panX = state.panStartX + (e.touches[0].clientX - state.dragStartX);
    state.panY = state.panStartY + (e.touches[0].clientY - state.dragStartY);
    applyTransform(false);
  }
}, { passive: false });

viewerWrap.addEventListener('touchend', e => {
  if (e.touches.length < 2) lastPinchDist = 0;
  if (e.touches.length === 0) state.dragging = false;
});

// ── KEYBOARD ──
document.addEventListener('keydown', e => {
  // Escape always closes overlays, even when an input has focus
  if (e.key === 'Escape' || e.key === 'Esc') {
    const menuPanel = $('main-menu');
    if (menuPanel && menuPanel.classList.contains('open')) {
      menuPanel.classList.remove('open');
      const btnMenu = $('btn-menu');
      if (btnMenu) btnMenu.classList.remove('open');
      e.preventDefault();
      return;
    }
    // Cancel crop (Esc) before other escape actions
    if (state.isCropping) {
      const cancelBtn = $('btn-crop-cancel');
      if (cancelBtn) cancelBtn.click();
      e.preventDefault();
      return;
    }
    // Discard pending rotation before other escapes
    if (state.hasChanges && !state.isCropping) {
      discardPendingChanges();
      e.preventDefault();
      return;
    }
    // Stop slideshow first (may also leave FS if we entered for it)
    if (state.slideshowActive) {
      stopSlideshow();
      e.preventDefault();
      return;
    }
    if (state.isGhost) toggleFullscreen();
    closeModal('modal-config');
    closeModal('modal-resize');
    closeModal('modal-adjust');
    closeModal('modal-properties');
    closeModal('modal-print-export');
    closeModal('modal-cyber-confirm');
    const aboutOverlay = $('about-overlay');
    if (aboutOverlay) aboutOverlay.classList.remove('active');
    e.preventDefault();
    return;
  }

  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // Enter applies/confirms in modals
  if (e.key === 'Enter') {
    if (state.isCropping) {
      const confirmBtn = $('btn-crop-confirm');
      if (confirmBtn && !confirmBtn.disabled) confirmBtn.click();
      e.preventDefault();
      return;
    }
    if ($('modal-resize').classList.contains('active')) {
      const btn = $('btn-confirm-resize');
      if (btn && !btn.disabled) btn.click();
      e.preventDefault();
      return;
    }
    if ($('modal-adjust').classList.contains('active')) {
      const btn = $('btn-confirm-adjust');
      if (btn && !btn.disabled) btn.click();
      e.preventDefault();
      return;
    }
    if ($('modal-cyber-confirm').classList.contains('active')) {
      const btn = $('btn-confirm-ok');
      if (btn) btn.click();
      e.preventDefault();
      return;
    }
    if ($('modal-print-export').classList.contains('active')) {
      const btn = $('btn-print-now');
      if (btn) btn.click();
      e.preventDefault();
      return;
    }
    if ($('modal-properties').classList.contains('active')) {
      const btn = $('props-close-btn');
      if (btn) btn.click();
      e.preventDefault();
      return;
    }
  }

  if (state.isCropping) return; // modo Crop: el recorte es la unica accion activa
  const pendingRotation = state.currentRotation !== 0 && state.hasChanges;
  const isCtrl = e.ctrlKey || e.metaKey;

  if (pendingRotation) {
    const key = e.key.toLowerCase();
    if (key === 'enter') {
      e.preventDefault();
      if (checkImageLoaded()) saveCurrent();
      return;
    }
    if (key === 'q' || key === 'e') {
      // allow only rotation controls + save/cancel while the preview is pending
    } else {
      e.preventDefault();
      return;
    }
  }

  // Shortcuts globales
  if (isCtrl) {
    switch (e.key.toLowerCase()) {
      case 'o': 
        e.preventDefault(); 
        if (e.shiftKey) {
          if (checkImageLoaded()) $('btn-show-folder').click();
        } else {
          openImageDialog();
        }
        break;
      case 'f':
        e.preventDefault();
        // Ctrl+Shift+F = open folder; Ctrl+F = fullscreen
        if (e.shiftKey) openFolderDialog();
        else if (checkImageLoaded()) toggleFullscreen();
        break;
      case 's': e.preventDefault(); if (checkImageLoaded()) showSaveAsDialog(); break;
      case 'p': e.preventDefault(); if (checkImageLoaded()) openPrintExportModal(); break;
      case 'c': e.preventDefault(); if (checkImageLoaded()) copyToClipboard(); break;
      case 'v': e.preventDefault(); pasteFromClipboard(); break;
      case 'd': e.preventDefault(); if (checkImageLoaded()) toggleFavorite(); break;
      case ',': e.preventDefault(); openConfig(); break;
      case 'i':
        e.preventDefault();
        if (e.shiftKey) {
          if (isElectron && window.electronAPI && window.electronAPI.openDevTools) {
            window.electronAPI.openDevTools();
          }
        } else if (checkImageLoaded()) {
          openPropertiesForCurrent();
        }
        break;
    }
  }

  switch (e.key.toLowerCase()) {
    case ' ':
      if (!isCtrl) {
        e.preventDefault();
        if (state.slideshowActive) toggleSlideshowPlay();
        else next();
      }
      break;
    case 'arrowright': case 'arrowdown': case 'd':
      if (!isCtrl) {
        e.preventDefault();
        if (state.slideshowActive) slideshowAdvance(1);
        else next();
      }
      break;
    case 'arrowleft':  case 'arrowup':   case 'a': 
      if (!isCtrl) {
        e.preventDefault();
        if (state.slideshowActive) slideshowAdvance(-1);
        else prev();
      }
      break;
    case 'q': if (checkImageLoaded()) rotate(-90); break;
    case 'e': if (checkImageLoaded()) rotate(90); break;
    case 'c': 
      if (!isCtrl) {
        e.preventDefault();
        if (checkImageLoaded()) {
          const btn = $('btn-crop');
          if (btn) btn.click();
        }
      }
      break;
    case 'r':
      if (!isCtrl) {
        e.preventDefault();
        if (checkImageLoaded()) {
          const btn = $('btn-resize');
          if (btn) btn.click();
        }
      }
      break;
    case 'j':
      if (!isCtrl) {
        e.preventDefault();
        if (checkImageLoaded()) {
          const btn = $('btn-adjust');
          if (btn) btn.click();
        }
      }
      break;
    case 'h':
      if (!isCtrl) {
        e.preventDefault();
        if (checkImageLoaded()) flipImage(e.shiftKey ? 'v' : 'h');
      }
      break;
    case 'g': case 'G': if (!isCtrl && checkImageLoaded()) toggleFullscreen(); break;
    case 's':
      if (!isCtrl && checkImageLoaded()) {
        e.preventDefault();
        toggleSlideshowPlay();
      }
      break;
    case 'f': if (!isCtrl && checkImageLoaded()) $('btn-fit-hud').click(); break;
    case '1': if (!isCtrl && checkImageLoaded()) $('btn-orig-hud').click(); break;
    case 'delete':
      if (checkImageLoaded()) trashCurrentImage();
      break;
    case 'enter':
      e.preventDefault();
      if (checkImageLoaded()) toggleFullscreen();
      break;
    case '+': case '=':
      if (checkImageLoaded()) zoomAt(150, viewerWrap.clientWidth/2, viewerWrap.clientHeight/2);
      break;
    case '-':
      if (checkImageLoaded()) zoomAt(-150, viewerWrap.clientWidth/2, viewerWrap.clientHeight/2);
      break;
    case '0':
      if (checkImageLoaded()) {
        const im = state.images[state.current];
        if (im && im.w) { state.viewMode = 'fit'; fitToWindow(im.w, im.h); }
      }
      break;
  }
});

function handleFileDeleted(index) {
  if (index < 0 || index >= state.images.length) return;
  const im = state.images[index];

  if (im.file && im.file.path) {
    const p = im.file.path;
    const favs = state.settings.app.favorites || [];
    const newFavs = favs.filter(x => x !== p);
    if (newFavs.length !== favs.length) {
      state.settings.app.favorites = newFavs;
      if (isElectron) {
        window.electronAPI.saveSettings(state.settings.app);
      }
    }
    
    if (state.showingFavs) {
      const nidx = state.nonFavImages.findIndex(x => x.file && x.file.path === p);
      if (nidx !== -1) {
        state.nonFavImages.splice(nidx, 1);
        if (state.nonFavCurrent >= state.nonFavImages.length) {
          state.nonFavCurrent = state.nonFavImages.length - 1;
        }
      }
    }
  }

  if (im.url) URL.revokeObjectURL(im.url);
  state.images.splice(index, 1);
  
  if (state.images.length === 0) {
    syncCurrentIndex(-1);
    mainImg.classList.remove('loaded');
    mainImg.src = '';
    dropZone.style.display = 'flex';
    sidebar.innerHTML = '';
    const viewerFilename = $('viewer-filename');
    if (viewerFilename) viewerFilename.textContent = '';
  } else {
    const nextIdx = Math.min(index, state.images.length - 1);
    syncCurrentIndex(nextIdx);
    buildSidebar();
    showImage(nextIdx, null);
  }
  updateCounter();
}

async function trashCurrentImage() {
  const idx = state.current;
  if (idx === -1) return;
  const im = state.images[idx];
  if (!im) return;

  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  showCyberConfirm({
    title: lang === 'es' ? 'Mover a la papelera' : 'Move to Trash',
    message: lang === 'es' 
      ? '¿Estás seguro de que quieres mover esta imagen a la papelera de reciclaje?' 
      : 'Are you sure you want to move this image to the Recycle Bin?',
    detail: im.file ? im.file.name : (im.url || ''),
    danger: true,
    onConfirm: async () => {
      if (isElectron && im.file && im.file.path) {
        try {
          const result = await window.electronAPI.moveToTrash(im.file.path);
          if (result && result.success) {
            handleFileDeleted(idx);
          }
        } catch (err) {
          console.error('Error al mover a la papelera:', err);
        }
      } else {
        handleFileDeleted(idx);
      }
    }
  });
}

function canvasForCurrentImage() {
  if (state.current === -1 || !mainImg.complete || mainImg.naturalWidth === 0) return null;
  const iw = mainImg.naturalWidth;
  const ih = mainImg.naturalHeight;
  const rotation = state.currentRotation || 0;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  if (rotation === 90 || rotation === 270) {
    canvas.width = ih;
    canvas.height = iw;
  } else {
    canvas.width = iw;
    canvas.height = ih;
  }

  ctx.save();
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  ctx.drawImage(mainImg, -iw / 2, -ih / 2);
  ctx.restore();
  return canvas;
}

async function copyToClipboard() {
  const idx = state.currentIdx;
  if (idx === -1) return;
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const i18nLang = I18N[lang] || I18N.en || {};

  try {
    const canvas = canvasForCurrentImage();
    if (canvas && isElectron && window.electronAPI.copyImageBuffer) {
      const dataUrl = canvas.toDataURL('image/png');
      await window.electronAPI.copyImageBuffer(dataUrl.substring(dataUrl.indexOf(',') + 1));
    } else if (canvas && navigator.clipboard && navigator.clipboard.write) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error('canvas export failed');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    } else {
      throw new Error('clipboard unavailable');
    }
    showToast(i18nLang.toast_copied || 'IMAGEN COPIADA', 'success');
  } catch (err) {
    console.error('Error al copiar:', err);
    showToast(i18nLang.toast_copy_error || 'ERROR AL COPIAR', 'error');
  }
}

function clipboardDefaultName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `clipboard-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

function imageDiskPath(im) {
  if (!im) return null;
  return (im.file && im.file.path) || im.path || null;
}

function bindImageToDiskPath(im, diskPath, { revokeBlob = true } = {}) {
  if (!im || !diskPath) return;
  const name = diskPath.split(/[\\/]/).pop();
  if (revokeBlob && im.url && String(im.url).startsWith('blob:')) {
    try { URL.revokeObjectURL(im.url); } catch (_) { /* ignore */ }
    im.url = null;
  }
  im.file = { name, path: diskPath, size: im.size || 0 };
  im.path = diskPath;
  im.fromClipboard = false;
  if (revokeBlob) {
    im.loaded = false;
  }
}

async function promptSavePathForImage(im) {
  if (!isElectron || !window.electronAPI.showSaveDialog) return null;
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const defaultName = (im && im.file && im.file.name) || clipboardDefaultName();
  const result = await window.electronAPI.showSaveDialog({
    title: lang === 'es' ? 'Guardar imagen' : 'Save image',
    defaultPath: defaultName,
    filters: [
      { name: 'PNG', extensions: ['png'] },
      { name: 'JPEG', extensions: ['jpg', 'jpeg'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  if (!result || result.canceled || !result.filePath) return null;
  // Keep blob URL alive until pixels are written / reloaded from disk
  bindImageToDiskPath(im, result.filePath, { revokeBlob: false });
  return result.filePath;
}

/**
 * Resolve a disk path for saving a modified image that has none yet (e.g. pasted
 * from clipboard). Unlike ensureImageDiskPath, this NEVER opens a dialog: it
 * builds a path under the OS Pictures folder (allowlisted by the IPC handler)
 * and lets save-image add the copy suffix + dedup, exactly like disk images.
 * Returns the base path (no suffix); the image entry is not mutated here.
 */
async function resolvePastedImagePath(im) {
  if (!isElectron || !window.electronAPI.getDefaultSaveDir) return null;
  let dir = '';
  try { dir = await window.electronAPI.getDefaultSaveDir(); } catch (_) { return null; }
  if (!dir) return null;
  const cur = (im && im.file && im.file.name) || clipboardDefaultName();
  const base = String(cur).replace(/\.[^.]+$/, '') || 'image';
  const dot = cur ? cur.lastIndexOf('.') : -1;
  const ext = (dot > 0) ? cur.slice(dot).toLowerCase() : '.png';
  return dir.replace(/[\\/]+$/, '') + '/' + base + ext;
}

async function ensureImageDiskPath(im) {
  const existing = imageDiskPath(im);
  if (existing) return existing;
  return promptSavePathForImage(im);
}

function insertPastedImage(blob, mime = 'image/png') {
  const name = clipboardDefaultName();
  const file = new File([blob], name, { type: mime || 'image/png' });
  const url = URL.createObjectURL(file);
  const im = {
    file: { name, path: null, size: blob.size || file.size || 0 },
    url,
    w: 0,
    h: 0,
    loaded: false,
    size: blob.size || file.size || 0,
    fromClipboard: true
  };

  dropZone.style.display = 'none';

  // Revoke previously un-saved paste blob URLs to prevent memory leaks
  if (Array.isArray(state.images)) {
    state.images.forEach(prev => {
      if (prev && prev.fromClipboard && prev.url && String(prev.url).startsWith('blob:')) {
        try { URL.revokeObjectURL(prev.url); } catch (_) { /* ignore */ }
      }
    });
  }

  // Clear previous folder image list and isolate the pasted image session
  state.images = [im];
  state.current = 0;
  state.currentIdx = 0;
  state.showingFavs = false;
  buildSidebar();
  showImage(0, null, true);

  updateSaveButton();
  syncEmptyState();
}

async function pasteFromClipboard() {
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en || {};

  try {
    if (isElectron && window.electronAPI.readClipboardImage) {
      const res = await window.electronAPI.readClipboardImage();
      if (!res || !res.ok) {
        showToast(t.toast_paste_empty || 'NO IMAGE IN CLIPBOARD', 'info');
        return;
      }
      const raw = atob(res.buffer);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const blob = new Blob([bytes], { type: res.mime || 'image/png' });
      insertPastedImage(blob, res.mime || 'image/png');
      showToast(t.toast_pasted || 'IMAGE PASTED', 'success');
      return;
    }

    if (!navigator.clipboard || !navigator.clipboard.read) {
      showToast(t.toast_paste_error || 'COULD NOT PASTE IMAGE', 'error');
      return;
    }
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      insertPastedImage(blob, type);
      showToast(t.toast_pasted || 'IMAGE PASTED', 'success');
      return;
    }
    showToast(t.toast_paste_empty || 'NO IMAGE IN CLIPBOARD', 'info');
  } catch (err) {
    console.error('Error pegando desde clipboard:', err);
    showToast(t.toast_paste_error || 'COULD NOT PASTE IMAGE', 'error');
  }
}

function checkImageLoaded() {
  if (state.current === -1 || !state.images.length) {
    const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
    const msg = I18N[lang]?.toast_load_image_first || 'LOAD AN IMAGE FIRST';
    showToast(msg, 'info');
    return false;
  }
  return true;
}

function dismissToasts() {
  document.querySelectorAll('.cyber-toast').forEach(el => el.remove());
  document.body.classList.remove('toast-active');
}

function showToast(txt, type = 'info', durationMs = 2500) {
  dismissToasts();

  const t = document.createElement('div');
  t.className = 'cyber-toast';
  
  let bg = 'rgba(0, 212, 255, 0.95)'; // Cyan por defecto (info)
  if (type === 'error') bg = 'rgba(255, 80, 80, 0.95)';
  if (type === 'success') bg = 'rgba(0, 255, 170, 0.95)';

  const duration = Math.max(400, Number(durationMs) || 2500);
  const fadeAt = Math.max(200, duration - 300);

  // Keep toasts near the top so they don't cover crop/action panels
  t.style.cssText = `
    position:fixed;top:64px;bottom:auto;left:50%;transform:translateX(-50%);
    background:${bg};color:#000;padding:8px 24px;
    border-radius:2px;font-family:var(--font-ui);
    font-size:12px;font-weight:700;z-index:12000;
    box-shadow: 0 0 20px ${bg.replace('0.95', '0.4')};
    animation: toast-in 220ms ease, toast-out 280ms ease ${fadeAt}ms forwards;
    pointer-events: none;
    letter-spacing: 1px;
    white-space: nowrap;
  `;
  t.textContent = txt;
  document.body.appendChild(t);
  document.body.classList.add('toast-active');
  setTimeout(() => { if (t.parentNode) t.remove(); document.body.classList.remove('toast-active'); }, duration);
}

const style = document.createElement('style');
style.textContent = `
  @keyframes toast-in { from { opacity:0; transform:translateX(-50%) translateY(-12px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }
  @keyframes toast-out { to { opacity:0; transform:translateX(-50%) translateY(-12px); } }
`;
document.head.appendChild(style);

// ── BUTTONS ──
$('btn-open-hud').addEventListener('click', () => { openImageDialog(); });
$('btn-drop-open').addEventListener('click', () => { openImageDialog(); });
if ($('btn-error-open')) $('btn-error-open').addEventListener('click', () => { openImageDialog(); });
const btnDropPaste = $('btn-drop-paste');
if (btnDropPaste) {
  btnDropPaste.addEventListener('click', () => {
    if (typeof pasteFromClipboard === 'function') pasteFromClipboard();
  });
}
fileInput.addEventListener('change', e => loadFiles(e.target.files));

$('btn-show-folder').addEventListener('click', () => {
  if (!checkImageLoaded()) return;
  const path = state.images[state.current].file.path;
  if (path && isElectron) {
    window.electronAPI.showItemInFolder(path);
  }
});

$('btn-fit-hud').addEventListener('click', () => {
  if (!checkImageLoaded()) return;
  const im = state.images[state.current];
  if (im && im.w) { state.viewMode = 'fit'; state.selectedViewMode = 'fit'; state.panX=0; state.panY=0; fitToWindow(im.w, im.h); }
});

$('btn-orig-hud').addEventListener('click', () => {
  if (!checkImageLoaded()) return;
  setOriginalView(true);
});

$('btn-fs-hud').addEventListener('click', () => {
  if (!checkImageLoaded()) return;
  toggleFullscreen();
});

$('btn-rot-l').addEventListener('click', () => {
  if (!checkImageLoaded()) return;
  rotate(-90);
});
$('btn-rot-r').addEventListener('click', () => {
  if (!checkImageLoaded()) return;
  rotate(90);
});
const btnCommit = $('btn-commit');
if (btnCommit) {
  btnCommit.addEventListener('click', () => {
    if (!checkImageLoaded()) return;
    saveCurrent();
  });
}
const btnDiscard = $('btn-discard');
if (btnDiscard) {
  btnDiscard.addEventListener('click', () => {
    if (!checkImageLoaded()) return;
    discardPendingChanges();
  });
}

$('btn-copy').addEventListener('click', () => {
  if (!checkImageLoaded()) return;
  copyToClipboard();
});

$('btn-trash').addEventListener('click', () => {
  if (!checkImageLoaded()) return;
  trashCurrentImage();
});



$('btn-prev').addEventListener('click', (e) => {
  e.currentTarget.blur();
  prev();
});
$('btn-next').addEventListener('click', (e) => {
  e.currentTarget.blur();
  next();
});

// Hide nav tooltips once the user starts clicking them, so they don't float
// while rapidly navigating images. Cleared on mouseleave so they reappear on re-entry.
['btn-prev', 'btn-next'].forEach(id => {
  const b = $(id);
  if (!b) return;
  b.addEventListener('mousedown', () => b.classList.add('tooltip-interacted'));
  b.addEventListener('mouseleave', () => b.classList.remove('tooltip-interacted'));
});
// Same idea for the zoom slider in the statusbar: dismiss its tooltip while dragging or
// keyboard-stepping it, and let it return once the pointer leaves / it loses focus.
(function () {
  const z = $('zoom-slider');
  const host = $('footer-zoom');
  if (!z || !host) return;
  const engage = () => host.classList.add('tooltip-interacted');
  const release = () => host.classList.remove('tooltip-interacted');
  z.addEventListener('mousedown', engage);
  z.addEventListener('input', engage);
  z.addEventListener('focus', engage);
  z.addEventListener('blur', release);
  host.addEventListener('mouseleave', release);
  window.addEventListener('pointerup', release);
}());

function sidebarHandleTooltipText(open) {
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en || {};
  if (open) {
    return t.sidebar_hide_tip || t.sidebar_title || 'Hide sidebar';
  }
  return t.sidebar_show_tip || 'Show folder images and enable scan';
}

function syncSidebarHandleTooltip() {
  const handle = $('sidebar-handle');
  if (!handle) return;
  setCyberTooltip(handle, sidebarHandleTooltipText(state.sidebarOpen));
  handle.classList.add('tooltip-right');
}

function setSidebarOpen(open) {
  document.body.classList.remove('sidebar-handle-hover');

  state.sidebarOpen = !!open;
  sidebar.style.display = state.sidebarOpen ? '' : 'none';
  document.body.classList.toggle('sidebar-open', state.sidebarOpen);

  const handle = $('sidebar-handle');
  if (handle) {
    handle.style.left = '';
    handle.style.pointerEvents = 'none';
    requestAnimationFrame(() => {
      handle.style.pointerEvents = '';
    });
  }
  const arrow = $('sidebar-handle-arrow');
  if (arrow) arrow.textContent = state.sidebarOpen ? '◂' : '▸';
  syncSidebarHandleTooltip();

  if (state.settings && state.settings.app) {
    state.settings.app.sidebarOpen = state.sidebarOpen;
    if (isElectron) {
      window.electronAPI.saveSettings(state.settings.app);
    }
  }

  if (state.sidebarOpen) {
    startBackgroundScan();
  } else {
    state.scanInProgress = false;
    updateThumbProgress(0, 0, true);
  }
}

function toolbarHandleTooltipText(open) {
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en || {};
  return open
    ? (t.toolbar_handle_hide || 'Hide action bar')
    : (t.toolbar_handle_show || 'Show action bar');
}

function syncToolbarHandle() {
  const handle = $('toolbar-handle');
  const chev = $('toolbar-handle-chevron');
  if (!handle) return;
  const open = state.toolbarOpen !== false;
  handle.setAttribute('aria-expanded', open ? 'true' : 'false');
  // Handle is only an “open” affordance when collapsed (menu hides the bar)
  if (chev) chev.textContent = '▴';
  setCyberTooltip(handle, toolbarHandleTooltipText(open));
  // Tooltip opens upward (default) — never tooltip-bottom near the statusbar
  handle.classList.remove('tooltip-bottom');
}

/**
 * Show/hide the bottom action bar (#kbd-hint).
 * Collapsed state is persisted; a handle pill reopens it in place (like sidebar).
 */
function setToolbarOpen(open) {
  state.toolbarOpen = open !== false;
  document.body.classList.toggle('toolbar-collapsed', !state.toolbarOpen);
  syncToolbarHandle();

  if (state.settings && state.settings.app) {
    state.settings.app.toolbarOpen = state.toolbarOpen;
    if (isElectron) window.electronAPI.saveSettings(state.settings.app);
  }

  // Refit image when dock height changes in window mode
  requestAnimationFrame(() => {
    const im = state.images[state.current];
    if (im && im.w && im.h && state.viewMode === 'fit' && typeof fitToWindow === 'function') {
      fitToWindow(im.w, im.h);
    } else if (typeof applyTransform === 'function') {
      applyTransform(false);
    }
  });
}

const toolbarHandleEl = $('toolbar-handle');
if (toolbarHandleEl) {
  toolbarHandleEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setToolbarOpen(!state.toolbarOpen);
  });
}

const sidebarHandleEl = $('sidebar-handle');
if (sidebarHandleEl) {
  const setHandleHover = (on) => {
    document.body.classList.toggle('sidebar-handle-hover', !!on);
  };
  sidebarHandleEl.addEventListener('mouseenter', () => setHandleHover(true));
  sidebarHandleEl.addEventListener('mouseleave', () => setHandleHover(false));
  sidebarHandleEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    setSidebarOpen(!state.sidebarOpen);
  });
}

// ── FULLSCREEN (OS exclusive + immersive ghost UI) ──
/**
 * Apply immersive UI (hide chrome, floating HUD). Internal name remains ghost-mode
 * for CSS compatibility; user-facing label is Fullscreen.
 * @param {boolean} on
 * @param {{ skipOs?: boolean }} [opts]
 */
function applyImmersiveFullscreen(on, opts = {}) {
  const want = !!on;
  if (state.isGhost === want) {
    // Still reflow image if size may have changed (e.g. OS fullscreen settled)
    scheduleFullscreenRefit();
    return;
  }

  document.body.classList.add('no-hud-transition');
  state.isGhost = want;
  if (want) state.isCropping = false; // AISLAMIENTO TOTAL
  document.body.classList.toggle('ghost-mode', want);

  // Presentation is independent of fullscreen:
  // entering FS during slideshow → Esc/stop may leave FS;
  // leaving FS (X) during slideshow → hybrid window presentation continues.
  if (state.slideshowActive) {
    state.slideshowEnteredFs = !!want;
  }

  updateHUDStates();
  syncGhostCloseTooltip();
  // Don't flash chrome on FS toggle during presentation — idle until mouse moves
  if (state.slideshowActive) {
    hideFloatingChromeForSlideshow();
  } else if (typeof resetHudTimer === 'function') {
    resetHudTimer();
  }

  // Forzar reflow para aplicar los cambios de layout instantáneamente sin animación
  document.body.offsetHeight;

  scheduleFullscreenRefit();

  // OS exclusive fullscreen (Electron) or Fullscreen API (browser fallback)
  if (!opts.skipOs) {
    if (isElectron && window.electronAPI && typeof window.electronAPI.setFullScreen === 'function') {
      window.electronAPI.setFullScreen(want).catch((err) => {
        console.error('setFullScreen failed:', err);
      });
    } else if (typeof document !== 'undefined') {
      try {
        if (want) {
          const el = document.documentElement;
          if (el && el.requestFullscreen && !document.fullscreenElement) {
            el.requestFullscreen().catch(() => { /* ignore */ });
          }
        } else if (document.fullscreenElement && document.exitFullscreen) {
          document.exitFullscreen().catch(() => { /* ignore */ });
        }
      } catch (_) { /* ignore */ }
    }
  }

  // Hybrid presentation: reflow fit when leaving/entering FS with slideshow still on
  if (state.slideshowActive) {
    requestAnimationFrame(() => {
      const im = state.images[state.current];
      if (im && im.w && im.h && state.viewMode === 'fit') fitToWindow(im.w, im.h);
    });
  }
}

/** Tooltip on the fullscreen X: clarify that presentation keeps running. */
function syncGhostCloseTooltip() {
  const btn = $('ghost-close');
  if (!btn) return;
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const t = I18N[lang] || I18N.en;
  let tip = t.ghost_close_title || 'Exit Fullscreen';
  if (state.slideshowActive) {
    tip = t.ghost_close_slideshow_title || tip;
  }
  setCyberTooltip(btn, tip);
}

function scheduleFullscreenRefit() {
  setTimeout(() => {
    document.body.classList.remove('no-hud-transition');
    const im = state.images[state.current];
    if (!im) return;
    if (state.viewMode === 'original') {
      state.zoom = getOriginalZoom();
      state.panX = 0;
      state.panY = 0;
      applyTransform(false);
    } else if (state.viewMode === 'fit') {
      fitToWindow(im.w, im.h);
    } else {
      applyTransform(false);
    }
  }, 100);
}

function toggleFullscreen() {
  applyImmersiveFullscreen(!state.isGhost);
}

// Browser / non-Electron: keep UI in sync with Fullscreen API
if (typeof document !== 'undefined' && !isElectron) {
  document.addEventListener('fullscreenchange', () => {
    applyImmersiveFullscreen(!!document.fullscreenElement, { skipOs: true });
  });
}

// ── DRAG & DROP ──
let dragCount = 0;

document.addEventListener('dragenter', e => {
  if (e.dataTransfer.types.includes('Files')) {
    e.preventDefault();
    dragCount++;
    app.classList.add('drag-over');
  }
});

document.addEventListener('dragleave', () => {
  dragCount--;
  if (dragCount <= 0) { dragCount = 0; app.classList.remove('drag-over'); }
});

document.addEventListener('dragover', e => e.preventDefault());

document.addEventListener('drop', e => {
  e.preventDefault();
  dragCount = 0;
  app.classList.remove('drag-over');
  if (e.dataTransfer.files.length) loadFiles(e.dataTransfer.files);
});

// ── RESIZE ──
window.addEventListener('resize', () => {
  if (state.images.length && state.current >= 0) {
    const im = state.images[state.current];
    if (im && im.w && state.viewMode === 'fit') fitToWindow(im.w, im.h);
    else if (im && im.w && state.viewMode === 'original') {
      state.zoom = getOriginalZoom();
      state.panX = 0;
      state.panY = 0;
      applyTransform(false);
    }
  }
});

// A Windows monitor change can update devicePixelRatio without a normal
// layout change. Re-arm the resolution query after every change so the
// calibrated original view follows 150% <-> 125% monitor moves.
function watchDisplayScale() {
  if (typeof window.matchMedia !== 'function') return;
  const dpr = Number(window.devicePixelRatio) || 1;
  const previousBaseZoom = screenCaptureZoom(dpr);
  const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
  const onChange = () => {
    if (typeof query.removeEventListener === 'function') query.removeEventListener('change', onChange);
    else if (typeof query.removeListener === 'function') query.removeListener(onChange);
    if (state.images.length && state.current >= 0) {
      const im = state.images[state.current];
      if (state.viewMode === 'original') {
        state.zoom = getOriginalZoom();
        state.panX = 0;
        state.panY = 0;
        applyTransform(false);
      } else if (state.viewMode === 'custom' && previousBaseZoom > 0) {
        // Keep custom zoom relative to the calibrated 1:1 size when the
        // window moves between monitors with different Windows scaling.
        state.zoom = (state.zoom / previousBaseZoom) * getOriginalZoom();
        applyTransform(false);
      } else if (state.viewMode === 'fit' && im && im.w) {
        fitToWindow(im.w, im.h);
      }
    }
    watchDisplayScale();
  };
  if (typeof query.addEventListener === 'function') query.addEventListener('change', onChange);
  else if (typeof query.addListener === 'function') query.addListener(onChange);
}
watchDisplayScale();

// ── MODAL HELPERS ──
function openModal(id) {
  const el = $(id);
  if (!el) return;
  el.classList.add('active');
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  const focusable = el.querySelector('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  if (focusable) {
    setTimeout(() => focusable.focus(), 0);
  }
}
function closeModal(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('active');
  el.removeAttribute('aria-modal');
  if (id === 'modal-config') clearConfigAccentPreview();
}
window.closeModal = closeModal;

function hexToRgbTriplet(hex) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return '0, 212, 255';
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some((n) => Number.isNaN(n))) return '0, 212, 255';
  return `${r}, ${g}, ${b}`;
}

function setConfigAccentPreview(hex) {
  const modal = $('modal-config');
  if (!modal || !hex) return;
  modal.style.setProperty('--preview-accent', hex);
  modal.style.setProperty('--preview-accent-rgb', hexToRgbTriplet(hex));
}

function clearConfigAccentPreview() {
  const modal = $('modal-config');
  if (!modal) return;
  modal.style.removeProperty('--preview-accent');
  modal.style.removeProperty('--preview-accent-rgb');
}

// Wire modal dismiss controls (CSP blocks inline onclick)
document.querySelectorAll('[data-close-modal]').forEach(btn => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    closeModal(btn.getAttribute('data-close-modal'));
  });
});
['modal-resize', 'modal-adjust', 'modal-config', 'modal-properties', 'modal-cyber-confirm', 'modal-print-export'].forEach(id => {
  const overlay = $(id);
  if (!overlay) return;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal(id);
  });
});

// ── PRINT / EXPORT PDF (Chromium engine, no native deps) ──
function bakePrintCanvas() {
  // Reuse the same rotation-only bake path as saveCurrent/saveAsPath so
  // print/PDF is WYSIWYG with what gets saved:
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const iw = mainImg.naturalWidth;
  const ih = mainImg.naturalHeight;
  const rotation = state.currentRotation;
  if (rotation === 90 || rotation === 270) {
    canvas.width = ih; canvas.height = iw;
  } else {
    canvas.width = iw; canvas.height = ih;
  }
  const rad = rotation * Math.PI / 180;
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(mainImg, -iw / 2, -ih / 2);
  return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
}

const PE_PAGE_IN_RATIO = {
  Fit: 0, Letter: 8.5 / 11, A4: 8.27 / 11.69, Legal: 8.5 / 14, A3: 11.69 / 16.54
};

const PE_PAGE_CM = {
  Letter: { width: 21.59, height: 27.94 },
  A4: { width: 21.0, height: 29.7 },
  Legal: { width: 21.59, height: 35.56 },
  A3: { width: 29.7, height: 42.0 }
};

const peState = { pageSize: "Letter", orientation: "Portrait", baked: null, similar: null };

function updatePrintPreview() {
  const paper = $("pe-paper");
  const marginBox = $("pe-margin-box");
  const img = $("pe-preview-img");
  const hint = $("pe-fit-hint");
  const marginsSection = $("pe-margins-section");
  const orientationSection = $("pe-orientation-section");
  const orientationButtons = orientationSection ? Array.from(orientationSection.querySelectorAll(".pe-chip")) : [];
  const pageCount = $("pe-page-count");
  if (!paper || !img) return;

  const b = peState.baked;
  if (b) {
    paper.setAttribute("data-empty", "false");
    img.src = b.dataUrl;
  } else {
    paper.setAttribute("data-empty", "true");
    img.removeAttribute("src");
  }

  // Paper aspect ratio matches the page orientation.
  let ratio = PE_PAGE_IN_RATIO[peState.pageSize] || PE_PAGE_IN_RATIO.Letter;
  if (peState.pageSize !== "Fit") {
    ratio = peState.orientation === "Landscape" ? 1 / ratio : ratio;
  } else if (b) {
    ratio = b.width / b.height;
  }
  paper.style.aspectRatio = ratio ? ratio.toFixed(4) : "0.7727";

  // Fit hides margins (page == image). Margins previewed dynamically.
  const isFit = peState.pageSize === "Fit";
  if (marginsSection) marginsSection.classList.toggle("is-disabled", isFit);
  if (orientationSection) orientationSection.classList.toggle("is-disabled", isFit);
  orientationButtons.forEach((btn) => {
    btn.disabled = isFit;
    btn.setAttribute("aria-disabled", isFit ? "true" : "false");
  });
  if (hint) hint.hidden = !isFit;

  if (marginBox) {
    if (isFit) {
      marginBox.style.top = "0";
      marginBox.style.bottom = "0";
      marginBox.style.left = "0";
      marginBox.style.right = "0";
    } else {
      const mTop = parseFloat($("pe-mtop").value) || 0;
      const mBottom = parseFloat($("pe-mbottom").value) || 0;
      const mLeft = parseFloat($("pe-mleft").value) || 0;
      const mRight = parseFloat($("pe-mright").value) || 0;

      const size = PE_PAGE_CM[peState.pageSize] || PE_PAGE_CM.Letter;
      let pageW = size.width;
      let pageH = size.height;
      if (peState.orientation === "Landscape") {
        pageW = size.height;
        pageH = size.width;
      }

      const pctTop = Math.min(45, (mTop / pageH) * 100);
      const pctBottom = Math.min(45, (mBottom / pageH) * 100);
      const pctLeft = Math.min(45, (mLeft / pageW) * 100);
      const pctRight = Math.min(45, (mRight / pageW) * 100);

      marginBox.style.top = `${pctTop.toFixed(2)}%`;
      marginBox.style.bottom = `${pctBottom.toFixed(2)}%`;
      marginBox.style.left = `${pctLeft.toFixed(2)}%`;
      marginBox.style.right = `${pctRight.toFixed(2)}%`;
    }
  }

  // Single page in v1 (Fit/contain never splits).
  if (pageCount) pageCount.textContent = "1";
}

function readPeOptions() {
  return {
    pageSize: peState.pageSize,
    orientation: peState.orientation,
    marginTop: parseFloat($("pe-mtop").value) || 0,
    marginBottom: parseFloat($("pe-mbottom").value) || 0,
    marginLeft: parseFloat($("pe-mleft").value) || 0,
    marginRight: parseFloat($("pe-mright").value) || 0
  };
}

async function doExportPdf() {
  if (!peState.baked) return;
  const lang = (state.settings && state.settings.app && state.settings.app.language) || "en";
  const t = I18N[lang] || I18N.en || {};
  showToast(lang === "es" ? "EXPORTANDO PDF..." : "EXPORTING PDF...", "info");
  try {
    const im = state.images[state.current];
    const sourcePath = imageDiskPath(im);
    let name = sourcePath ? sourcePath.split(/[\\/]/).pop() : ((im && im.file && im.file.name) || "image");
    name = name.replace(/\.[^.]+$/, "") || "image";
    const result = await window.electronAPI.exportImageToPdf({
      dataUrl: peState.baked.dataUrl,
      width: peState.baked.width,
      height: peState.baked.height,
      title: name,
      options: readPeOptions()
    });
    if (result && result.success) {
      showToast(t.toast_pdf_saved || "PDF SAVED", "success");
      closeModal("modal-print-export");
    } else if (result && result.canceled) {
      // user dismissed the save dialog — keep the modal open
    } else {
      showToast(t.toast_pdf_error || "PDF EXPORT ERROR", "error");
    }
  } catch (e) {
    console.error("exportPdf error:", e);
    showToast((I18N[lang] || I18N.en || {}).toast_pdf_error || "PDF EXPORT ERROR", "error");
  }
}

async function doPrint() {
  if (!peState.baked) return;
  const lang = (state.settings && state.settings.app && state.settings.app.language) || "en";
  const t = I18N[lang] || I18N.en || {};
  try {
    const im = state.images[state.current];
    const sourcePath = imageDiskPath(im);
    let name = sourcePath ? sourcePath.split(/[\\/]/).pop() : ((im && im.file && im.file.name) || "image");
    name = name.replace(/\.[^.]+$/, "") || "image";
    const result = await window.electronAPI.printImage({
      dataUrl: peState.baked.dataUrl,
      width: peState.baked.width,
      height: peState.baked.height,
      title: name,
      options: readPeOptions()
    });
    if (result && result.success) {
      closeModal("modal-print-export");
    } else if (result && result.error) {
      showToast(t.toast_print_error || "PRINT ERROR", "error");
    }
  } catch (e) {
    console.error("print error:", e);
    showToast((I18N[lang] || I18N.en || {}).toast_print_error || "PRINT ERROR", "error");
  }
}

function openPrintExportModal() {
  if (!isElectron) return;
  if (!checkImageLoaded()) return;
  // Close any other modal so the print/export one is the sole focus (mirrors
  // closeOpenModals discipline used by resize/adjust).
  ["modal-config", "modal-resize", "modal-adjust", "modal-properties", "modal-cyber-confirm"].forEach((id) => {
    if (typeof closeModal === "function") closeModal(id);
  });
  const peAboutOverlay = $("about-overlay");
  if (peAboutOverlay) peAboutOverlay.classList.remove("active");
  if (state.isCropping) return;

  let baked;
  try { baked = bakePrintCanvas(); }
  catch (e) {
    const lang = (state.settings && state.settings.app && state.settings.app.language) || "en";
    showToast((I18N[lang] || I18N.en || {}).toast_image_not_ready || "IMAGE NOT READY", "error");
    return;
  }
  peState.baked = baked;
  updatePrintPreview();
  openModal("modal-print-export");
}

(function initPrintExportModal() {
  function setChips(rootId, valueKey, afterSel) {
    const root = $(rootId);
    if (!root) return;
    root.querySelectorAll(".pe-chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        root.querySelectorAll(".pe-chip").forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        peState[valueKey] = btn.dataset[valueKey];
        if (afterSel) afterSel();
      });
    });
  }
  setChips("pe-page-sizes", "pageSize", updatePrintPreview);
  setChips("pe-orientations", "orientation", updatePrintPreview);

  ["pe-mtop", "pe-mbottom", "pe-mleft", "pe-mright"].forEach((id) => {
    const el = $(id);
    if (el) el.addEventListener("input", updatePrintPreview);
  });

  const bPdf = $("btn-print-pdf");
  if (bPdf) bPdf.addEventListener("click", doExportPdf);
  const bPrint = $("btn-print-now");
  if (bPrint) bPrint.addEventListener("click", doPrint);

  // Toolbar shortcut: open the modal via the docked Print button.
  const tbPrint = $("btn-print");
  if (tbPrint) tbPrint.addEventListener("click", () => { if (checkImageLoaded()) openPrintExportModal(); });
})();

// ── CONFIG LOGIC ──
function openConfig() {
  if (!state.settings) return;
  const s = state.settings.app;
  $('cfg-sidebar').checked = s.sidebarOpen;
  $('cfg-statusbar').checked = s.statusbarVisible;
  $('cfg-tray').checked = s.closeToTray;
  if ($('cfg-close-image-tray')) $('cfg-close-image-tray').checked = s.closeImageOnTray !== false;
  $('cfg-autostart').checked = s.autoStart;
  $('cfg-contextmenu').checked = s.contextMenuEnabled || false;
  $('cfg-multiple').checked = s.allowMultipleInstances === true;
  if ($('cfg-animated-gifs')) $('cfg-animated-gifs').checked = s.animateGifs !== false;
  $('cfg-show-filename').checked = s.showFileName !== false;
  $('cfg-lang').value = s.language || 'en';
  $('cfg-hotkey').value = (!s.toggleHotkey || s.toggleHotkey === 'disabled') ? '' : s.toggleHotkey;
  
  // Auto-hide settings (independent per element)
  $('cfg-banner-autohide').checked = s.bannerAutoHide !== false;
  if ($('cfg-dbl-click')) $('cfg-dbl-click').value = normalizeDblClickAction(s.dblClickAction);
  if ($('cfg-nav-zoom-mode')) $('cfg-nav-zoom-mode').value = normalizeNavZoomMode(s.navZoomMode);
  $('cfg-nav-autohide').checked = s.navAutoHide !== false;
  $('cfg-show-hints').checked = s.showTopHints !== false;
  $('cfg-disable-tooltips').checked = !!s.disableTooltips;
  $('cfg-hud-delay').value = s.hudAutoHideDelay;
  $('cfg-hud-delay-val').textContent = (s.hudAutoHideDelay / 1000).toFixed(1) + 's';
  const alphaBg = normalizeAlphaBackground(s.alphaBackground);
  if ($('cfg-alpha-bg')) $('cfg-alpha-bg').value = alphaBg;
  if ($('cfg-image-outline')) $('cfg-image-outline').checked = s.imageOutline === true;

  // Slideshow settings
  if ($('cfg-ss-interval')) $('cfg-ss-interval').value = String(getSlideshowIntervalMs());
  if ($('cfg-ss-loop')) $('cfg-ss-loop').checked = isSlideshowLoop();
  if ($('cfg-ss-fs')) $('cfg-ss-fs').checked = isSlideshowEnterFs();
  
  // Monitor selection
  if (isElectron) {
    window.electronAPI.getMonitors().then(displays => {
      const select = $('cfg-monitor');
      // Limpiar salvo el primero
      while (select.options.length > 1) select.remove(1);
      
      displays.forEach(d => {
        const opt = document.createElement('option');
        opt.value = d.id;
        opt.textContent = d.label;
        select.appendChild(opt);
      });
      select.value = s.preferredDisplayId || 'auto';
    });
  }

  // Set active color + live preview in modal
  const accent = s.accentColor || '#00d4ff';
  document.querySelectorAll('#modal-config .color-opt').forEach(opt => {
    opt.classList.toggle('active', opt.dataset.color === accent);
  });
  setConfigAccentPreview(accent);
  setConfigAutosaveState(true, { visible: false });
  setActiveConfigTab('general');

  openModal('modal-config');
}

function setActiveConfigTab(tabId) {
  const id = tabId || 'general';
  document.querySelectorAll('#modal-config [data-config-tab]').forEach(btn => {
    const active = btn.dataset.configTab === id;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('#modal-config [data-config-panel]').forEach(panel => {
    const active = panel.dataset.configPanel === id;
    panel.classList.toggle('active', active);
    panel.hidden = !active;
  });
}

document.querySelectorAll('#modal-config [data-config-tab]').forEach(btn => {
  btn.addEventListener('click', () => setActiveConfigTab(btn.dataset.configTab));
});

function setConfigAutosaveState(saved, { visible = true } = {}) {
  const badge = $('config-autosave-state');
  const pill = badge ? badge.closest('.config-autosave-pill') : null;
  if (!badge) return;
  if (pill) pill.classList.toggle('is-hidden', !visible);
  badge.classList.toggle('saving', !saved);
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const pack = I18N[lang] || I18N.en || {};
  badge.textContent = saved
    ? (pack.config_autosave_saved || 'Saved')
    : (pack.config_autosave_saving || 'Saving…');
}

function collectConfigSettings() {
  const activeOpt = document.querySelector('#modal-config .color-opt.active');
  const accentColor = (activeOpt && activeOpt.dataset.color) || '#00d4ff';
  return {
    sidebarOpen: $('cfg-sidebar').checked,
    statusbarVisible: $('cfg-statusbar').checked,
    closeToTray: $('cfg-tray').checked,
    closeImageOnTray: !!($('cfg-close-image-tray') && $('cfg-close-image-tray').checked),
    autoStart: $('cfg-autostart').checked,
    preferredDisplayId: $('cfg-monitor').value,
    language: $('cfg-lang').value,
    accentColor: accentColor,
    contextMenuEnabled: $('cfg-contextmenu').checked,
    allowMultipleInstances: $('cfg-multiple').checked,
    animateGifs: !!($('cfg-animated-gifs') && $('cfg-animated-gifs').checked),
    showFileName: $('cfg-show-filename').checked,
    toggleHotkey: $('cfg-hotkey') ? ($('cfg-hotkey').value.trim() || 'disabled') : 'disabled',
    bannerAutoHide: $('cfg-banner-autohide').checked,
    navAutoHide: $('cfg-nav-autohide').checked,
    showTopHints: $('cfg-show-hints').checked,
    disableTooltips: $('cfg-disable-tooltips').checked,
    hudAutoHideDelay: parseInt($('cfg-hud-delay').value, 10),
    alphaBackground: normalizeAlphaBackground($('cfg-alpha-bg') && $('cfg-alpha-bg').value),
    imageOutline: !!($('cfg-image-outline') && $('cfg-image-outline').checked),
    dblClickAction: normalizeDblClickAction(($('cfg-dbl-click') && $('cfg-dbl-click').value) || 'fullscreen'),
    navZoomMode: normalizeNavZoomMode(($('cfg-nav-zoom-mode') && $('cfg-nav-zoom-mode').value) || 'reset'),
    slideshowIntervalMs: parseInt(($('cfg-ss-interval') && $('cfg-ss-interval').value) || '3000', 10),
    slideshowLoop: !!( $('cfg-ss-loop') && $('cfg-ss-loop').checked ),
    slideshowEnterFullscreen: !!( $('cfg-ss-fs') && $('cfg-ss-fs').checked )
  };
}

function getFactoryAppSettings() {
  const current = state.settings && state.settings.app ? state.settings.app : {};
  return {
    ...current,
    sidebarOpen: false,
    statusbarVisible: true,
    closeToTray: false,
    closeImageOnTray: true,
    autoStart: false,
    startMinimized: false,
    accentColor: '#00d4ff',
    language: 'en',
    preferredDisplayId: 'auto',
    contextMenuEnabled: false,
    toggleHotkey: 'Alt+Shift+V',
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
    slideshowIntervalMs: 3000,
    slideshowLoop: true,
    slideshowEnterFullscreen: true,
    allowMultipleInstances: false,
    showFileName: true,
    animateGifs: true,
    dblClickAction: 'fullscreen',
    navZoomMode: 'reset'
  };
}

function resetFactorySettings() {
  if (!state.settings || !state.settings.app) return;
  if (configAutosaveTimer) {
    clearTimeout(configAutosaveTimer);
    configAutosaveTimer = null;
  }

  const previous = state.settings.app;
  const defaults = getFactoryAppSettings();
  if (isElectron && previous.contextMenuEnabled && window.electronAPI.registerContextMenu) {
    window.electronAPI.registerContextMenu(false, 'en').catch((err) => {
      console.error('Error resetting context menu:', err);
    });
  }

  state.settings.app = defaults;
  applySettings();
  if (isElectron) window.electronAPI.saveSettings(state.settings.app);
  setConfigAutosaveState(true);
  openConfig();
  showToast(I18N.en.toast_factory_reset || 'FACTORY SETTINGS RESTORED', 'success', 1200);
}

function saveConfigSettings({ toast = false, silent = false } = {}) {
  if (!state.settings || !state.settings.app) return;
  const newSettings = collectConfigSettings();
  const contextMenuEnabled = !!newSettings.contextMenuEnabled;

  if (isElectron) {
    const lang = newSettings.language || 'en';
    const prevContextMenu = !!(state.settings.app.contextMenuEnabled);
    if (prevContextMenu !== contextMenuEnabled) {
      window.electronAPI.registerContextMenu(contextMenuEnabled, lang).then(res => {
        if (res && !res.success) {
          showToast(lang === 'es' ? 'AVISO: ' + res.error : 'WARNING: ' + res.error, 'warning');
        }
      }).catch(err => console.error('Error saving context menu:', err));
    }
  }

  state.settings.app = Object.assign({}, state.settings.app, newSettings);
  applySettings();
  if (isElectron) window.electronAPI.saveSettings(state.settings.app);
  if (!silent) setConfigAutosaveState(true);

  if (toast) {
    const lang = newSettings.language || 'en';
    showToast(I18N[lang].toast_saved, 'success', 900);
  }
}

let configAutosaveTimer = null;
function scheduleConfigAutosave({ immediate = false, toast = false } = {}) {
  if (configAutosaveTimer) {
    clearTimeout(configAutosaveTimer);
    configAutosaveTimer = null;
  }
  setConfigAutosaveState(false);
  if (immediate) {
    saveConfigSettings({ toast });
    return;
  }
  configAutosaveTimer = setTimeout(() => {
    configAutosaveTimer = null;
    saveConfigSettings({ toast });
  }, 220);
}

document.querySelectorAll('#modal-config .color-opt').forEach(opt => {
  opt.addEventListener('click', () => {
    document.querySelectorAll('#modal-config .color-opt').forEach(o => o.classList.remove('active'));
    opt.classList.add('active');
    setConfigAccentPreview(opt.dataset.color);
    scheduleConfigAutosave({ immediate: true });
  });
});

$('cfg-hud-delay').addEventListener('input', (e) => {
  $('cfg-hud-delay-val').textContent = (e.target.value / 1000).toFixed(1) + 's';
  scheduleConfigAutosave();
});

document.querySelectorAll('#modal-config input, #modal-config select').forEach(ctrl => {
  if (ctrl.id === 'cfg-hud-delay' || ctrl.id === 'cfg-hotkey') return;
  ctrl.addEventListener('change', () => scheduleConfigAutosave({ immediate: true }));
});

const resetFactoryBtn = $('cfg-reset-factory');
if (resetFactoryBtn) {
  resetFactoryBtn.addEventListener('click', () => {
    const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
    const t = I18N[lang] || I18N.en || {};
    showCyberConfirm({
      title: t.cfg_reset_factory_confirm_title || 'Restore Factory Settings',
      message: t.cfg_reset_factory_confirm_message ||
        'Are you sure you want to restore all app preferences to their factory defaults?',
      detail: t.cfg_reset_factory_confirm_detail || 'Your favorites and recent files will be kept.',
      danger: false,
      onConfirm: resetFactorySettings
    });
  });
}

function backupUiText() {
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  return { lang, t: I18N[lang] || I18N.en || {} };
}

async function exportSettingsBackup() {
  if (!isElectron || !window.electronAPI || !window.electronAPI.exportSettingsBackup) return;
  const { lang, t } = backupUiText();
  saveConfigSettings({ toast: false, silent: true });
  try {
    const res = await window.electronAPI.exportSettingsBackup(state.settings.app);
    if (!res || res.canceled) return;
    if (!res.ok) {
      showToast(t.toast_backup_export_error || 'COULD NOT EXPORT SETTINGS', 'error');
      return;
    }
    showToast(t.toast_backup_exported || 'SETTINGS EXPORTED', 'success');
  } catch (err) {
    console.error('Error exporting settings:', err);
    showToast((I18N[lang] && I18N[lang].toast_backup_export_error) || 'COULD NOT EXPORT SETTINGS', 'error');
  }
}

async function applyImportedBackup(payload) {
  if (!payload || !payload.ok) return;
  const previous = state.settings.app || {};
  const next = Object.assign({}, previous, payload.settings || {});
  next.favorites = Array.isArray(payload.favorites) ? payload.favorites.slice() : [];

  if (isElectron && previous.contextMenuEnabled !== !!next.contextMenuEnabled && window.electronAPI.registerContextMenu) {
    const lang = next.language || 'en';
    window.electronAPI.registerContextMenu(!!next.contextMenuEnabled, lang).catch((err) => {
      console.error('Error updating context menu:', err);
    });
  }

  if (state.showingFavs) {
    await toggleFavoritesView();
  }

  state.settings.app = next;
  applySettings();
  if (isElectron) window.electronAPI.saveSettings(state.settings.app);
  setConfigAutosaveState(true);
  openConfig();
  setActiveConfigTab('system');
  updateFavButtonState();
  const { t } = backupUiText();
  showToast(t.toast_backup_imported || 'SETTINGS IMPORTED', 'success');
}

function requestImportSettingsBackup() {
  if (!isElectron || !window.electronAPI || !window.electronAPI.importSettingsBackup) return;
  const { t } = backupUiText();
  showCyberConfirm({
    title: t.cfg_backup_import_confirm_title || 'Import settings',
    message: t.cfg_backup_import_confirm_message ||
      'Replace current preferences and favorites with this backup?',
    detail: t.cfg_backup_import_confirm_detail ||
      'Recent files and folders are kept. This cannot be undone except by importing another backup.',
    danger: false,
    onConfirm: async () => {
      saveConfigSettings({ toast: false, silent: true });
      try {
        const res = await window.electronAPI.importSettingsBackup();
        if (!res || res.canceled) return;
        if (!res.ok) {
          const { t: t2 } = backupUiText();
          const msg = res.error === 'INVALID_JSON' || res.error === 'INVALID_SHAPE' ||
            res.error === 'EMPTY_BACKUP' || res.error === 'UNSUPPORTED_VERSION' || res.error === 'INVALID_FILE'
            ? (t2.toast_backup_import_invalid || 'INVALID SETTINGS FILE')
            : (t2.toast_backup_import_error || 'COULD NOT IMPORT SETTINGS');
          showToast(msg, 'error');
          return;
        }
        await applyImportedBackup(res);
      } catch (err) {
        console.error('Error importing settings:', err);
        const { t: t3 } = backupUiText();
        showToast(t3.toast_backup_import_error || 'COULD NOT IMPORT SETTINGS', 'error');
      }
    }
  });
}

const exportSettingsBtn = $('cfg-export-settings');
if (exportSettingsBtn) {
  exportSettingsBtn.addEventListener('click', () => { exportSettingsBackup(); });
}
const importSettingsBtn = $('cfg-import-settings');
if (importSettingsBtn) {
  importSettingsBtn.addEventListener('click', () => { requestImportSettingsBackup(); });
}

// ── Global toggle hotkey capture (accelerator format, e.g. "Alt+Shift+V") ──
(function () {
  const input = $('cfg-hotkey');
  const clearBtn = $('cfg-hotkey-clear');
  if (!input || !clearBtn) return;
  let capturing = false;

  // Translation keys for the capture placeholder hint.
  function tCapture(lang) {
    const pack = (I18N[lang] || I18N.en) || {};
    return pack.toggle_hotkey_press || 'Press keys…';
  }

  function setCapturing(on) {
    capturing = on;
    input.classList.toggle('capturing', on);
    if (on && !input.value) {
      input.placeholder = tCapture((state.settings && state.settings.app && state.settings.app.language) || 'en');
    }
  }

  // Click → enter capture mode (don't focus the readonly input itself).
  input.addEventListener('click', () => setCapturing(true));
  // Clicking elsewhere exits capture mode.
  document.addEventListener('pointerdown', (e) => {
    if (!capturing) return;
    if (e.target !== input && !input.contains(e.target) && e.target !== clearBtn) setCapturing(false);
  });

  input.addEventListener('keydown', (e) => {
    if (!capturing) return;
    e.preventDefault();
    e.stopPropagation();
    // Esc cancels capture without changing the value.
    if (e.key === 'Escape') { setCapturing(false); return; }
    // Backspace clears the current binding.
    if (e.key === 'Backspace' || e.key === 'Delete') {
      input.value = '';
      setCapturing(false);
      scheduleConfigAutosave({ immediate: true });
      return;
    }
    // Ignore bare modifier presses — wait for a real key + modifiers.
    const modKeys = ['Control', 'Alt', 'Shift', 'Meta', 'OS'];
    if (modKeys.includes(e.key)) return;

    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Meta');
    // Normalize the base key (letters uppercase, digits as-is).
    let key = e.key;
    if (key.length === 1) key = key.toUpperCase();
    const parts = mods.concat(key);
    const acc = parts.join('+');
    input.value = acc;
    setCapturing(false);
    scheduleConfigAutosave({ immediate: true });
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    setCapturing(false);
    scheduleConfigAutosave({ immediate: true });
  });
})();

function applySettings() {
  const s = state.settings.app;
  
  // Accent color
  document.documentElement.style.setProperty('--cyber-accent', s.accentColor);
  // Convert hex to RGB for variables
  const r = parseInt(s.accentColor.slice(1,3), 16);
  const g = parseInt(s.accentColor.slice(3,5), 16);
  const b = parseInt(s.accentColor.slice(5,7), 16);
  document.documentElement.style.setProperty('--cyber-accent-rgb', `${r}, ${g}, ${b}`);
  
  // Visibility
  state.sidebarOpen = !!s.sidebarOpen;
  if (s.preferredDisplayId) $('cfg-monitor').value = s.preferredDisplayId;
  sidebar.style.display = state.sidebarOpen ? '' : 'none';
  document.body.classList.toggle('sidebar-open', state.sidebarOpen);
  const handle = $('sidebar-handle');
  if (handle) handle.style.left = '';
  const arrow = $('sidebar-handle-arrow');
  if (arrow) arrow.textContent = state.sidebarOpen ? '◂' : '▸';
  syncSidebarHandleTooltip();
  // Action bar (default open)
  state.toolbarOpen = s.toolbarOpen !== false;
  document.body.classList.toggle('toolbar-collapsed', !state.toolbarOpen);
  syncToolbarHandle();
  // Statusbar: user preference, but empty-state CSS hides it regardless
  if (s.statusbarVisible) {
    $('statusbar').style.display = '';
  } else {
    $('statusbar').style.display = 'none';
  }
  document.body.classList.toggle('statusbar-visible', !!s.statusbarVisible);

  // Title bar hints visibility (also forced off in empty-state via CSS)
  const showHints = s.showTopHints !== false;
  const hintsEl = $('top-hints');
  if (hintsEl) {
    hintsEl.classList.toggle('hidden', !showHints);
  }
  const hintsCloseBtn = document.getElementById('hints-close');
  if (hintsCloseBtn && !hintsCloseBtn.dataset.bound) {
    hintsCloseBtn.dataset.bound = '1';
    hintsCloseBtn.addEventListener('click', () => {
      state.settings.app.showTopHints = false;
      if (isElectron) window.electronAPI.saveSettings(state.settings.app);
      applySettings();
    });
  }
  if (hintsCloseBtn) {
    const _lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
    hintsCloseBtn.setAttribute('aria-label', (I18N[_lang] && I18N[_lang].hints_close_title) || (I18N.en && I18N.en.hints_close_title) || '');
  }

  // Disable all tooltips (user setting)
  document.body.classList.toggle("no-tooltips", !!s.disableTooltips);

  // Transparency / alpha checkerboard behind transparent pixels
  applyAlphaBackground(s.alphaBackground);
  applyImageOutline(s.imageOutline);

  // Animated GIF playback
  syncGifAnimationSetting();

  // Language
  const lang = s.language || 'en';
  updateLanguage(lang);
  syncEmptyState();
  if (typeof syncGhostCloseTooltip === 'function') syncGhostCloseTooltip();
  if (typeof updateSlideshowUI === 'function' && state.slideshowActive) updateSlideshowUI();
  // Filename/banner visibility depends on the per-element toggles; re-arm
  // HUD so changing "Show Filename"/"Auto-hide" applies without a mousemove.
  if (typeof resetHudTimer === 'function') resetHudTimer();
}

/** Normalize alpha background mode setting. */
function normalizeAlphaBackground(value) {
  if (value === 'checker-light' || value === 'solid' || value === 'checker-dark') return value;
  return 'checker-dark';
}
/** Normalize double-click action setting. */
function normalizeDblClickAction(value) {
  if (value === 'fullscreen' || value === 'toggle-zoom' || value === 'fit' || value === 'original' || value === 'none') return value;
  return 'fullscreen';
}

/** Keep zoom across navigation ('keep') or reset to the selected view mode ('reset'). */
function normalizeNavZoomMode(value) {
  return value === 'keep' ? 'keep' : 'reset';
}

/** Apply body data attribute for CSS alpha grid. */
function applyAlphaBackground(value) {
  const mode = normalizeAlphaBackground(value);
  document.body.setAttribute('data-alpha-bg', mode);
  if (state.settings && state.settings.app) {
    state.settings.app.alphaBackground = mode;
  }
}

/** Apply body data attribute for the optional image outline. */
function applyImageOutline(value) {
  const enabled = value === true;
  document.body.setAttribute('data-image-outline', enabled ? 'on' : 'off');
  if (state.settings && state.settings.app) {
    state.settings.app.imageOutline = enabled;
  }
}

/** Toggle alpha grid on/off from the View menu (dark checker ↔ solid). */
function toggleAlphaBackground() {
  const cur = normalizeAlphaBackground(
    state.settings && state.settings.app && state.settings.app.alphaBackground
  );
  // If light is selected, treat "off" as solid and "on" restore as light
  const next = cur === 'solid'
    ? (state._lastAlphaBg && state._lastAlphaBg !== 'solid' ? state._lastAlphaBg : 'checker-dark')
    : (state._lastAlphaBg = cur, 'solid');
  applyAlphaBackground(next);
  if (isElectron) window.electronAPI.saveSettings(state.settings.app);
}



// ── ELECTRON WINDOW CONTROLS ──


/** Hide CSS :hover tooltips (e.g. stuck after minimize/restore). */
function suppressTooltips() {
  document.body.classList.add('suppress-tooltips');
  // Blur focused chrome so :hover can clear on next interaction
  const ae = document.activeElement;
  if (ae && typeof ae.blur === 'function' && ae !== document.body) {
    try { ae.blur(); } catch (_) { /* ignore */ }
  }
}
function releaseTooltipsOnNextPointer() {
  if (!document.body.classList.contains('suppress-tooltips')) return;
  const unlock = () => {
    document.body.classList.remove('suppress-tooltips');
    window.removeEventListener('pointermove', unlock, true);
    window.removeEventListener('pointerdown', unlock, true);
  };
  window.addEventListener('pointermove', unlock, true);
  window.addEventListener('pointerdown', unlock, true);
}

if (isElectron) {
  $('win-min').addEventListener('click', () => {
    suppressTooltips();
    window.electronAPI.minimize();
  });
  $('win-max').addEventListener('click', () => window.electronAPI.maximize());
  $('win-close').addEventListener('click', () => window.electronAPI.close());
  // X in fullscreen: leave immersive mode only — never stop presentation (window hybrid)
  $('ghost-close').addEventListener('click', () => {
    if (!state.isGhost) return;
    applyImmersiveFullscreen(false);
    if (state.slideshowActive) {
      const lang = (state.settings.app && state.settings.app.language) || 'en';
      const t = I18N[lang] || I18N.en;
      if (typeof showToast === 'function') {
        showToast(t.toast_slideshow_window || 'SLIDESHOW · WINDOW', 'info', 900);
      }
    }
  });

  window.addEventListener('blur', suppressTooltips);
  window.addEventListener('focus', releaseTooltipsOnNextPointer);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suppressTooltips();
    else releaseTooltipsOnNextPointer();
  });

  // Modern maximize (arrows out) and restore (arrows in) icons
  const WIN_MAX_ICO = '<svg class="win-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
  const WIN_RESTORE_ICO = '<svg class="win-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="10" y1="14" x2="3" y2="21"/></svg>';

  window.electronAPI.onWinState(winState => {
    const btn = $('win-max');
    const uiLang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
    const t = I18N[uiLang] || I18N.en;
    // Avoid native title tooltips (they can stick after minimize/restore)
    if (winState === 'maximized') {
      document.body.classList.add('window-maximized');
      btn.classList.add('maximized');
      btn.innerHTML = WIN_RESTORE_ICO;
      setCyberTooltip(btn, t.menu_restore || 'Restore');
    } else {
      document.body.classList.remove('window-maximized');
      btn.classList.remove('maximized');
      btn.innerHTML = WIN_MAX_ICO;
      setCyberTooltip(btn, t.maximize || 'Maximize');
    }
    suppressTooltips();
    releaseTooltipsOnNextPointer();
  });

  // Keep immersive UI in sync if OS fullscreen ends/starts externally
  if (typeof window.electronAPI.onFullscreenChanged === 'function') {
    window.electronAPI.onFullscreenChanged((isFs) => {
      // skipOs: main already changed exclusive fullscreen state
      applyImmersiveFullscreen(isFs, { skipOs: true });
    });
  }

  if (typeof window.electronAPI.onWindowBlur === 'function') {
    window.electronAPI.onWindowBlur(hideInterfaceMenus);
  }

  window.electronAPI.onOpenFile(async (filePath) => {
    hideInterfaceMenus();
    if (filePath) await openImagePath(filePath);
  });

  window.electronAPI.onOpenSettings(() => {
    openConfig();
  });

  // Load settings from Electron
  window.electronAPI.getSettings().then(s => {
    if (s && s.app) {
      state.settings.app = { ...state.settings.app, ...s.app };
      if (state.settings.app.checkUpdatesOnStartup === undefined) {
        state.settings.app.checkUpdatesOnStartup = state.settings.app.manualUpdateOnly === undefined
          ? true
          : !state.settings.app.manualUpdateOnly;
      }
      if (!Array.isArray(state.settings.app.recentFiles)) {
        state.settings.app.recentFiles = [];
      }
      if (!Array.isArray(state.settings.app.recentFolders)) {
        state.settings.app.recentFolders = [];
      }
      applySettings();
      // Startup update check is owned by main (electron-updater); badge + 1× toast
      if (window.electronAPI.onUpdateStatus) {
        window.electronAPI.onUpdateStatus((status) => {
          if (window.__cvApplyUpdateStatus) {
            window.__cvApplyUpdateStatus(status, { fromStartup: true });
          }
        });
      }
    }
  }).catch(err => console.error('Error cargando settings:', err));
} else {
  // Modo browser
  applySettings();
}

// ── HUD SYNC ──
function syncRotationPendingState(pending) {
  document.body.classList.toggle('rotation-pending', pending);
  const allowed = new Set(['btn-rot-l', 'btn-rot-r', 'btn-commit', 'btn-discard']);
  document.querySelectorAll('#kbd-hint button, #nav-container button, #sidebar-controls button, #btn-menu').forEach((el) => {
    if (allowed.has(el.id)) return;
    if (pending) {
      if (!el.dataset.rotationWasDisabled) el.dataset.rotationWasDisabled = el.disabled ? '1' : '0';
      el.disabled = true;
      el.classList.add('is-disabled');
      el.setAttribute('aria-disabled', 'true');
    } else if (el.dataset.rotationWasDisabled) {
      el.disabled = el.dataset.rotationWasDisabled === '1';
      delete el.dataset.rotationWasDisabled;
      el.classList.remove('is-disabled');
      if (!el.disabled) el.removeAttribute('aria-disabled');
    }
  });
  const menu = $('main-menu');
  if (menu) menu.classList.toggle('rotation-pending', pending);
}

function updateHUDStates() {
  const rotL = $('btn-rot-l');
  const rotR = $('btn-rot-r');
  const crop = $('btn-crop');
  const fsBtn = $('btn-fs-hud');
  const commit = $('btn-commit');

  const pendingRotation = state.currentRotation !== 0 && state.hasChanges;
  syncRotationPendingState(pendingRotation);
  if (pendingRotation) {
    if (rotL) rotL.classList.add('active');
    if (rotR) rotR.classList.add('active');
    if (commit) commit.classList.add('active');
  } else {
    if (rotL) rotL.classList.remove('active');
    if (rotR) rotR.classList.remove('active');
    if (commit) commit.classList.remove('active');
  }

  // RECORTE
  if (state.isCropping) {
    if (crop) crop.classList.add('active');
  } else {
    if (crop) crop.classList.remove('active');
  }

  // FULLSCREEN
  if (state.isGhost) {
    if (fsBtn) fsBtn.classList.add('active');
  } else {
    if (fsBtn) fsBtn.classList.remove('active');
  }

  // VIEW MODE (1:1 / Fit-Window): mirror the selected view like the fullscreen button
  syncViewModeButtons();

  // Crop mode: despeja el chrome (barra + statusbar) mientras se recorta.
  // Se sincroniza aqui porque updateHUDStates() se llama en cada transicion
  // de isCropping (iniciar/cancelar/confirmar/entrar a pantalla completa).
  document.body.classList.toggle('crop-mode', !!state.isCropping);

  updateSaveButton();
}

$('btn-center').addEventListener('click', () => {
  const scrollArea = $('sidebar-scroll');
  const activeThumb = sidebar.querySelector('.thumb-item.active');
  if (activeThumb && scrollArea) {
    activeThumb.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
});
$('btn-go-start').addEventListener('click', (e) => {
  e.currentTarget.blur();
  goToBoundary('start');
});
$('btn-go-end').addEventListener('click', (e) => {
  e.currentTarget.blur();
  goToBoundary('end');
});

// Modificar confirmCrop y cancelCrop para limpiar
// (Ya gestionado por listeners directos arriba)

// ── ABOUT MODAL + UPDATES ──
(function() {
  const overlay = document.createElement('div');
  overlay.id = 'about-overlay';
  overlay.className = 'modal-overlay';
  document.body.appendChild(overlay);

  let updateStatus = { state: 'idle' };
  let unsubUpdateStatus = null;

  function tAbout() {
    const lang = (state.settings.app && state.settings.app.language) || 'en';
    return I18N[lang] || I18N.en;
  }

  function ensureUpdateNotify() {
    const app = ensureAppSettings();
    if (!app.updateNotify || typeof app.updateNotify !== 'object') {
      app.updateNotify = {
        lastNotifiedAvailable: null,
        lastNotifiedDownloaded: null
      };
    }
    if (app.updateNotify.lastNotifiedAvailable === undefined) {
      app.updateNotify.lastNotifiedAvailable = null;
    }
    if (app.updateNotify.lastNotifiedDownloaded === undefined) {
      app.updateNotify.lastNotifiedDownloaded = null;
    }
    return app.updateNotify;
  }

  /** Soft badge on the menu button — always visible while an update is pending. */
  function syncUpdateMenuBadge() {
    const wrap = document.querySelector('.menu-wrap');
    const btn = $('btn-menu');
    if (!wrap || !btn) return;

    let badge = $('update-menu-badge');
    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.id = 'update-menu-badge';
      badge.className = 'update-menu-badge';
      badge.setAttribute('aria-label', 'Update available');
      wrap.appendChild(badge);
      badge.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (typeof window.openAbout === 'function') window.openAbout();
        else if ($('btn-about')) $('btn-about').click();
      });
    }

    const s = updateStatus;
    const pending = s && (s.state === 'available' || s.state === 'downloaded');
    const t = tAbout();
    const ver = (s && s.version) ? String(s.version) : '';

    badge.classList.toggle('visible', !!pending);
    badge.classList.toggle('ready', !!(s && s.state === 'downloaded'));
    btn.classList.toggle('has-update-badge', !!pending);

    if (pending) {
      const tip = s.state === 'downloaded'
        ? (t.update_badge_ready || 'Update ready: v{version} — click to install')
            .replace('{version}', ver)
        : (t.update_badge_available || 'Update available: v{version} — click for details')
            .replace('{version}', ver);
      badge.setAttribute('aria-label', tip);
      setCyberTooltip(badge, tip);
      badge.classList.add('cyber-tooltip', 'tooltip-bottom', 'tooltip-align-right');
    } else {
      badge.removeAttribute('data-tooltip');
      badge.classList.remove('cyber-tooltip');
    }
  }

  /**
   * Toast at most once per version for available / downloaded.
   * Startup auto-check only toasts when checkUpdatesOnStartup is on;
   * download-ready always toasts once (user already requested the download).
   */
  function maybeToastUpdateStatus(status, opts) {
    if (!status || !status.state) return;
    const fromStartup = !!(opts && opts.fromStartup);
    const n = ensureUpdateNotify();
    const t = tAbout();
    const ver = status.version ? String(status.version) : '';
    if (!ver) return;

    if (status.state === 'available') {
      if (fromStartup && state.settings.app.checkUpdatesOnStartup === false) return;
      if (n.lastNotifiedAvailable === ver) return;
      const msg = (t.about_notify_startup || 'Update available: v{version}')
        .replace('{version}', ver);
      showToast(msg, 'info');
      n.lastNotifiedAvailable = ver;
      persistAppSettings();
      return;
    }

    if (status.state === 'downloaded') {
      if (n.lastNotifiedDownloaded === ver) return;
      const msg = (t.about_notify_ready || 'Update ready: v{version} — open About to install')
        .replace('{version}', ver);
      showToast(msg, 'success');
      n.lastNotifiedDownloaded = ver;
      persistAppSettings();
    }
  }

  function applyUpdateStatus(status, opts) {
    updateStatus = status || { state: 'idle' };
    window.__cvUpdateStatus = updateStatus;
    syncUpdateActions(overlay);
    syncUpdateMenuBadge();
    maybeToastUpdateStatus(updateStatus, opts);
  }
  window.__cvApplyUpdateStatus = applyUpdateStatus;
  window.__cvSyncUpdateBadge = syncUpdateMenuBadge;

  function renderUpdateStatusText(el) {
    if (!el) return;
    const t = tAbout();
    const s = updateStatus;
    el.style.color = 'var(--cyber-muted)';
    // Banner already covers available/downloaded
    if (s.state === 'available' || s.state === 'downloaded') {
      el.textContent = '';
      return;
    }
    if (s.state === 'checking') {
      el.textContent = t.about_checking;
    } else if (s.state === 'not-available') {
      el.textContent = t.about_up_to_date;
      el.style.color = 'var(--cyber-accent3)';
    } else if (s.state === 'downloading') {
      el.textContent = (t.about_downloading || 'Downloading… {percent}%')
        .replace('{percent}', String(s.percent || 0));
      el.style.color = 'var(--cyber-accent)';
    } else if (s.state === 'error') {
      el.textContent = `${t.about_update_err}${s.message ? ' (' + s.message + ')' : ''}`;
      el.style.color = 'var(--cyber-accent2)';
    } else {
      el.textContent = '';
    }
  }

  function syncUpdateBanner(root) {
    if (!root) return;
    const banner = root.querySelector('#about-update-banner');
    if (!banner) return;
    const t = tAbout();
    const s = updateStatus;
    banner.classList.remove('visible', 'ready');
    if (s.state === 'available') {
      banner.textContent = `${t.about_update_avail} (v${s.version || ''})`;
      banner.classList.add('visible');
    } else if (s.state === 'downloaded') {
      banner.textContent = `${t.about_downloaded}${s.version ? ' (v' + s.version + ')' : ''}`;
      banner.classList.add('visible', 'ready');
    } else {
      banner.textContent = '';
    }
  }

  function syncUpdateActions(root) {
    if (!root) return;
    const checkBtn = root.querySelector('#about-btn-update');
    const downloadBtn = root.querySelector('#about-btn-download');
    const installBtn = root.querySelector('#about-btn-install');
    const progress = root.querySelector('#about-update-progress');
    const bar = root.querySelector('#about-update-bar');
    const statusEl = root.querySelector('#about-update-status');
    const s = updateStatus.state;

    if (checkBtn) {
      checkBtn.disabled = s === 'checking' || s === 'downloading';
      checkBtn.style.display = (s === 'available' || s === 'downloaded' || s === 'downloading') ? 'none' : '';
    }
    if (downloadBtn) {
      downloadBtn.style.display = s === 'available' ? '' : 'none';
      downloadBtn.disabled = false;
    }
    if (installBtn) {
      installBtn.style.display = s === 'downloaded' ? '' : 'none';
    }
    if (progress) {
      progress.style.display = s === 'downloading' ? '' : 'none';
    }
    if (bar) {
      bar.style.width = Math.max(0, Math.min(100, s === 'downloading' ? (updateStatus.percent || 0) : 0)) + '%';
    }
    renderUpdateStatusText(statusEl);
    syncUpdateBanner(root);
  }

  window.checkUpdatesGlobal = async function() {
    const t = tAbout();
    if (!isElectron || !window.electronAPI.checkForUpdates) return;

    updateStatus = { state: 'checking' };
    syncUpdateActions(overlay);

    const res = await window.electronAPI.checkForUpdates();
    if (!res || !res.ok) {
      if (res && (res.portable || res.error === 'PORTABLE_NO_AUTO_UPDATE' || res.error === 'DEV_NO_AUTO_UPDATE')) {
        updateStatus = {
          state: 'error',
          message: res.portable ? t.about_portable_hint : t.about_update_err
        };
        syncUpdateActions(overlay);
        return res;
      }
      updateStatus = { state: 'error', message: (res && res.error) || 'Update check failed' };
      syncUpdateActions(overlay);
      return res;
    }

    // Events usually settle UI first; safety net if still checking
    if (updateStatus.state === 'checking') {
      updateStatus = {
        state: 'not-available',
        version: res.version || ''
      };
      syncUpdateActions(overlay);
    }
    return res;
  };

  async function openAbout() {
    const lang = state.settings.app.language || 'en';
    const t = I18N[lang] || I18N.en;
    const version = (isElectron && window.electronAPI.getVersion)
      ? await window.electronAPI.getVersion()
      : '';
    const updateInfo = (isElectron && window.electronAPI.getUpdateInfo)
      ? await window.electronAPI.getUpdateInfo()
      : { canUpdate: false, portable: false };

    const verLabel = version ? `v${version}` : 'v—';
    overlay.innerHTML = `
      <div class="modal-box about-modal" role="dialog" aria-modal="true" aria-labelledby="about-dialog-title">
        <div class="modal-header">
          <div class="modal-title" id="about-dialog-title"><span class="modal-header-icon" data-modal-icon="info" aria-hidden="true"></span><span>${t.about_title}</span></div>
          <button class="win-btn modal-close-btn" id="about-close-btn" aria-label="${t.close || 'Close'}">&#10005;</button>
        </div>
        <div class="modal-body">
          <div class="about-hero">
            <div class="about-logo-wrap">
              <img src="assets/icon.ico" class="about-logo" alt="" width="76" height="76" draggable="false">
            </div>
            <div class="about-brand">
              <span class="about-brand-cyber" style="color:#E6E6E6">Cyber</span><span class="about-brand-viewer">Viewer</span>
            </div>
            <span class="about-version">${verLabel}</span>
            <p class="about-desc">
              ${t.about_copyright || t.about_desc}
              <span class="about-tagline">${t.about_tagline || ''}</span>
            </p>
            <div class="about-formats">
              ${t.about_formats_list || t.about_formats}
              <span class="about-formats-tech">${t.about_formats_tech || ''}</span>
            </div>
          </div>

          <div class="about-update-section">
            <div class="about-update-heading">${t.about_updates_heading || t.menu_updates || 'Updates'}</div>
            <div class="about-startup-row">
              <span class="about-startup-label">${t.about_check_on_startup}</span>
              <label class="switch">
                <input type="checkbox" id="about-startup-update-toggle" ${state.settings.app.checkUpdatesOnStartup !== false ? 'checked' : ''}>
                <span class="slider"></span>
              </label>
            </div>
            <div id="about-update-banner" class="about-update-banner" aria-live="polite"></div>
            <div id="about-update-progress" class="about-update-progress" style="display:none">
              <div class="about-update-track"><div id="about-update-bar" class="about-update-bar"></div></div>
            </div>
            <div class="about-update-actions">
              <button type="button" id="about-btn-update" class="top-btn about-action-btn about-action-accent">
                ${t.about_check_updates}
              </button>
              <button type="button" id="about-btn-download" class="top-btn active about-action-btn" style="display:none">
                ${t.about_download_btn}
              </button>
              <button type="button" id="about-btn-install" class="top-btn active about-action-btn" style="display:none">
                ${t.about_install_btn}
              </button>
            </div>
            <div id="about-update-status" class="about-update-status" aria-live="polite"></div>
            ${!updateInfo.canUpdate && updateInfo.portable ? `<div class="about-update-hint">${t.about_portable_hint}</div>` : ''}
          </div>
        </div>
        <div class="modal-footer about-modal-footer">
          <a
            class="about-footer-brand cyber-tooltip"
            href="https://cybergems.org"
            target="_blank"
            rel="noopener noreferrer"
            data-tooltip="${t.about_website_tooltip}"
            aria-label="${t.about_website_tooltip}"
          >© CyberGems • 2026</a>
          <div class="about-footer-links">
            <a
              class="about-footer-icon cyber-tooltip"
              href="https://github.com/CyberGems/CyberViewer"
              target="_blank"
              rel="noopener noreferrer"
              data-tooltip="${t.about_github_tooltip}"
              aria-label="${t.about_github_tooltip}"
            >${iconHtml('github')}</a>
            <a
              class="about-footer-icon cyber-tooltip"
              href="https://github.com/CyberGems/CyberViewer/issues"
              target="_blank"
              rel="noopener noreferrer"
              data-tooltip="${t.about_issues_tooltip}"
              aria-label="${t.about_issues_tooltip}"
            >${iconHtml('circle-dot')}</a>
            <a
              class="about-footer-icon cyber-tooltip tooltip-align-right"
              href="https://github.com/CyberGems/CyberViewer/releases"
              target="_blank"
              rel="noopener noreferrer"
              data-tooltip="${t.about_releases_tooltip}"
              aria-label="${t.about_releases_tooltip}"
            >${iconHtml('tag')}</a>
          </div>
        </div>
      </div>
    `;
    decorateModalHeaderIcons();
    overlay.querySelector('#about-close-btn').addEventListener('click', closeAbout);
    
    const toggle = overlay.querySelector('#about-startup-update-toggle');
    toggle.addEventListener('change', () => {
      state.settings.app.checkUpdatesOnStartup = toggle.checked;
      if (isElectron) {
        window.electronAPI.saveSettings(state.settings.app);
      }
    });

    overlay.querySelector('#about-btn-update').addEventListener('click', () => {
      window.checkUpdatesGlobal(true);
    });
    overlay.querySelector('#about-btn-download').addEventListener('click', async () => {
      updateStatus = { state: 'downloading', percent: 0 };
      syncUpdateActions(overlay);
      const res = await window.electronAPI.downloadUpdate();
      if (!res || !res.ok) {
        updateStatus = { state: 'error', message: (res && res.error) || 'Download failed' };
        syncUpdateActions(overlay);
      }
    });
    overlay.querySelector('#about-btn-install').addEventListener('click', () => {
      window.electronAPI.installUpdate();
    });

    if (unsubUpdateStatus) unsubUpdateStatus();
    if (window.electronAPI.onUpdateStatus) {
      unsubUpdateStatus = window.electronAPI.onUpdateStatus((status) => {
        applyUpdateStatus(status);
      });
    }

    syncUpdateActions(overlay);
    overlay.classList.add('active');
  }

  function closeAbout() {
    overlay.classList.remove('active');
    if (unsubUpdateStatus) {
      unsubUpdateStatus();
      unsubUpdateStatus = null;
    }
  }

  overlay.addEventListener('click', e => { if (e.target === overlay) closeAbout(); });
  window.openAbout = openAbout;
  $('btn-about').addEventListener('click', openAbout);
  $('logo-trigger').addEventListener('click', openAbout);
})();

$('btn-config').addEventListener('click', openConfig);

// ── MAIN MENU (☰) ──
(function initMainMenu() {
  const btn = $('btn-menu');
  const panel = $('main-menu');
  if (!btn || !panel) return;
  decorateMenuIcons(panel);
  syncWindowCloseMenuItem();

  function closeMenu() {
    panel.classList.remove('open');
    btn.classList.remove('open');
    const a = document.activeElement;
    if (a && panel.contains(a)) a.blur();
  }
  function fillRecentList(listEl, items, opts) {
    if (!listEl) return;
    listEl.innerHTML = '';

    if (!items.length) {
      const empty = document.createElement('button');
      empty.type = 'button';
      empty.className = 'menu-item menu-recent-empty';
      empty.innerHTML = iconHtml(opts.isFolder ? 'folder' : 'image') + `<span class="menu-label">${opts.emptyLabel}</span>`;
      listEl.appendChild(empty);
      return;
    }

    items.forEach((entryPath, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'menu-item menu-recent-item';
      btn.dataset.action = opts.action;
      btn.dataset.path = entryPath;
      const name = fileNameFromPath(entryPath);
      btn.title = entryPath;
      btn.innerHTML = iconHtml(opts.isFolder ? 'folder' : 'image') + `<span class="menu-label">${escapeHtmlMenu(name)}</span><span class="menu-shortcut">${idx + 1}</span>`;
      listEl.appendChild(btn);
    });
    const div = document.createElement('div');
    div.className = 'menu-divider';
    listEl.appendChild(div);
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'menu-item danger';
    clearBtn.dataset.action = opts.clearAction;
    clearBtn.innerHTML = iconHtml('trash', true) + `<span class="menu-label">${opts.clearLabel}</span>`;
    listEl.appendChild(clearBtn);
  }

  function rebuildRecentMenu() {
    const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
    const t = I18N[lang] || I18N.en;
    fillRecentList(panel.querySelector('#menu-recent-list'), getRecentFiles(), {
      action: 'open-recent',
      clearAction: 'clear-recent',
      isFolder: false,
      emptyLabel: t.menu_recent_empty || 'No recent images',
      clearLabel: t.menu_clear_recent || 'Clear recent'
    });
    fillRecentList(panel.querySelector('#menu-recent-folders-list'), getRecentFolders(), {
      action: 'open-recent-folder',
      clearAction: 'clear-recent-folders',
      isFolder: true,
      emptyLabel: t.menu_recent_folders_empty || 'No recent folders',
      clearLabel: t.menu_clear_recent_folders || 'Clear recent folders'
    });
  }

  function escapeHtmlMenu(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function refreshMenuState() {
    const hasImg = state.current !== -1 && state.images && state.images.length > 0;
    panel.querySelectorAll('[data-needs-image]').forEach(el => el.classList.toggle('disabled', !hasImg));
    const sb = panel.querySelector('[data-action="sidebar"]');
    if (sb) sb.classList.toggle('checked', !!state.sidebarOpen);
    const tb = panel.querySelector('[data-action="toolbar"]');
    if (tb) tb.classList.toggle('checked', state.toolbarOpen !== false);
    const th = panel.querySelector('[data-action="toggle-hints"]');
    if (th) th.classList.toggle('checked', !!(state.settings && state.settings.app && state.settings.app.showTopHints !== false));
    const ab = panel.querySelector('[data-action="toggle-alpha-bg"]');
    if (ab) {
      const mode = state.settings && state.settings.app
        ? normalizeAlphaBackground(state.settings.app.alphaBackground)
        : 'checker-dark';
      ab.classList.toggle('checked', mode !== 'solid');
    }
    const ssLoop = panel.querySelector('[data-action="slideshow-loop"]');
    if (ssLoop) ssLoop.classList.toggle('checked', isSlideshowLoop());
    const ssIntVal = panel.querySelector('#menu-ss-interval-val');
    if (ssIntVal) {
      const ms = getSlideshowIntervalMs();
      ssIntVal.textContent = (ms / 1000) + 's';
    }
    const ssPlay = panel.querySelector('[data-action="slideshow"]');
    if (ssPlay) ssPlay.classList.toggle('checked', !!(state.slideshowActive && state.slideshowPlaying));
    rebuildRecentMenu();
  }
  function openMenu() {
    if (typeof hideCustomContextMenu === 'function') hideCustomContextMenu();
    refreshMenuState();
    // Reset any submenu kept open by the close-delay so the menu reopens fresh.
    panel.querySelectorAll('.menu-cat.sub-open').forEach((el) => {
      if (el._subCloseTimer) { clearTimeout(el._subCloseTimer); el._subCloseTimer = 0; }
      el.classList.remove('sub-open');
    });
    panel.classList.add('open');
    btn.classList.add('open');
  }

  btn.addEventListener('click', e => {
    e.stopPropagation();
    panel.classList.contains('open') ? closeMenu() : openMenu();
  });
  document.addEventListener('pointerdown', e => {
    if (panel.classList.contains('open') && !e.target.closest('.menu-wrap')) closeMenu();
  });

  function closeOpenModals() {
    closeModal('modal-config');
    closeModal('modal-resize');
    closeModal('modal-adjust');
    closeModal('modal-properties');
    closeModal('modal-cyber-confirm');
    const aboutOverlay = $('about-overlay');
    if (aboutOverlay) aboutOverlay.classList.remove('active');
  }

  function runAction(action, itemEl) {
    // During crop, every action except toggling crop itself is disabled so the
    // recorte stays the sole focus (mirrors the hidden toolbar + blocked keys).
    if (state.isCropping && action !== 'crop') return;
    // Leave modal context so menu actions (and subsequent UI) aren't blocked
    if (action !== 'resize' && action !== 'adjust' && action !== 'preferences' && action !== 'about' && action !== 'check-updates') {
      closeOpenModals();
    }
    switch (action) {
      case 'open-image':     openImageDialog(); break;
      case 'open-folder':    openFolderDialog(); break;
      case 'open-recent': {
        const path = itemEl && itemEl.dataset ? itemEl.dataset.path : null;
        if (path) openRecentPath(path);
        break;
      }
      case 'open-recent-folder': {
        const path = itemEl && itemEl.dataset ? itemEl.dataset.path : null;
        if (path) openRecentFolder(path);
        break;
      }
      case 'clear-recent':   clearRecentFiles(); break;
      case 'clear-recent-folders': clearRecentFolders(); break;
      case 'paste-image':    pasteFromClipboard(); break;
      case 'close-image':    closeImage(); break;
      case 'show-folder':    $('btn-show-folder').click(); break;
      case 'save':           saveCurrent(); break;
      case 'save-as':        showSaveAsDialog(); break;
      case 'export-pdf':    openPrintExportModal(); break;
      case 'print':         openPrintExportModal(); break;
      case 'copy':           copyToClipboard(); break;
      case 'properties':
        openPropertiesForCurrent();
        break;
      case 'trash':          trashCurrentImage(); break;
      case 'rotate-left':    rotate(-90); break;
      case 'rotate-right':   rotate(90); break;
      case 'crop':           $('btn-crop').click(); break;
      case 'resize':         $('btn-resize').click(); break;
      case 'adjust':         { const b = $('btn-adjust'); if (b) b.click(); break; }
      case 'flip-h':         flipImage('h'); break;
      case 'flip-v':         flipImage('v'); break;
      case 'fit':            $('btn-fit-hud').click(); break;
      case 'original':       $('btn-orig-hud').click(); break;
      case 'fullscreen':     toggleFullscreen(); break;
      case 'sidebar':        $('sidebar-handle').click(); break;
      case 'toolbar':
        setToolbarOpen(!(state.toolbarOpen !== false));
        break;
      case 'toggle-hints':
        state.settings.app.showTopHints = (state.settings.app.showTopHints !== false) ? false : true;
        if (isElectron) window.electronAPI.saveSettings(state.settings.app);
        applySettings();
        break;
      case 'toggle-alpha-bg':
        toggleAlphaBackground();
        break;
      case 'start-slideshow':
        startSlideshow();
        break;
      case 'slideshow':
        toggleSlideshowPlay();
        break;
      case 'slideshow-loop':
        toggleSlideshowLoop();
        break;
      case 'slideshow-interval':
        cycleSlideshowInterval();
        break;
      case 'next':           next(); break;
      case 'prev':           prev(); break;
      case 'favorite':       $('btn-fav').click(); break;
      case 'favorites-view':
        (async () => {
          const wasShowing = state.showingFavs;
          await toggleFavoritesView();
          // entering favorites view shows the full list in the sidebar — expand it if collapsed
          if (!wasShowing && state.showingFavs && !state.sidebarOpen) $('sidebar-handle').click();
        })();
        break;
      case 'preferences':    $('btn-config').click(); break;
      case 'about':          $('btn-about').click(); break;
      case 'check-updates':
        $('btn-about').click();
        setTimeout(() => {
          if (typeof window.checkUpdatesGlobal === 'function') window.checkUpdatesGlobal(true);
        }, 80);
        break;
      case 'quit':
        if (isElectron && window.electronAPI && window.electronAPI.close) window.electronAPI.close();
        break;
    }
  }

  // Event delegation so dynamically built Recent items work
  panel.addEventListener('click', e => {
    const item = e.target.closest('.menu-item');
    if (!item || !panel.contains(item)) return;
    e.stopPropagation();
    if (item.classList.contains('disabled') || item.classList.contains('menu-recent-empty')) return;
    const action = item.dataset.action;
    if (!action) return;
    runAction(action, item);
    if (
      action === 'sidebar' || action === 'toggle-hints' ||
      action === 'toggle-alpha-bg' || action === 'clear-recent' || action === 'clear-recent-folders' ||
      action === 'slideshow-loop' || action === 'slideshow-interval' || action === 'slideshow'
    ) {
      item.blur();
      refreshMenuState();
    } else {
      closeMenu();
    }
  });
})();

// ── SUBMENU CLOSE DELAY ──
// Submenus fade/slide in on hover (CSS), but stay open for a brief moment
// after the pointer leaves so the cursor can travel diagonally from a
// category into its submenu without the flyout snapping shut mid-move.
// Applies to both the burger menu and the right-click context menu since
// they share the .menu-cat[data-sub] / .menu-sub classes.
(function initSubmenuCloseDelay() {
  const SUB_CLOSE_DELAY = 280; // ms — muy leve, solo para salvar el recorrido del cursor
  const TKEY = '_subCloseTimer';

  function clearTimer(el) { if (el[TKEY]) { clearTimeout(el[TKEY]); el[TKEY] = 0; } }
  function openSub(cat) {
    clearTimer(cat);
    // Switching to a sibling category replaces the current flyout immediately
    // (no overlap). Re-adding .sub-open retriggers the CSS open animation.
    const sib = cat.parentElement ? cat.parentElement.querySelectorAll(':scope > .menu-cat.sub-open') : null;
    if (sib) sib.forEach((el) => { if (el !== cat) { clearTimer(el); el.classList.remove('sub-open'); } });
    if (cat.classList.contains('sub-open')) return;
    cat.classList.add('sub-open');
  }
  function scheduleClose(cat) {
    clearTimer(cat);
    cat[TKEY] = setTimeout(() => { cat[TKEY] = 0; cat.classList.remove('sub-open'); }, SUB_CLOSE_DELAY);
  }

  document.addEventListener('mouseover', (e) => {
    const cat = e.target && e.target.closest ? e.target.closest('.menu-cat[data-sub]') : null;
    if (cat) openSub(cat);
  });
  document.addEventListener('focusin', (e) => {
    const cat = e.target && e.target.closest ? e.target.closest('.menu-cat[data-sub]') : null;
    if (cat) openSub(cat);
  });
  document.addEventListener('mouseout', (e) => {
    const cat = e.target && e.target.closest ? e.target.closest('.menu-cat[data-sub]') : null;
    if (!cat) return;
    const rt = e.relatedTarget;
    // Leaving a category fades its submenu after a brief delay; also fade any open
    // ancestor submenus if the pointer left their region too (nested flyouts).
    if (!rt || !cat.contains(rt)) scheduleClose(cat);
    let parent = cat.parentElement ? cat.parentElement.closest('.menu-cat[data-sub]') : null;
    while (parent) {
      if ((!rt || !parent.contains(rt)) && parent.classList.contains('sub-open')) scheduleClose(parent);
      parent = parent.parentElement ? parent.parentElement.closest('.menu-cat[data-sub]') : null;
    }
  });
})();
// ── HUD AUTO-HIDE (Sincronizado) ──
// Docked toolbar (#kbd-hint) only auto-hides in fullscreen (ghost). In window mode it is chrome.
let hudTimer = null;
let cursorOnCanvas = false;
const elementsToHide = [
  { el: $('topbar'), hideClass: 'hud-hidden-top', ghostOnly: false },
  { el: $('statusbar'), hideClass: 'hud-hidden-bottom', ghostOnly: false },
  { el: $('kbd-hint'), hideClass: 'hud-hidden', ghostOnly: true },
  { el: $('ghost-close'), hideClass: 'hud-hidden-fade', ghostOnly: true },
  { el: $('zoom-hud'), hideClass: 'hud-hidden-fade', ghostOnly: true },
  { el: $('slideshow-hud'), hideClass: 'hud-hidden-fade', ghostOnly: false },
  { el: $('viewer-filename'), hideClass: 'hud-hidden-fade', ghostOnly: false },
  { el: $('nav-container'), hideClass: 'hud-hidden-fade', ghostOnly: false }
];

// Fullscreen (ghost mode): hide the floating action bar (#kbd-hint) the instant
// the user navigates with the on-screen nav buttons or hotkeys, and keep it
// hidden while the cursor stays over the nav-button surface so rapid flipping
// stays unobstructed. It re-shows once the cursor leaves the nav buttons -
// handled by the nav mouseleave -> resetHudTimer reveal pass below.
function navButtonsHovered() {
  const nav = $('nav-container');
  return !!(nav && nav.matches(':hover'));
}

function hideActionBarOnNavigate() {
  if (!state.isGhost) return;
  if (state.toolbarOpen === false) return; // user-collapsed bar stays collapsed
  const kbd = $('kbd-hint');
  if (kbd) kbd.classList.add('hud-hidden');
}

function resetHudTimer() {
  clearTimeout(hudTimer);

  // During crop, keep chrome out of the way — never re-reveal filename/HUD
  if (state.isCropping) {
    const filename = $('viewer-filename');
    if (filename) filename.classList.add('hud-hidden-fade');
    const kbd = $('kbd-hint');
    if (kbd && state.isGhost) kbd.classList.add('hud-hidden');
    const nav = $('nav-container');
    if (nav) nav.classList.add('hud-hidden-fade');
    const zh = $('zoom-hud');
    if (zh && state.isGhost) zh.classList.add('hud-hidden-fade');
    const ss = $('slideshow-hud');
    if (ss && state.slideshowActive) ss.classList.add('hud-hidden-fade');
    return;
  }

  const bannerEnabled = state.settings?.app?.bannerAutoHide !== false;
  const navEnabled = state.settings?.app?.navAutoHide !== false;
  // During slideshow always auto-hide floating chrome (incl. presentation bar)
  const forceSlideshowHide = !!state.slideshowActive;

  elementsToHide.forEach(item => {
    if (!item.el) return;
    // Slideshow HUD only while presentation is active
    if (item.el.id === 'slideshow-hud' && !state.slideshowActive) {
      item.el.classList.add('hud-hidden-fade');
      return;
    }
    // Filename banner & nav buttons surface only over the canvas. Off the
    // canvas (over chrome) they always fade out so the viewer chrome stays
    // clear; the per-element toggles (nav/banner) only gate the inactivity
    // idle-hide while the cursor IS over the canvas. The "Show Filename"
    // master toggle hides the banner entirely (even over the canvas).
    if (item.el.id === 'viewer-filename') {
      const showFileName = state.settings?.app?.showFileName !== false;
      if (!showFileName || !(cursorOnCanvas || item.el.matches(':hover') || navButtonsHovered())) {
        item.el.classList.add(item.hideClass);
      } else {
        item.el.classList.remove(item.hideClass);
      }
      return;
    }
    if (item.el.id === 'nav-container') {
      if (cursorOnCanvas || item.el.matches(':hover')) {
        item.el.classList.remove(item.hideClass);
      } else {
        item.el.classList.add(item.hideClass);
      }
      return;
    }
    // Fullscreen: keep the floating action bar hidden while the cursor is over
    // the on-screen nav buttons (active image flipping via buttons/hotkeys).
    // navButtonsHovered() is live, so once the cursor leaves the nav surface
    // this guard passes and the bar is (re)revealed by the line below.
    if (item.el.id === 'kbd-hint' && state.isGhost && state.toolbarOpen !== false && navButtonsHovered()) {
      return;
    }
    item.el.classList.remove(item.hideClass);
    // Ensure docked toolbar never stays hidden after leaving fullscreen
    // (unless the user collapsed the action bar permanently)
    if (item.el.id === 'kbd-hint' && !state.isGhost && state.toolbarOpen !== false) {
      item.el.classList.remove('hud-hidden', 'hud-hidden-fade');
    }
    // Zoom badge needs .visible from a zoom gesture; keep it if user just zoomed in FS
    if (item.el.id === 'zoom-hud' && !item.el.classList.contains('visible')) {
      item.el.classList.add('hud-hidden-fade');
    }
  });

  // Skip the idle timer when nothing is configured to auto-hide:
  // banner/nav idle-hide is gated by their toggles, ghost chrome + slideshow
  // always auto-hide while those modes are active.
  if (!bannerEnabled && !navEnabled && !state.isGhost && !forceSlideshowHide) {
    return;
  }

  // No ocultar si el ratón está sobre el HUD
  const isHovering = elementsToHide.some(item => {
    if (!item.el) return false;
    if (item.el.id === 'slideshow-hud' && !state.slideshowActive) return false;
    return item.el.matches(':hover');
  });
  if (isHovering) return;

  const delay = (state.settings && state.settings.app && state.settings.app.hudAutoHideDelay !== undefined)
    ? state.settings.app.hudAutoHideDelay
    : 2000;

  hudTimer = setTimeout(() => {
    if (state.images.length === 0 && !state.isGhost && !state.slideshowActive) return;
    elementsToHide.forEach(item => {
      if (!item.el) return;
      if (item.el.id === 'slideshow-hud') {
        if (state.slideshowActive) item.el.classList.add(item.hideClass);
        return;
      }
      if (item.ghostOnly && !state.isGhost) return;

      if (item.el.id === 'nav-container') {
        // Keep nav buttons anchored to the canvas: still fade after the idle
        // timeout while hovering the image, but never fade while the pointer
        // is over a non-canvas surface.
        if (cursorOnCanvas && (navEnabled || forceSlideshowHide)) item.el.classList.add(item.hideClass);
        return;
      }
      if (item.el.id === 'viewer-filename') {
        if (cursorOnCanvas && (bannerEnabled || forceSlideshowHide)) item.el.classList.add(item.hideClass);
        return;
      }
      // Floating chrome (topbar/statusbar/kbd-hint/zoom-hud) always auto-hides
      // in fullscreen (ghost) and during slideshow; no user toggle for it.
      if (!state.isGhost && !forceSlideshowHide) return;

      // User-collapsed action bar stays collapsed (separate from FS auto-hide)
      if (item.el.id === 'kbd-hint' && state.toolbarOpen === false) return;

      const isTopbarOrStatusbar = (item.el.id === 'topbar' || item.el.id === 'statusbar');
      if (isTopbarOrStatusbar && !state.isGhost) return;
      item.el.classList.add(item.hideClass);
      if (item.el.id === 'zoom-hud') {
        item.el.classList.remove('visible');
      }
    });
  }, delay);
}

// Slideshow control wiring
(function initSlideshowControls() {
  const play = $('ss-play');
  const stop = $('ss-stop');
  const prevBtn = $('ss-prev');
  const nextBtn = $('ss-next');
  const loopBtn = $('ss-loop');
  const interval = $('ss-interval');
  const toolbar = $('btn-slideshow');

  if (play) play.addEventListener('click', (e) => { e.stopPropagation(); toggleSlideshowPlay(); });
  if (stop) stop.addEventListener('click', (e) => { e.stopPropagation(); stopSlideshow(); });
  if (prevBtn) prevBtn.addEventListener('click', (e) => { e.stopPropagation(); slideshowAdvance(-1); });
  if (nextBtn) nextBtn.addEventListener('click', (e) => { e.stopPropagation(); slideshowAdvance(1); });
  if (loopBtn) loopBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleSlideshowLoop(); });
  if (interval) {
    interval.addEventListener('change', (e) => {
      e.stopPropagation();
      setSlideshowIntervalMs(interval.value);
    });
    interval.addEventListener('click', (e) => e.stopPropagation());
  }
  if (toolbar) toolbar.addEventListener('click', () => toggleSlideshowPlay());

  // Hover keeps presentation bar visible; leave restarts idle hide
  const hud = $('slideshow-hud');
  if (hud) {
    hud.addEventListener('mouseenter', () => clearTimeout(hudTimer));
    hud.addEventListener('mouseleave', () => {
      if (typeof resetHudTimer === 'function') resetHudTimer();
    });
  }
})();

// Filename banner & nav buttons surface only while the cursor is over the
// canvas/image area. Derive that from the mousemove target — robust to the
// canvas-layer transform used by zoom/pan (its hit box moves) and to overlays,
// since it respects pointer-events — then run the usual HUD auto-hide pass.
window.addEventListener('mousemove', (e) => {
  const t = e.target;
  cursorOnCanvas = !!(t && (t === canvasL || canvasL.contains(t))) || t === viewerWrap;
  resetHudTimer();
});
elementsToHide.forEach(item => {
  if (item.el) {
    item.el.addEventListener('mouseenter', () => clearTimeout(hudTimer));
    item.el.addEventListener('mouseleave', resetHudTimer);
  }
});

// ── FAVORITES SYSTEM ──
function toggleFavorite() {
  const idx = state.current;
  if (idx === -1) return;
  const im = state.images[idx];
  if (!im || !im.file || !im.file.path) return;
  
  const path = im.file.path;
  const favs = state.settings.app.favorites || [];
  const index = favs.indexOf(path);
  
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  
  if (index === -1) {
    favs.push(path);
    showToast(lang === 'es' ? 'AÑADIDO A FAVORITOS' : 'ADDED TO FAVORITES', 'success');
  } else {
    favs.splice(index, 1);
    showToast(lang === 'es' ? 'ELIMINADO DE FAVORITOS' : 'REMOVED FROM FAVORITES', 'info');
  }
  
  state.settings.app.favorites = favs;
  if (isElectron) {
    window.electronAPI.saveSettings(state.settings.app);
  }
  
  updateFavButtonState();
}

// Toggle favorite for a specific image path (used by the thumb context menu,
// which can favorite an image that isn't the currently displayed one).
function toggleFavoritePath(filePath) {
  if (!filePath) return;
  const favs = state.settings.app.favorites || [];
  const index = favs.indexOf(filePath);
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  if (index === -1) {
    favs.push(filePath);
    showToast(lang === 'es' ? 'AÑADIDO A FAVORITOS' : 'ADDED TO FAVORITES', 'success');
  } else {
    favs.splice(index, 1);
    showToast(lang === 'es' ? 'ELIMINADO DE FAVORITOS' : 'REMOVED FROM FAVORITES', 'info');
  }
  state.settings.app.favorites = favs;
  if (isElectron) {
    window.electronAPI.saveSettings(state.settings.app);
  }
  updateFavButtonState();
  if (typeof buildSidebar === 'function') buildSidebar();
}

function updateFavButtonState() {
  const btn = $('btn-fav');
  if (!btn) return;
  
  const idx = state.current;
  if (idx === -1) {
    btn.classList.remove('favorited');
    btn.innerHTML = '&#9734;';
    return;
  }
  const im = state.images[idx];
  if (!im || !im.file || !im.file.path) {
    btn.classList.remove('favorited');
    btn.innerHTML = '&#9734;';
    return;
  }
  
  const favs = state.settings.app.favorites || [];
  const isFav = favs.includes(im.file.path);
  if (isFav) {
    btn.classList.add('favorited');
    btn.innerHTML = '&#9733;';
  } else {
    btn.classList.remove('favorited');
    btn.innerHTML = '&#9734;';
  }
}

function syncFavoritesToggleButtonState(lang) {
  const btn = $('btn-toggle-favs');
  if (!btn) return;
  if (!lang) {
    lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  }
  const favLbl = btn.querySelector('.fav-lbl');
  const favStar = btn.querySelector('.fav-star');
  
  if (state.showingFavs) {
    btn.classList.add('active');
    setCyberTooltip(btn, lang === 'es' ? 'Mostrar galería completa' : 'Show full gallery');
    if (favLbl) favLbl.textContent = lang === 'es' ? 'TODAS' : 'ALL';
    if (favStar) favStar.innerHTML = '&#9734;';
  } else {
    btn.classList.remove('active');
    setCyberTooltip(btn, lang === 'es' ? 'Mostrar Favoritos' : 'Show Favorites');
    if (favLbl) favLbl.textContent = lang === 'es' ? 'FAVORITOS' : 'FAVORITES';
    if (favStar) favStar.innerHTML = '&#9733;';
  }
}

async function toggleFavoritesView() {
  const btn = $('btn-toggle-favs');
  if (!btn) return;
  dismissToasts();
  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  
  if (!state.showingFavs) {
    const favs = state.settings.app.favorites || [];
    if (favs.length === 0) {
      showToast(lang === 'es' ? 'No hay favoritos guardados' : 'No favorites saved', 'info');
      return;
    }
    
    if (isElectron) {
      const validFavs = await window.electronAPI.validatePaths(favs);
      if (validFavs.length !== favs.length) {
        state.settings.app.favorites = validFavs;
        window.electronAPI.saveSettings(state.settings.app);
      }
      
      if (validFavs.length === 0) {
        showToast(lang === 'es' ? 'No hay favoritos guardados en disco' : 'No favorites found on disk', 'info');
        return;
      }

      // validate-paths does not expand the allowlist — register before loading
      if (window.electronAPI.registerPaths) {
        await window.electronAPI.registerPaths(validFavs);
      }
      
      state.nonFavImages = [...state.images];
      state.nonFavCurrent = state.current;
      
      const mapped = validFavs.map(p => {
        const name = p.split(/[\\/]/).pop();
        return {
          file: { name, path: p, size: 0, type: '' },
          url: null,
          loaded: false,
          w: 0,
          h: 0
        };
      });
      
      state.showingFavs = true;
      syncFavoritesToggleButtonState(lang);
      
      state.images = mapped;
      buildSidebar();
      dropZone.style.display = 'none';
      showImage(0, null, true);
      showToast(lang === 'es' ? 'VISTA DE FAVORITOS ACTIVA' : 'FAVORITES VIEW ACTIVE', 'success');
    } else {
      state.nonFavImages = [...state.images];
      state.nonFavCurrent = state.current;
      
      const mapped = favs.map(p => {
        const name = p.split(/[\\/]/).pop();
        return {
          file: { name, path: p, size: 0, type: '' },
          url: p,
          loaded: false,
          w: 0,
          h: 0
        };
      });
      
      state.showingFavs = true;
      syncFavoritesToggleButtonState(lang);
      
      state.images = mapped;
      buildSidebar();
      dropZone.style.display = 'none';
      showImage(0, null, true);
      showToast(lang === 'es' ? 'VISTA DE FAVORITOS ACTIVA' : 'FAVORITES VIEW ACTIVE', 'success');
    }
  } else {
    state.showingFavs = false;
    syncFavoritesToggleButtonState(lang);
    
    state.images = [...state.nonFavImages];
    buildSidebar();
    if (state.nonFavCurrent !== -1 && state.nonFavCurrent < state.images.length) {
      showImage(state.nonFavCurrent, null, true);
    } else if (state.images.length > 0) {
      showImage(0, null, true);
    } else {
      syncCurrentIndex(-1);
      state.transitioning = false;
      mainImg.onload = null;
      mainImg.onerror = null;
      clearImageError();
      mainImg.classList.remove('loaded');
      mainImg.src = '';
      dropZone.style.display = 'flex';
      $('sidebar-inner').innerHTML = '';
      const viewerFilename = $('viewer-filename');
      if (viewerFilename) viewerFilename.textContent = '';
      updateCounter();
    }
    if (state.nonFavImages.length > 0) {
      showToast(lang === 'es' ? 'GALERÍA COMPLETA RESTAURADA' : 'FULL GALLERY RESTORED', 'info');
    }
  }
}

$('btn-fav').addEventListener('click', toggleFavorite);
$('btn-toggle-favs').addEventListener('click', toggleFavoritesView);

// ── CUSTOM CONFIRMATION DIALOG ──
let confirmCallback = null;

$('btn-confirm-cancel').addEventListener('click', () => {
  closeModal('modal-cyber-confirm');
});
$('btn-confirm-ok').addEventListener('click', () => {
  closeModal('modal-cyber-confirm');
  if (confirmCallback) confirmCallback();
});

function showCyberConfirm({ title, message, detail, danger = true, onConfirm }) {
  $('confirm-title-text').textContent = title;
  $('confirm-message').textContent = message;
  $('confirm-detail').textContent = detail || '';
  confirmCallback = onConfirm;
  
  const box = document.querySelector('.confirm-modal-box');
  const iconBox = $('confirm-icon-box');
  const headerIcon = $('confirm-header-icon');
  const okBtn = $('btn-confirm-ok');
  
  if (danger) {
    box.style.borderColor = 'var(--cyber-accent2)';
    box.style.boxShadow = '0 0 25px rgba(255, 45, 120, 0.25)';
    iconBox.style.color = 'var(--cyber-accent2)';
    iconBox.style.borderColor = 'rgba(255, 45, 120, 0.3)';
    iconBox.style.background = 'rgba(255, 45, 120, 0.1)';
    iconBox.innerHTML = '&#128465;&#xFE0E;'; // Trash bin icon
    headerIcon.innerHTML = '&#128465;&#xFE0E;';
    headerIcon.style.color = 'var(--cyber-accent2)';
    
    okBtn.style.borderColor = 'var(--cyber-accent2)';
    okBtn.style.color = 'var(--cyber-accent2)';
  } else {
    box.style.borderColor = 'var(--cyber-accent)';
    box.style.boxShadow = '0 0 25px rgba(var(--cyber-accent-rgb), 0.25)';
    iconBox.style.color = 'var(--cyber-accent)';
    iconBox.style.borderColor = 'rgba(var(--cyber-accent-rgb), 0.3)';
    iconBox.style.background = 'rgba(var(--cyber-accent-rgb), 0.1)';
    iconBox.innerHTML = '&#9888;&#xFE0E;'; // Warning sign
    headerIcon.innerHTML = '&#9888;&#xFE0E;';
    headerIcon.style.color = 'var(--cyber-accent)';
    
    okBtn.style.borderColor = 'var(--cyber-accent)';
    okBtn.style.color = 'var(--cyber-accent)';
  }
  
  const lang = state.settings.app.language || 'en';
  $('btn-confirm-cancel').textContent = lang === 'es' ? 'ABORTAR' : 'ABORT';
  okBtn.textContent = lang === 'es' ? 'CONFIRMAR' : 'CONFIRM';
  
  openModal('modal-cyber-confirm');
}

// ── PROPERTIES PANEL ──
let propsNativePath = null;
let propsSummaryText = '';

function openPropertiesForCurrent() {
  if (!checkImageLoaded()) return;
  const im = state.images[state.current];
  const fpath = im ? imageDiskPath(im) : '';
  showPropertiesPanel(fpath);
}

function buildPropsBadges(name, fpath, isFav) {
  const host = $('props-badges');
  if (!host) return;
  host.innerHTML = '';
  const ext = name.includes('.') ? name.split('.').pop().toUpperCase() : '';
  if (ext) {
    const b = document.createElement('span');
    b.className = 'props-badge';
    b.textContent = ext;
    host.appendChild(b);
  }
  if (formatLikelyHasAlpha(name || fpath)) {
    const b = document.createElement('span');
    b.className = 'props-badge badge-alpha';
    b.textContent = 'ALPHA';
    host.appendChild(b);
  }
  if (isFav) {
    const b = document.createElement('span');
    b.className = 'props-badge badge-fav';
    b.textContent = 'FAV';
    host.appendChild(b);
  }
}

function formatPropsDate(ms, lang) {
  if (ms == null || !Number.isFinite(Number(ms))) return '-';
  try {
    return new Date(Number(ms)).toLocaleString(lang === 'es' ? 'es-ES' : undefined);
  } catch (_) {
    return '-';
  }
}

async function showPropertiesPanel(rawPath) {
  const im = state.images[state.current];
  if (!im) return;

  const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
  const es = lang === 'es';
  const i18nLang = I18N[lang] || I18N.en || {};

  const fpath = (im.file && im.file.path) || im.path || rawPath || '';
  const name = (im.file && im.file.name) || (fpath ? fpath.split(/[\\/]/).pop() : '-');
  propsNativePath = fpath;

  const w = im.w || mainImg.naturalWidth || 0;
  const h = im.h || mainImg.naturalHeight || 0;
  const ext = name.includes('.') ? name.split('.').pop().toUpperCase() : '';
  const mime = mimeFromPath(name || fpath);
  const ratio = formatAspectRatio(w, h);
  const mp = formatMegapixels(w, h);
  const idx = state.current >= 0 ? (state.current + 1) : 0;
  const total = state.images.length || 0;
  const favs = (state.settings && state.settings.app && state.settings.app.favorites) || [];
  const isFav = !!(fpath && favs.includes(fpath));

  // Instant fields
  if ($('props-name')) $('props-name').textContent = name || '-';
  if ($('props-format')) {
    $('props-format').textContent = mime ? (ext + ' · ' + mime) : (ext || '-');
  }
  if ($('props-dims')) $('props-dims').textContent = (w && h) ? (w + ' × ' + h + ' px') : '-';
  if ($('props-ratio')) $('props-ratio').textContent = ratio;
  if ($('props-mp')) $('props-mp').textContent = mp;
  if ($('props-index')) {
    $('props-index').textContent = total ? (idx + ' / ' + total) : '-';
  }
  if ($('props-fav')) {
    $('props-fav').textContent = isFav
      ? (i18nLang.props_fav_yes || (es ? 'Sí' : 'Yes'))
      : (i18nLang.props_fav_no || (es ? 'No' : 'No'));
  }
  if ($('props-size')) {
    $('props-size').textContent = (im.size || im.size === 0) ? formatBytes(im.size) : '…';
  }
  if ($('props-created')) $('props-created').textContent = '…';
  if ($('props-modified')) $('props-modified').textContent = '…';
  if ($('props-path')) {
    $('props-path').textContent = fpath || '-';
    setCyberTooltip($('props-path'), fpath || '');
  }
  if ($('props-readout')) {
    $('props-readout').textContent = (w && h)
      ? (w + ' × ' + h + ' PX  ·  ' + ratio + '  ·  ' + mp)
      : '—';
  }
  buildPropsBadges(name, fpath, isFav);

  const preview = $('props-preview');
  if (preview) {
    if (mainImg && mainImg.src) {
      preview.src = mainImg.src;
      preview.style.display = '';
    } else {
      preview.removeAttribute('src');
      preview.style.display = 'none';
    }
  }

  // Footer tooltips (i18n may already set via data-i18n-title; reinforce native tip)
  if ($('props-native-btn')) {
    setCyberTooltip($('props-native-btn'),
      i18nLang.props_native_tooltip ||
      (es
        ? 'Abrir el diálogo nativo de Windows (puede tardar un par de segundos)'
        : 'Open the native Windows dialog (may take a couple of seconds)'));
  }

  propsSummaryText = [
    name,
    (w && h) ? (w + '×' + h + ' px') : '',
    ratio !== '-' ? ratio : '',
    mp !== '-' ? mp : '',
    (im.size || im.size === 0) ? formatBytes(im.size) : '',
    fpath
  ].filter(Boolean).join('\n');

  if (typeof pauseSlideshow === 'function') pauseSlideshow();
  openModal('modal-properties');

  // Fresh size / dates from disk
  let size = im.size;
  let modified = null;
  let created = null;
  if (isElectron && fpath && window.electronAPI.getFileInfo) {
    try {
      const info = await window.electronAPI.getFileInfo(fpath);
      if (info) {
        size = info.size;
        modified = info.modified;
        created = info.created;
        if (Number.isFinite(info.size)) {
          im.size = info.size;
          if (im.file) im.file.size = info.size;
        }
      }
    } catch (_) { /* keep fallbacks */ }
  }
  if (!$('modal-properties') || !$('modal-properties').classList.contains('active') || propsNativePath !== fpath) {
    return;
  }
  if ($('props-size')) {
    $('props-size').textContent = (size || size === 0) ? formatBytes(size) : '-';
  }
  if ($('props-modified')) $('props-modified').textContent = formatPropsDate(modified, lang);
  if ($('props-created')) $('props-created').textContent = formatPropsDate(created, lang);

  propsSummaryText = [
    name,
    (w && h) ? (w + '×' + h + ' px') : '',
    ratio !== '-' ? ratio : '',
    mp !== '-' ? mp : '',
    (size || size === 0) ? formatBytes(size) : '',
    created != null ? ('created: ' + formatPropsDate(created, lang)) : '',
    modified != null ? ('modified: ' + formatPropsDate(modified, lang)) : '',
    fpath
  ].filter(Boolean).join('\n');
}

if ($('props-native-btn')) {
  $('props-native-btn').addEventListener('click', () => {
    if (propsNativePath && isElectron && window.electronAPI.openNativeProperties) {
      window.electronAPI.openNativeProperties(propsNativePath);
    }
  });
}

if ($('props-copy-path')) {
  $('props-copy-path').addEventListener('click', async () => {
    const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
    const i18nLang = I18N[lang] || I18N.en || {};
    if (!propsNativePath) {
      showToast(i18nLang.toast_path_not_found || 'PATH NOT FOUND', 'error');
      return;
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(propsNativePath);
      } else if (isElectron && window.electronAPI && window.electronAPI.copyText) {
        await window.electronAPI.copyText(propsNativePath);
      } else {
        throw new Error('no clipboard');
      }
      showToast(i18nLang.toast_path_copied || 'PATH COPIED', 'success');
    } catch (_) {
      showToast(i18nLang.toast_copy_error || 'ERROR COPYING', 'error');
    }
  });
}

if ($('props-copy-summary')) {
  $('props-copy-summary').addEventListener('click', async () => {
    const lang = (state.settings && state.settings.app && state.settings.app.language) || 'en';
    const i18nLang = I18N[lang] || I18N.en || {};
    const text = propsSummaryText || '';
    if (!text) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else if (isElectron && window.electronAPI && window.electronAPI.copyText) {
        await window.electronAPI.copyText(text);
      } else {
        throw new Error('no clipboard');
      }
      showToast(i18nLang.toast_summary_copied || 'SUMMARY COPIED', 'success');
    } catch (_) {
      showToast(i18nLang.toast_copy_error || 'ERROR COPYING', 'error');
    }
  });
}

if ($('props-show-folder')) {
  $('props-show-folder').addEventListener('click', () => {
    if (propsNativePath && isElectron && window.electronAPI.showItemInFolder) {
      window.electronAPI.showItemInFolder(propsNativePath);
    } else if ($('btn-show-folder')) {
      $('btn-show-folder').click();
    }
  });
}

if ($('btn-props')) {
  $('btn-props').addEventListener('click', openPropertiesForCurrent);
}

function wireFooterPropsHit(id) {
  const el = $(id);
  if (!el) return;
  const open = (e) => {
    if (e) e.preventDefault();
    if (state.current >= 0 && state.images[state.current]) openPropertiesForCurrent();
  };
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') open(e);
  });
}
wireFooterPropsHit('footer-size');
wireFooterPropsHit('footer-weight');

// ── INIT ──
syncEmptyState();
updateCounter();
resetHudTimer();

// Tell main process the first paint is ready (avoids white flash on win.show)
if (isElectron && window.electronAPI && typeof window.electronAPI.uiReady === 'function') {
  const notifyReady = () => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        try { window.electronAPI.uiReady(); } catch (_) { /* ignore */ }
      });
    });
  };
  if (document.readyState === 'complete') notifyReady();
  else window.addEventListener('load', notifyReady, { once: true });
}

// ── SIDEBAR DRAG TO SCROLL ──
(function() {
  const scrollArea = $('sidebar-scroll');
  if (!scrollArea) return;

  let isDraggingPossible = false;
  let isDragging = false;
  let startY = 0;
  let startScrollTop = 0;
  let hasDragged = false;
  let activePointerId = null;

  // Inertia settings
  let lastY = 0;
  let lastTime = 0;
  let velocity = 0;
  let rafId = null;

  scrollArea.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const target = e.target;
    if (target.closest('button, input, select, textarea')) return;

    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }

    isDraggingPossible = true;
    isDragging = false;
    startY = e.pageY;
    lastY = e.pageY;
    lastTime = Date.now();
    startScrollTop = scrollArea.scrollTop;
    hasDragged = false;
    velocity = 0;
    activePointerId = e.pointerId;
  });

  scrollArea.addEventListener('pointermove', (e) => {
    if (!isDraggingPossible) return;

    const deltaY = e.pageY - startY;

    // Start dragging only if movement threshold is crossed
    if (!isDragging && Math.abs(deltaY) > 5) {
      isDragging = true;
      hasDragged = true;
      scrollArea.style.cursor = 'grabbing';
      scrollArea.style.userSelect = 'none';
      try {
        scrollArea.setPointerCapture(activePointerId);
      } catch (_) {}
    }

    if (isDragging) {
      const now = Date.now();
      const elapsed = now - lastTime;

      scrollArea.scrollTop = startScrollTop - deltaY;

      if (elapsed > 0) {
        const currentVelocity = (e.pageY - lastY) / elapsed;
        velocity = velocity * 0.4 + currentVelocity * 0.6;
      }

      lastY = e.pageY;
      lastTime = now;
    }
  });

  scrollArea.addEventListener('pointerup', () => {
    const wasDragging = isDragging;
    isDraggingPossible = false;
    isDragging = false;
    scrollArea.style.cursor = '';
    scrollArea.style.userSelect = '';
    
    if (wasDragging && activePointerId !== null) {
      try { scrollArea.releasePointerCapture(activePointerId); } catch (_) {}
    }

    if (wasDragging) {
      const timeSinceLastMove = Date.now() - lastTime;
      if (timeSinceLastMove < 50 && Math.abs(velocity) > 0.05) {
        velocity = Math.max(-2.5, Math.min(2.5, velocity));
        applyInertia();
      }
    }
    activePointerId = null;
  });

  scrollArea.addEventListener('pointercancel', () => {
    const wasDragging = isDragging;
    isDraggingPossible = false;
    isDragging = false;
    scrollArea.style.cursor = '';
    scrollArea.style.userSelect = '';
    if (wasDragging && activePointerId !== null) {
      try { scrollArea.releasePointerCapture(activePointerId); } catch (_) {}
    }
    activePointerId = null;
  });

  scrollArea.addEventListener('click', (e) => {
    if (hasDragged) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  function applyInertia() {
    let lastFrameTime = performance.now();

    function step(now) {
      if (isDragging) return;
      const dt = now - lastFrameTime;
      lastFrameTime = now;

      const delta = velocity * Math.min(dt, 32);
      scrollArea.scrollTop -= delta;

      velocity *= 0.95; // friction

      if (Math.abs(velocity) > 0.01) {
        rafId = requestAnimationFrame(step);
      } else {
        rafId = null;
      }
    }

    rafId = requestAnimationFrame(step);
  }
})();
