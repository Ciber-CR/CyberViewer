'use strict';

const path = require('path');
const fs = require('fs');

const IMAGE_EXTS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.ico'
]);

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.ico': 'image/x-icon'
};

/**
 * Normalize file:// / cvlocal:// / percent-encoding into an absolute FS path.
 * Prefer cvlocal://media/?p=<encoded> so Windows drive letters are never hosts.
 */
function cleanFsPath(p) {
  if (p == null || typeof p !== 'string') {
    throw new TypeError('Path must be a string');
  }
  let cleanPath = p.trim();

  if (cleanPath.startsWith('cvlocal:')) {
    try {
      const asHttp = cleanPath.replace(/^cvlocal:/i, 'http:');
      const u = new URL(asHttp);
      const fromQuery = u.searchParams.get('p');
      if (fromQuery) {
        return path.resolve(fromQuery);
      }
    } catch (_) {
      // fall through to legacy parsing
    }

    if (cleanPath.startsWith('cvlocal:///')) {
      cleanPath = cleanPath.slice('cvlocal:///'.length);
    } else if (cleanPath.startsWith('cvlocal://')) {
      cleanPath = cleanPath.slice('cvlocal://'.length);
      // Legacy broken form: host was drive letter (cvlocal://c/Users/...)
      if (/^[A-Za-z]\//.test(cleanPath)) {
        cleanPath = cleanPath[0] + ':' + cleanPath.slice(1);
      } else if (cleanPath.startsWith('/')) {
        cleanPath = cleanPath.slice(1);
      }
    }
  } else if (cleanPath.startsWith('file:///')) {
    cleanPath = cleanPath.slice(8);
  } else if (cleanPath.startsWith('file://')) {
    cleanPath = cleanPath.slice(7);
  }

  const q = cleanPath.indexOf('?');
  if (q !== -1) cleanPath = cleanPath.slice(0, q);

  try {
    cleanPath = decodeURIComponent(cleanPath);
  } catch (_) {
    // keep as-is
  }

  if (process.platform === 'win32' && cleanPath.startsWith('/') && /^\/[A-Za-z]:/.test(cleanPath)) {
    cleanPath = cleanPath.slice(1);
  }
  return path.resolve(cleanPath);
}

/** Build a cvlocal URL that keeps Windows paths intact (query param, not path host). */
function toMediaUrl(fsPath, bust) {
  const abs = path.resolve(fsPath);
  let url = 'cvlocal://media/?p=' + encodeURIComponent(abs);
  if (bust != null && bust !== false) {
    url += '&t=' + encodeURIComponent(String(bust));
  }
  return url;
}

function mimeForPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function isImagePath(filePath) {
  try {
    const ext = path.extname(cleanFsPath(filePath)).toLowerCase();
    return IMAGE_EXTS.has(ext);
  } catch (_) {
    return false;
  }
}

/**
 * True only for an existing regular file with a supported image extension.
 * Rejects directories and non-images so the allowlist cannot be widened via arbitrary paths.
 */
function isExistingImageFile(filePath) {
  try {
    const abs = cleanFsPath(filePath);
    if (!isImagePath(abs)) return false;
    if (!fs.existsSync(abs)) return false;
    return fs.statSync(abs).isFile();
  } catch (_) {
    return false;
  }
}

function createPathAllowlist(extraRoots = []) {
  const roots = new Set();

  function normalizeRoot(p) {
    return path.resolve(p).toLowerCase();
  }

  function allow(fsPath) {
    try {
      const abs = path.resolve(fsPath);
      const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
      const root = stat && stat.isDirectory() ? abs : path.dirname(abs);
      roots.add(normalizeRoot(root));
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Expand allowlist only for existing image files (parent directory is registered).
   * @returns {string|null} absolute path if registered, else null
   */
  function allowImageFile(fsPath) {
    try {
      const abs = cleanFsPath(fsPath);
      if (!isExistingImageFile(abs)) return null;
      allow(abs);
      return abs;
    } catch (_) {
      return null;
    }
  }

  for (const r of extraRoots) {
    if (r) allow(r);
  }

  function isAllowed(fsPath) {
    let abs;
    try {
      abs = path.resolve(fsPath);
    } catch (_) {
      return false;
    }
    const absLower = abs.toLowerCase().replace(/\//g, '\\');
    for (const root of roots) {
      const rootSlash = root.replace(/\//g, '\\');
      if (absLower === rootSlash || absLower.startsWith(rootSlash + '\\')) {
        return true;
      }
    }
    return false;
  }

  function assertAllowed(fsPath) {
    const abs = cleanFsPath(fsPath);
    if (!isAllowed(abs)) {
      const err = new Error('Path not allowed: ' + abs);
      err.code = 'PATH_NOT_ALLOWED';
      throw err;
    }
    return abs;
  }

  return { allow, allowImageFile, isAllowed, assertAllowed, cleanFsPath, roots };
}

function canvasMimeForPath(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') {
    return { mime: 'image/jpeg', quality: 0.95, ext: '.jpg' };
  }
  return { mime: 'image/png', quality: undefined, ext: '.png' };
}

module.exports = {
  IMAGE_EXTS,
  MIME_BY_EXT,
  cleanFsPath,
  toMediaUrl,
  mimeForPath,
  isImagePath,
  isExistingImageFile,
  createPathAllowlist,
  canvasMimeForPath
};
