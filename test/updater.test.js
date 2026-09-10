'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

/**
 * Load lib/updater.js with a stubbed electron / electron-updater surface.
 * Keeps process.env mutations for the duration of the returned helpers.
 */
function loadUpdaterWithStubs(env = {}) {
  const savedEnv = { ...process.env };
  // Clear portable markers then apply test env
  delete process.env.PORTABLE_EXECUTABLE_DIR;
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  delete process.env.PORTABLE_EXECUTABLE_APP_FILENAME;
  Object.assign(process.env, env);

  const listeners = {};
  const autoUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: false,
    logger: null,
    on(ev, fn) {
      listeners[ev] = fn;
      return autoUpdater;
    },
    checkForUpdates: async () => ({ updateInfo: { version: '9.9.9' } }),
    downloadUpdate: async () => {},
    quitAndInstall() {}
  };

  const ipcHandlers = {};
  const electronStub = {
    ipcMain: {
      handle(channel, fn) {
        ipcHandlers[channel] = fn;
      }
    },
    BrowserWindow: {
      getAllWindows: () => []
    },
    app: {
      isPackaged: env.PACKAGED === '1',
      getVersion: () => '1.0.0'
    },
    shell: {
      openExternal: async () => {}
    }
  };

  const electronUpdaterStub = { autoUpdater };

  const origLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub;
    if (request === 'electron-updater') return electronUpdaterStub;
    return origLoad.call(this, request, parent, isMain);
  };

  const updaterPath = require.resolve('../lib/updater');
  delete require.cache[updaterPath];

  let mod;
  try {
    mod = require('../lib/updater');
  } finally {
    Module._load = origLoad;
  }

  function restore() {
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
    delete require.cache[updaterPath];
  }

  return { mod, autoUpdater, ipcHandlers, electronStub, listeners, restore };
}

describe('updater helpers', () => {
  it('detects portable via env', () => {
    const { mod, restore } = loadUpdaterWithStubs({
      PORTABLE_EXECUTABLE_DIR: 'C:\\portable'
    });
    try {
      assert.equal(mod.isPortableBuild(), true);
      assert.equal(mod.canUseElectronUpdater(), false);
    } finally {
      restore();
    }
  });

  it('disables updater when not packaged', () => {
    const { mod, restore } = loadUpdaterWithStubs({ PACKAGED: '0' });
    try {
      assert.equal(mod.isPortableBuild(), false);
      assert.equal(mod.canUseElectronUpdater(), false);
    } finally {
      restore();
    }
  });

  it('init sets autoDownload false', () => {
    const { mod, autoUpdater, ipcHandlers, restore } = loadUpdaterWithStubs({
      PACKAGED: '1'
    });
    try {
      mod.initUpdater({ checkUpdatesOnStartup: false });
      assert.equal(autoUpdater.autoDownload, false);
      assert.equal(autoUpdater.autoInstallOnAppQuit, false);
      assert.equal(typeof ipcHandlers['update:check'], 'function');
      assert.equal(typeof ipcHandlers['update:download'], 'function');
      assert.equal(typeof ipcHandlers['update:install'], 'function');
      assert.equal(typeof ipcHandlers['update:get-status'], 'function');
    } finally {
      restore();
    }
  });

  it('normalizes release notes and keeps release metadata in status', () => {
    const { mod, listeners, ipcHandlers, restore } = loadUpdaterWithStubs({
      PACKAGED: '1'
    });
    try {
      assert.equal(
        mod.githubReleaseUrl('1.2.3'),
        'https://github.com/CyberGems/CyberViewer/releases/tag/v1.2.3'
      );
      assert.equal(
        mod.extractReleaseNotes({
          version: '1.2.3',
          releaseNotes: '<h2>Highlights</h2><ul><li>Faster startup</li></ul>'
        }),
        '### Highlights\n- Faster startup'
      );

      mod.initUpdater({ checkUpdatesOnStartup: false });
      listeners['update-available']({
        version: '1.2.3',
        releaseNotes: '## Highlights\n\n- Faster startup'
      });

      const status = mod.getLastUpdateStatus();
      assert.deepEqual(status, {
        state: 'available',
        version: '1.2.3',
        releaseNotes: '## Highlights\n\n- Faster startup',
        releaseUrl: 'https://github.com/CyberGems/CyberViewer/releases/tag/v1.2.3'
      });
      assert.deepEqual(ipcHandlers['update:get-status'](), status);
    } finally {
      restore();
    }
  });

  it('installs NSIS updates silently and relaunches', async () => {
    const { mod, autoUpdater, ipcHandlers, restore } = loadUpdaterWithStubs({
      PACKAGED: '1'
    });
    try {
      mod.initUpdater({});
      const calls = [];
      autoUpdater.quitAndInstall = (...args) => { calls.push(args); };
      const result = await ipcHandlers['update:install']();
      assert.equal(result.ok, true);
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(calls, [[true, true]]);
    } finally {
      restore();
    }
  });

  it('exports releases URL', () => {
    const { mod, restore } = loadUpdaterWithStubs();
    try {
      assert.match(mod.RELEASES_URL, /github\.com\/CyberGems\/CyberViewer/);
    } finally {
      restore();
    }
  });
});
