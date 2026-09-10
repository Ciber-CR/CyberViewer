'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),
  setFullScreen: (flag) => ipcRenderer.invoke('win-set-fullscreen', !!flag),
  isFullScreen: () => ipcRenderer.invoke('win-is-fullscreen'),
  onWinState: (cb) => ipcRenderer.on('win-state', (_, state) => cb(state)),
  onFullscreenChanged: (cb) => {
    const handler = (_, isFs) => cb(!!isFs);
    ipcRenderer.on('fullscreen-changed', handler);
    return () => ipcRenderer.removeListener('fullscreen-changed', handler);
  },

  getSettings: () => ipcRenderer.invoke('get-settings'),
  getVersion: () => ipcRenderer.invoke('get-version'),
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
  exportSettingsBackup: (settings) => ipcRenderer.invoke('settings:export-backup', settings),
  importSettingsBackup: () => ipcRenderer.invoke('settings:import-backup'),

  showContextMenu: (props) => ipcRenderer.send('show-context-menu', props),
  openDevTools: () => ipcRenderer.send('win-devtools'),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (e, path) => cb(path)),
  onWindowBlur: (cb) => ipcRenderer.on('window-blur', () => cb()),
  scanFolder: (path) => ipcRenderer.invoke('scan-folder', path),
  getThumbnail: (path, opts) => ipcRenderer.invoke('get-thumbnail', path, opts || {}),
  toMediaUrl: (path) => ipcRenderer.invoke('to-media-url', path),
  registerPaths: (paths) => ipcRenderer.invoke('register-paths', paths),
  getDefaultSaveDir: () => ipcRenderer.invoke('get-default-save-dir'),
  onMenuAction: (cb) => ipcRenderer.on('menu-action', (e, data) => cb(data)),
  getMonitors: () => ipcRenderer.invoke('get-monitors'),
  openFile: () => ipcRenderer.invoke('open-file-dialog'),
  openFolder: () => ipcRenderer.invoke('open-folder-dialog'),
  openFolderPath: (dirPath) => ipcRenderer.invoke('open-folder-path', dirPath),
  saveImage: (data) => ipcRenderer.invoke('save-image', data),
  exportImageToPdf: (data) => ipcRenderer.invoke('export-image-pdf', data),
  printImage: (data) => ipcRenderer.invoke('print-image', data),
  copyImage: (path) => ipcRenderer.send('copy-image', path),
  copyImageBuffer: (base64) => ipcRenderer.send('copy-image-buffer', base64),
  readClipboardImage: () => ipcRenderer.invoke('clipboard:read-image'),
  moveToTrash: (path) => ipcRenderer.invoke('move-to-trash', path),
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', () => cb()),
  showItemInFolder: (path) => ipcRenderer.send('show-item-in-folder', path),
  openContainingFolder: (path) => ipcRenderer.invoke('open-containing-folder', path),
  openNativeProperties: (path) => ipcRenderer.send('open-native-properties', path),
  getFileInfo: (path) => ipcRenderer.invoke('get-file-info', path),
  validatePaths: (paths) => ipcRenderer.invoke('validate-paths', paths),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  registerContextMenu: (enable, lang) => ipcRenderer.invoke('register-context-menu', enable, lang),
  uiReady: () => ipcRenderer.send('ui-ready'),

  // Updates (electron-updater) — download/install always user-requested
  getUpdateInfo: () => ipcRenderer.invoke('update:get-info'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openReleasesPage: () => ipcRenderer.invoke('update:open-releases'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getUpdateStatus: () => ipcRenderer.invoke('update:get-status'),
  onUpdateStatus: (cb) => {
    const handler = (_, status) => cb(status);
    ipcRenderer.on('update:status', handler);
    return () => ipcRenderer.removeListener('update:status', handler);
  },
  checkUpdates: () => ipcRenderer.invoke('update:check')
});

window.addEventListener('contextmenu', (e) => {
  if (e.target.closest('input, textarea, [contenteditable="true"]')) {
    const props = {
      isEditable: true,
      selectionText: window.getSelection().toString()
    };
    ipcRenderer.send('show-context-menu', props);
  }
});
