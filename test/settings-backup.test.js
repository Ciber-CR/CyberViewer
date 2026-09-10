'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  FORMAT,
  FORMAT_VERSION,
  pickSettings,
  sanitizeFavorites,
  buildBackup,
  parseBackup,
  applyBackup
} = require('../lib/settings-backup');

describe('pickSettings', () => {
  it('keeps known booleans and drops junk', () => {
    const out = pickSettings({
      closeToTray: true,
      imageOutline: true,
      language: 'es',
      accentColor: '#FF2D78',
      extra: 'nope',
      hudAutoHideDelay: 2500
    });
    assert.equal(out.closeToTray, true);
    assert.equal(out.imageOutline, true);
    assert.equal(out.language, 'es');
    assert.equal(out.accentColor, '#ff2d78');
    assert.equal(out.hudAutoHideDelay, 2500);
    assert.equal(out.extra, undefined);
  });

  it('rejects invalid enums and colors', () => {
    const out = pickSettings({
      language: 'fr',
      accentColor: 'cyan',
      navZoomMode: 'zoom-forever',
      slideshowIntervalMs: 1234
    });
    assert.deepEqual(out, {});
  });
});

describe('sanitizeFavorites', () => {
  it('trims, dedupes case-insensitively, and drops empties', () => {
    const out = sanitizeFavorites([
      ' C:\\a.jpg ',
      'c:\\A.jpg',
      '',
      12,
      'D:\\b.png'
    ]);
    assert.deepEqual(out, ['C:\\a.jpg', 'D:\\b.png']);
  });
});

describe('buildBackup / parseBackup', () => {
  it('round-trips settings and favorites', () => {
    const backup = buildBackup({
      closeToTray: true,
      language: 'en',
      accentColor: '#00d4ff',
      favorites: ['C:\\pics\\one.png', 'C:\\pics\\two.jpg'],
      recentFiles: ['C:\\ignore-me.png'],
      updateNotify: { lastNotifiedAvailable: '9.9.9' }
    }, { appVersion: '1.11.1', exportedAt: '2026-08-21T00:00:00.000Z' });

    assert.equal(backup.format, FORMAT);
    assert.equal(backup.version, FORMAT_VERSION);
    assert.equal(backup.appVersion, '1.11.1');
    assert.equal(backup.settings.closeToTray, true);
    assert.equal(backup.settings.recentFiles, undefined);
    assert.deepEqual(backup.favorites, ['C:\\pics\\one.png', 'C:\\pics\\two.jpg']);

    const parsed = parseBackup(JSON.stringify(backup));
    assert.equal(parsed.ok, true);
    assert.equal(parsed.settings.closeToTray, true);
    assert.equal(parsed.favorites.length, 2);
  });

  it('accepts a raw settings.json dump', () => {
    const parsed = parseBackup({
      window: { width: 800 },
      app: {
        language: 'es',
        favorites: ['E:\\fav.gif']
      }
    });
    assert.equal(parsed.ok, true);
    assert.equal(parsed.settings.language, 'es');
    assert.deepEqual(parsed.favorites, ['E:\\fav.gif']);
  });

  it('rejects invalid JSON and empty payloads', () => {
    assert.equal(parseBackup('{').ok, false);
    assert.equal(parseBackup('{').error, 'INVALID_JSON');
    assert.equal(parseBackup([]).ok, false);
    assert.equal(parseBackup({ format: FORMAT, version: 1, settings: {}, favorites: [] }).error, 'EMPTY_BACKUP');
  });
});

describe('applyBackup', () => {
  it('replaces favorites and merges settings, keeping recents', () => {
    const applied = applyBackup({
      language: 'en',
      closeToTray: false,
      favorites: ['old.png'],
      recentFiles: ['keep.jpg']
    }, parseBackup({
      format: FORMAT,
      version: 1,
      settings: { language: 'es', closeToTray: true },
      favorites: ['new.png']
    }));
    assert.equal(applied.ok, true);
    assert.equal(applied.app.language, 'es');
    assert.equal(applied.app.closeToTray, true);
    assert.deepEqual(applied.app.favorites, ['new.png']);
    assert.deepEqual(applied.app.recentFiles, ['keep.jpg']);
  });
});
