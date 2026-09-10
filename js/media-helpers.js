'use strict';

/**
 * Pure media/path helpers shared by the renderer and unit tests.
 * UMD: browser → window.CVMedia; Node → module.exports
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CVMedia = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  /**
   * Build a cvlocal:// URL that keeps Windows paths intact (query param, not path host).
   * @param {string} fsPath
   * @param {string|number|boolean|null} [bust]
   */
  function mediaUrl(fsPath, bust) {
    if (!fsPath) return '';
    const s = String(fsPath);
    if (s.startsWith('blob:') || s.startsWith('data:')) return s;
    if (s.startsWith('cvlocal:')) {
      try {
        const u = new URL(s.replace(/^cvlocal:/i, 'http:'));
        const p = u.searchParams.get('p');
        if (p) {
          let url = 'cvlocal://media/?p=' + encodeURIComponent(p);
          if (bust != null && bust !== false) url += '&t=' + encodeURIComponent(String(bust));
          return url;
        }
      } catch (_) { /* fall through */ }
    }
    let url = 'cvlocal://media/?p=' + encodeURIComponent(s);
    if (bust != null && bust !== false) url += '&t=' + encodeURIComponent(String(bust));
    return url;
  }

  /**
   * Build a CSS Canvas filter string from basic adjust controls.
   * Tone sliders use -100..100 with 0 as neutral (maps to factor 1.0).
   * Blur uses 0..100 → 0..20px at the current canvas resolution.
   * @param {{ brightness?: number, contrast?: number, saturation?: number, blur?: number, grayscale?: boolean, invert?: boolean }} opts
   * @param {{ blurScale?: number }} [renderOpts] optional multiplier for blur px (e.g. preview scale)
   * @returns {string}
   */
  function buildCssFilter(opts, renderOpts) {
    const o = opts || {};
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number(n) || 0));
    const toFactor = (n) => 1 + clamp(n, -100, 100) / 100;
    const blurScale = renderOpts && renderOpts.blurScale != null ? Number(renderOpts.blurScale) : 1;
    const safeScale = Number.isFinite(blurScale) && blurScale > 0 ? blurScale : 1;
    // Scale blur with canvas size so a downscaled preview matches full-res strength
    const blurPx = (clamp(o.blur, 0, 100) / 100) * 20 * safeScale;
    const parts = [
      'brightness(' + toFactor(o.brightness) + ')',
      'contrast(' + toFactor(o.contrast) + ')',
      'saturate(' + toFactor(o.saturation) + ')',
      'grayscale(' + (o.grayscale ? 1 : 0) + ')',
      'invert(' + (o.invert ? 1 : 0) + ')'
    ];
    if (blurPx > 0.01) {
      parts.push('blur(' + (Math.round(blurPx * 100) / 100) + 'px)');
    }
    return parts.join(' ');
  }

  /**
   * True when adjust controls are all at neutral defaults.
   * @param {{ brightness?: number, contrast?: number, saturation?: number, blur?: number, grayscale?: boolean, invert?: boolean }} opts
   */
  function isIdentityAdjust(opts) {
    const o = opts || {};
    return (
      (Number(o.brightness) || 0) === 0 &&
      (Number(o.contrast) || 0) === 0 &&
      (Number(o.saturation) || 0) === 0 &&
      (Number(o.blur) || 0) === 0 &&
      !o.grayscale &&
      !o.invert
    );
  }

  /**
   * Export a canvas to base64 buffer + path for save-image IPC.
   * Rasterizes exotic containers (gif/webp/bmp/tiff) to PNG.
   * @param {HTMLCanvasElement} canvas
   * @param {string} filePath
   */
  function canvasExport(canvas, filePath) {
    const ext = (String(filePath || '').split('.').pop() || '').toLowerCase();
    if (ext === 'jpg' || ext === 'jpeg') {
      return {
        buffer: canvas.toDataURL('image/jpeg', 0.95).split(',')[1],
        filePath: filePath
      };
    }
    let outPath = filePath;
    if (ext !== 'png') {
      outPath = String(filePath).replace(/\.[^.]+$/i, '.png');
    }
    return {
      buffer: canvas.toDataURL('image/png').split(',')[1],
      filePath: outPath
    };
  }

  /**
   * Human-readable byte size for properties / status.
   * @param {number|null|undefined} bytes
   */
  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return '-';
    if (bytes > 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    if (bytes > 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
  }

  /**
   * Guess image MIME from filename extension (display only; not sniffing).
   * @param {string} fileNameOrPath
   */
  function mimeFromPath(fileNameOrPath) {
    const base = String(fileNameOrPath || '').split(/[\\/]/).pop() || '';
    const dot = base.lastIndexOf('.');
    if (dot <= 0 || dot === base.length - 1) return '';
    const ext = base.slice(dot + 1).toLowerCase();
    const map = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
      bmp: 'image/bmp',
      tif: 'image/tiff',
      tiff: 'image/tiff',
      ico: 'image/x-icon',
      svg: 'image/svg+xml'
    };
    return map[ext] || '';
  }

  /**
   * Format aspect ratio for HUD (named common ratios or decimal).
   * @param {number} w
   * @param {number} h
   */
  function formatAspectRatio(w, h) {
    const width = Number(w) || 0;
    const height = Number(h) || 0;
    if (width < 1 || height < 1) return '-';
    const r = width / height;
    const named = [
      [1, '1:1'],
      [4 / 3, '4:3'],
      [3 / 2, '3:2'],
      [16 / 10, '16:10'],
      [16 / 9, '16:9'],
      [21 / 9, '21:9'],
      [5 / 4, '5:4'],
      [2 / 1, '2:1'],
      [9 / 16, '9:16'],
      [3 / 4, '3:4'],
      [2 / 3, '2:3']
    ];
    for (let i = 0; i < named.length; i++) {
      if (Math.abs(r - named[i][0]) < 0.02) return named[i][1];
    }
    // Reduced integer ratio when small
    const g = function gcd(a, b) {
      a = Math.round(Math.abs(a));
      b = Math.round(Math.abs(b));
      while (b) {
        const t = b;
        b = a % b;
        a = t;
      }
      return a || 1;
    };
    const d = g(width, height);
    const rw = Math.round(width / d);
    const rh = Math.round(height / d);
    if (rw <= 50 && rh <= 50) return rw + ':' + rh;
    return r.toFixed(2) + ':1';
  }

  /**
   * Megapixels label, e.g. "2.07 MP".
   * @param {number} w
   * @param {number} h
   */
  function formatMegapixels(w, h) {
    const width = Number(w) || 0;
    const height = Number(h) || 0;
    if (width < 1 || height < 1) return '-';
    const mp = (width * height) / 1e6;
    if (mp < 0.01) return (mp * 1000).toFixed(0) + ' KP';
    if (mp < 10) return mp.toFixed(2) + ' MP';
    return mp.toFixed(1) + ' MP';
  }

  /** True for formats that commonly carry an alpha channel. */
  function formatLikelyHasAlpha(fileNameOrPath) {
    const ext = (String(fileNameOrPath || '').split('.').pop() || '').toLowerCase();
    return ext === 'png' || ext === 'webp' || ext === 'gif' || ext === 'tif' || ext === 'tiff' || ext === 'svg';
  }

  /**
   * Slider 0–1000 ↔ zoom factor (log scale).
   */
  function sliderToZoom(val, zoomMin, zoomMax) {
    const t = Math.max(0, Math.min(1000, Number(val) || 0)) / 1000;
    const min = zoomMin != null ? zoomMin : 0.05;
    const max = zoomMax != null ? zoomMax : 20;
    return min * Math.pow(max / min, t);
  }

  function zoomToSlider(zoom, zoomMin, zoomMax) {
    const min = zoomMin != null ? zoomMin : 0.05;
    const max = zoomMax != null ? zoomMax : 20;
    const z = Math.max(min, Math.min(max, Number(zoom) || 1));
    const t = Math.log(z / min) / Math.log(max / min);
    return Math.round(t * 1000);
  }

  /**
   * Zoom that maps one captured physical screen pixel to one physical pixel
   * on the current display. Windows/Electron render CSS px in logical pixels,
   * so a 150% display needs a 1 / 1.5 image scale.
   * @param {number} devicePixelRatio
   */
  function screenCaptureZoom(devicePixelRatio) {
    const dpr = Number(devicePixelRatio);
    return Number.isFinite(dpr) && dpr > 0 ? 1 / dpr : 1;
  }

  /** Parent directory of a file path (Windows / POSIX separators). */
  function folderDirFromPath(filePath) {
    if (!filePath) return '';
    const norm = String(filePath).replace(/[\\/]+$/, '');
    const i = Math.max(norm.lastIndexOf('\\'), norm.lastIndexOf('/'));
    return i >= 0 ? norm.slice(0, i) : '';
  }

  /** Last segment of a directory path. */
  function folderNameFromPath(dirPath) {
    if (!dirPath) return '';
    const norm = String(dirPath).replace(/[\\/]+$/, '');
    const parts = norm.split(/[\\/]/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  // Print / PDF export helpers (Chromium engine, no native deps)

  /** Named page surfaces in inches (portrait orientation). */
  const PRINT_PAGE_INCHES = {
    Letter: { width: 8.5, height: 11 },
    Legal: { width: 8.5, height: 14 },
    A5: { width: 5.83, height: 8.27 },
    A4: { width: 8.27, height: 11.69 },
    A3: { width: 11.69, height: 16.54 },
    Tabloid: { width: 11, height: 17 },
    Ledger: { width: 17, height: 11 }
  };

  function round1(n) { return Math.round(Number(n) * 10) / 10; }

  /** Convert centimeters to printer pixels at 96 DPI (Electron margins unit). */
  function cmToPx(cm) {
    return Math.round((Number(cm) || 0) / 2.54 * 96);
  }

  /** Convert centimeters to inches (Electron printToPDF custom margins unit). */
  function cmToIn(cm) {
    return Math.round(((Number(cm) || 0) / 2.54) * 100) / 100;
  }

  function pageInchesForExport(pageSize, width, height) {
    if (pageSize === 'Fit') {
      const minIn = 0.5;
      const maxIn = 200;
      const wi = Math.max(minIn, Math.min(maxIn, (Number(width) || 0) / 96));
      const hi = Math.max(minIn, Math.min(maxIn, (Number(height) || 0) / 96));
      return { width: round1(Math.max(wi, minIn)), height: round1(Math.max(hi, minIn)) };
    }
    const named = PRINT_PAGE_INCHES[pageSize] || PRINT_PAGE_INCHES.Letter;
    return { width: named.width, height: named.height };
  }

  function resolveExportOptions(opts, width, height, target) {
    const o = opts || {};
    const marginTarget = target === 'print' ? 'print' : 'pdf';
    const pageSize = o.pageSize || 'Letter';
    // Fit sizes the page to the image already — landscape would re-swap it.
    const landscape = pageSize !== 'Fit' && o.orientation === 'Landscape';
    let page = pageInchesForExport(pageSize, width, height);
    if (landscape) {
      page = { width: page.height, height: page.width };
    }
    const hasMargins = pageSize !== 'Fit' &&
      !!(Number(o.marginTop) || Number(o.marginBottom) || Number(o.marginLeft) || Number(o.marginRight));
    let margins;
    if (pageSize === 'Fit') {
      margins = { marginType: 'none' };
    } else if (!hasMargins) {
      margins = { marginType: 'default' };
    } else {
      const convertMargin = marginTarget === 'print' ? cmToPx : cmToIn;
      margins = {
        marginType: 'custom',
        top: convertMargin(o.marginTop),
        bottom: convertMargin(o.marginBottom),
        left: convertMargin(o.marginLeft),
        right: convertMargin(o.marginRight)
      };
    }
    const size = pageSize === 'Fit' ? { width: page.width, height: page.height } : pageSize;
    return {
      pageSize: size,
      landscape: !!landscape,
      margins: margins,
      printBackground: true
    };
  }

  function bakePrintHtml(dataUrl, width, height, title) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    const lt = String.fromCharCode(38) + 'lt;';
    const gt = String.fromCharCode(38) + 'gt;';
    const safeTitle = String(title || 'CyberViewer').replace(/</g, lt).replace(/>/g, gt);
    const src = String(dataUrl || '');
    const wAttr = w > 0 ? ' width="' + w + '"' : '';
    const hAttr = h > 0 ? ' height="' + h + '"' : '';
    return '<!DOCTYPE html><html><head><meta charset="UTF-8"><title>' + safeTitle + '</title>' +
      '<style>html,body{margin:0;padding:0;background:#fff;height:100%}' +
      'body{display:flex;align-items:center;justify-content:center;min-height:100%}' +
      'img{max-width:100%;max-height:100%;object-fit:contain;display:block}</style>' +
      '</head><body><img src="' + src + '" alt=""' + wAttr + hAttr + '></body></html>';
  }

  return {
    mediaUrl,
    canvasExport,
    buildCssFilter,
    isIdentityAdjust,
    formatBytes,
    mimeFromPath,
    formatAspectRatio,
    formatMegapixels,
    formatLikelyHasAlpha,
    sliderToZoom,
    zoomToSlider,
    screenCaptureZoom,
    folderDirFromPath,
    folderNameFromPath,
    PRINT_PAGE_INCHES,
    cmToPx,
    cmToIn,
    pageInchesForExport,
    resolveExportOptions,
    bakePrintHtml
  };
});
