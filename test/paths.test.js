'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fs = require('fs');
const {
  cleanFsPath,
  toMediaUrl,
  mimeForPath,
  canvasMimeForPath,
  createPathAllowlist,
  isImagePath
} = require('../lib/paths');
const { evictThumbCache } = require('../lib/thumb-cache');

describe('cleanFsPath', () => {
  it('strips file:// and resolves', () => {
    const sample = path.resolve('C:\\Images\\photo.png');
    const url = 'file:///' + sample.replace(/\\/g, '/');
    const cleaned = cleanFsPath(url);
    assert.equal(cleaned.toLowerCase(), sample.toLowerCase());
  });

  it('reads cvlocal ?p= query (Windows-safe)', () => {
    const sample = path.resolve('C:\\Images\\a.jpg');
    const url = toMediaUrl(sample, 123);
    const cleaned = cleanFsPath(url);
    assert.equal(cleaned.toLowerCase(), sample.toLowerCase());
  });

  it('recovers legacy drive-as-host form', () => {
    const cleaned = cleanFsPath('cvlocal://c/Users/test/pic.png');
    assert.match(cleaned.toLowerCase(), /c:\\users\\test\\pic\.png$/);
  });
});

describe('toMediaUrl', () => {
  it('uses query param, not path host', () => {
    const sample = path.resolve('C:\\x\\y.png');
    const url = toMediaUrl(sample);
    assert.match(url, /^cvlocal:\/\/media\/\?p=/);
    assert.ok(url.includes(encodeURIComponent(sample)) || url.includes(encodeURIComponent(sample.replace(/\\/g, '\\'))));
    assert.ok(!/^cvlocal:\/\/\/[A-Za-z]:/.test(url));
  });
});

describe('canvasMimeForPath', () => {
  it('uses jpeg for jpg', () => {
    assert.equal(canvasMimeForPath('a.JPG').mime, 'image/jpeg');
  });
  it('uses png for png/webp/gif', () => {
    assert.equal(canvasMimeForPath('a.png').mime, 'image/png');
    assert.equal(canvasMimeForPath('a.webp').mime, 'image/png');
    assert.equal(canvasMimeForPath('a.gif').mime, 'image/png');
  });
});

describe('mimeForPath', () => {
  it('serves ICO files with an image MIME type', () => {
    assert.equal(mimeForPath('assets/icon.ico'), 'image/x-icon');
  });
});

describe('isImagePath', () => {
  it('accepts common extensions', () => {
    assert.equal(isImagePath('x.tiff'), true);
    assert.equal(isImagePath('x.ico'), true);
    assert.equal(isImagePath('x.txt'), false);
  });
});

describe('path allowlist', () => {
  it('allows registered roots and rejects others', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-allow-'));
    const nested = path.join(tmp, 'nested');
    fs.mkdirSync(nested);
    const img = path.join(nested, 'pic.png');
    fs.writeFileSync(img, 'x');

    const allow = createPathAllowlist([tmp]);
    assert.equal(allow.isAllowed(img), true);
    assert.equal(allow.isAllowed(path.join(os.tmpdir(), 'other-cv', 'nope.png')), false);

    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('evictThumbCache', () => {
  it('removes oldest files when over maxFiles', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cv-thumbs-'));
    for (let i = 0; i < 5; i++) {
      const f = path.join(tmp, `t${i}.jpg`);
      fs.writeFileSync(f, Buffer.alloc(100));
      const past = new Date(Date.now() - (5 - i) * 1000);
      fs.utimesSync(f, past, past);
    }
    const result = evictThumbCache(tmp, { maxFiles: 2, maxBytes: 1024 * 1024 });
    assert.equal(result.removed, 3);
    assert.equal(fs.readdirSync(tmp).filter((n) => n.endsWith('.jpg')).length, 2);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
