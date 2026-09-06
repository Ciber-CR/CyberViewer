<p align="center">
  <a href="https://raw.githubusercontent.com/CyberGems/CyberViewer/main/assets/icon.png?v=original-1024">
    <img src="https://raw.githubusercontent.com/CyberGems/CyberViewer/main/assets/icon.png?v=original-1024" width="128" height="128" alt="CyberViewer logo" />
  </a>
</p>

<h1 align="center">CyberViewer — Fast Windows Image Viewer</h1>

<p align="center">
  <a href="https://github.com/CyberGems/CyberViewer/releases/latest">
    <img src="https://img.shields.io/badge/⚡_Download_Latest_Release-(Windows_64--bit)-0047B3?style=for-the-badge&logo=windows&logoColor=white" alt="Download Latest Release" />
  </a>
  <a href="https://github.com/CyberGems/CyberViewer/releases">
    <img src="https://img.shields.io/badge/All_Releases-Changelog-18181B?style=for-the-badge&logo=github&logoColor=white" alt="All Releases" />
  </a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-GPL--3.0-blue.svg" alt="License" />
  <img src="https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D4.svg?logo=windows&logoColor=white" alt="Platform" />
  <img src="https://img.shields.io/badge/version-1.13.0-00F0FF.svg" alt="Version" />
  <img src="https://img.shields.io/badge/Electron-35-512BD4.svg?logo=electron&logoColor=white" alt="Electron" />
  <a href="https://github.com/CyberGems/CyberViewer/wiki"><img src="https://img.shields.io/badge/%F0%9F%93%96_Wiki-Documentation-222222?style=flat-square&logo=github&logoColor=white" alt="Wiki" /></a>
</p>

A fast, lightweight Windows image viewer by **CyberGems** — open, browse folders, zoom/pan, and perform light edits (rotate, crop, resize, adjust colors). Built with **Electron 35** and **vanilla JavaScript**, it delivers a modern, dark-themed "cyber" UI with neon accents.

*Free and open source (GPLv3) — no ads, no tracking, and no data collection. Just enjoy it.*

---

## 🎯 Why CyberViewer?

Most image viewers are either bloated with features you never use or so barebones they feel like an afterthought. CyberViewer strikes the perfect balance: **instant loading, smooth browsing, and essential editing tools** — all wrapped in a sleek, distraction-free interface.

| Need | Solution |
|---|---|
| Open images instantly | Streaming `cvlocal://` protocol — no full RAM load, even for large files |
| Browse a whole folder | Thumbnail sidebar with lazy loading and radar scan progress |
| Quick edits without Photoshop | Rotate, crop, resize, flip, adjust brightness/contrast/saturation/blur |
| Immersive viewing | Fullscreen mode with auto-hiding UI, slideshow with loop |
| Stay in your workflow | System tray, auto-start, global hotkey, Explorer context menu |
| Bilingual (EN / ES) | Complete UI localization with instant language switching |

---

## ✨ Key Features

### 🖼️ Viewing
- **Lightning-fast open** — custom streaming protocol loads images without hogging RAM
- **Folder browsing** — thumbnail sidebar with lazy loading, priority queue, and scan progress indicator
- **Zoom & pan** — 5% to 2000%, fit-to-window, original size (1:1), mouse wheel + drag
- **Animated GIF support** — toggle playback on/off
- **Fullscreen immersive mode** — ghost UI auto-hides for distraction-free viewing
- **Drag & drop** — drop images or folders directly onto the window
- **Clipboard paste** — paste images from clipboard (`Ctrl+V`)

### ✏️ Editing
- **Rotate** — left 90° (`Q`) / right 90° (`E`) with save/discard workflow
- **Crop** — interactive overlay with handles, optional create-copy mode
- **Resize** — width/height with aspect-lock, presets (720p, 1080p, 25%, 50%, 200%), quality resampling
- **Adjust** — brightness, contrast, saturation, blur, grayscale, invert — with live A/B preview
- **Flip** — horizontal (`H`) / vertical (`Shift+H`)

### 🎬 Slideshow
- Start/pause/stop with dedicated HUD
- Configurable interval (2s, 3s, 5s, 10s)
- Loop mode
- Option to enter fullscreen on start

### 📁 File Operations
- **Save** (overwrite) / **Save As**
- **Copy** image to clipboard (`Ctrl+C`) or copy file path
- **Move to trash** (`Delete`)
- **Show in folder** / open containing folder
- **Export to PDF** and **Print** (page size, orientation, margins)
- **Favorites** — mark and filter favorite images
- **Recent history** — last 8 files/folders

### ⚙️ System Integration
- **System tray** — custom HTML popup menu, minimize/close-to-tray
- **Auto-start with Windows** — launch minimized on boot
- **Global hotkey** — toggle show/hide (default: `Alt+Shift+V`)
- **Explorer context menu** — right-click images to open in CyberViewer
- **File associations** — set as default viewer for JPG, PNG, GIF, WEBP, BMP, TIFF
- **Multiple instances** — optional, for power users
- **Auto-update** — built-in GitHub Releases updater with silent install
- **Settings backup** — export/import configuration as JSON

### 🎨 Customization
- **Accent colors** — Cyan, Pink, Green, Orange
- **Background styles** — Checker-dark, Checker-light, Solid
- **Interface tweaks** — sidebar, statusbar, tooltips, hints, auto-hide delays, double-click behavior
- **Tabbed settings** — General, Appearance, Interface, Slideshow, System

---

## 🛠️ Tech Stack & Architecture

- **Platform:** Windows 10 / 11 (x64)
- **Framework:** Electron 35.5.1 + vanilla JavaScript
- **Security:** `contextIsolation: true`, `nodeIntegration: false`, custom `cvlocal://` protocol with path allowlist, CSP headers
- **UI:** Custom frameless window, DWM-rounded corners, multi-monitor DPI-aware

```
CyberViewer/
├── main.js              Electron main process (IPC, tray, protocol, window management)
├── preload.js           contextBridge → window.electronAPI (secure IPC)
├── tray-preload.js      Tray menu preload
├── CyberViewer.html     Shell markup (all UI modals/menus)
├── tray-menu.html       Custom tray popup
├── css/app.css          Styles
├── js/
│   ├── app.js           Renderer UI logic
│   └── media-helpers.js Pure helpers (mediaUrl, canvasExport, filters)
├── lib/                 Shared Node helpers
│   ├── paths.js         Path normalization, allowlist, MIME types
│   ├── thumb-cache.js   Thumbnail caching/eviction
│   ├── window-bounds.js Window bounds clamping/DPI awareness
│   ├── updater.js       electron-updater integration
│   └── settings-backup.js Import/export settings
├── i18n/
│   ├── menu.json        Menu/tray/dialog strings (EN/ES)
│   ├── ui.json          Renderer UI strings (source of truth)
│   └── ui.js            Generated loader (npm run i18n:sync)
├── assets/              Icons
└── test/                Node unit tests
```

---

## 🚀 Getting Started

### Prerequisites

- **Node.js LTS** → https://nodejs.org
- Windows 10/11 (x64)

### Development

```powershell
cd C:\path\to\CyberViewer
npm install
npm start
```

### Build (Production)

```powershell
npm run build            # NSIS installer + portable
npm run build:portable   # portable only
```

### Outputs (in `dist/`)

| Artifact | Description |
|---|---|
| `CyberViewer-Setup-1.13.0.exe` | NSIS installer |
| `CyberViewer-Portable-1.13.0.exe` | Portable build |

### NSIS Installer Features
- Optional "Set CyberViewer as default image viewer" (checked by default)
- Per-user (HKCU) file associations
- Desktop/Start Menu shortcuts
- Bilingual installer (en_US, es_ES)

---

## ⌨️ Keyboard Shortcuts

| Key | Action |
|---|---|
| `Ctrl+O` | Open image |
| `Ctrl+Shift+O` | Open containing folder |
| `Ctrl+Shift+F` | Open folder |
| `Ctrl+S` | Save As |
| `Ctrl+P` | Print / Export PDF |
| `Ctrl+C` | Copy image to clipboard |
| `Ctrl+V` | Paste image from clipboard |
| `Ctrl+D` | Toggle favorite |
| `Ctrl+,` | Open settings |
| `Ctrl+I` | Properties |
| `← → ↑ ↓` / `A` `D` | Navigate images |
| `Space` | Next image (or play/pause slideshow) |
| `Q` / `E` | Rotate left / right 90° |
| `C` | Crop |
| `R` | Resize |
| `J` | Adjust (color/tone) |
| `H` / `Shift+H` | Flip horizontal / vertical |
| `F` | Fit to window |
| `1` | Original size (1:1) |
| `Enter` / `G` | Toggle fullscreen |
| `S` | Start/pause slideshow |
| `Delete` | Move to trash |
| `+` / `-` | Zoom in / out |
| `0` | Fit to window |
| `Esc` | Close overlays/modals/cancel crop |

---

## 🔒 Security

- `webSecurity` enabled with Content-Security-Policy
- Local images served through `cvlocal://` protocol (streamed) with path allowlist
- Allowlist expansion only accepts **existing image files**
- Folder scans only run for neighbors of an existing image file
- Renderer runs with `nodeIntegration: false` and `contextIsolation: true`
- DevTools IPC disabled in packaged builds

---

## 🔄 Updates

Installed (NSIS) builds use **electron-updater** against GitHub Releases:

1. **About → Check for Updates** (or menu Help)
2. **Download update** when a newer version is available
3. **Install & restart** — silent install, no wizard, auto-relaunch

Download/install is always user-requested. With "Check for updates on startup" enabled (default), the app notifies on startup that an update exists (toast + About banner), but will not download until you ask.

Portable builds cannot self-update in-app — use **Open releases page**.

---

## ❓ Frequently Asked Questions

### What image formats does CyberViewer support?

JPG · JPEG · PNG · GIF · WEBP · BMP · TIFF

### Can I set CyberViewer as my default image viewer?

Yes. The NSIS installer includes an option (checked by default) to register per-user file associations. You can also enable the in-app **Context Menu** option or use Windows Settings → Apps → Default apps.

### Does CyberViewer work on Windows 11?

Yes. CyberViewer supports both Windows 10 and Windows 11 (x64).

### What's the difference between the installer and portable version?

| | Installer | Portable |
|---|---|---|
| File associations | ✅ (optional) | ❌ |
| Auto-update | ✅ (electron-updater)  | ❌ (manual download) |
| Start Menu shortcuts | ✅ | ❌ |
| Requires installation | ✅ | ❌ |

### Can I customize the appearance?

Yes. Go to **Settings → Appearance** to change the accent color (Cyan, Pink, Green, Orange) and background style (Checker-dark, Checker-light, Solid). The **Interface** tab offers additional tweaks for sidebar, statusbar, tooltips, and auto-hide behavior.

### How do I contribute?

Pull requests are welcome! Please ensure your changes pass `npm test` and `npm run lint` before submitting.

---

## ❤️ Donate

**CyberViewer** is one of the gems in [CyberGems](https://github.com/CyberGems#-all-apps--repositories), a personal suite I've spent thousands of hours building and refining for my own use. I've decided to share the whole suite with the world — completely free and open-source.

If you'd like to support this work, a donation would mean a lot. Thank you! 🙏

<p align="center">
  <a href="https://www.paypal.com/donate/?hosted_button_id=M4PY3UPJA5Y6Q"><img src="https://img.shields.io/badge/Donate-PayPal-0070BA?style=for-the-badge&logo=paypal" alt="Donate via PayPal" /></a>
</p>

<p align="center">
  <a href="https://ko-fi.com/cybergems"><img src="https://img.shields.io/badge/Support_me_on_Ko--fi-FF5E5B?style=for-the-badge&logo=ko-fi&logoColor=white" alt="Support me on Ko-fi" /></a>
</p>

<p align="center">
  <a href="https://buymeacoffee.com/cybergems"><img src="https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=for-the-badge&logo=buy-me-a-coffee&logoColor=black" alt="Buy Me a Coffee" /></a>
</p>

<div align="center">

<details>
<summary><b>Crypto donations (BTC, ETH, USDT, LTC) — click to view addresses</b></summary>

| Asset | Address | QR |
|---|---|---|
| **BTC** | <pre><code>bc1q5mxzz05nmvsheqzx7970euswta3fksxzcfzag4</code></pre> | <img src="docs/donate/qr-btc.png" width="90" height="90" alt="BTC QR" /> |
| **ETH** | <pre><code>0x79b703Ec0f77493679Fcd280aF3b983E20c580B8</code></pre> | <img src="docs/donate/qr-eth.png" width="90" height="90" alt="ETH QR" /> |
| **USDT (ERC20 / BEP20)** | <pre><code>0x79b703Ec0f77493679Fcd280aF3b983E20c580B8</code></pre> | <img src="docs/donate/qr-eth.png" width="90" height="90" alt="USDT QR" /> |
| **USDT (TRC20)** | <pre><code>TSVbSk1HSyZ1NprCnAYiw56ECwXgH887mD</code></pre> | <img src="docs/donate/qr-usdt-tron.png" width="90" height="90" alt="USDT TRC20 QR" /> |
| **LTC** | <pre><code>LWGnEHgcFCE2BRkzLnsdPDD8Y8ZeDK577X</code></pre> | <img src="docs/donate/qr-ltc.png" width="90" height="90" alt="LTC QR" /> |

> ⚠️ Send only the selected asset on the indicated network. Using the wrong network will result in permanent loss of funds.

</details>

</div>

---

## 📄 License

CyberViewer is distributed under the terms of the GNU General Public License v3.0. See [LICENSE](./LICENSE) for the full license text.

Copyright (C) 2026 CyberGems

---

<div align="center" style="background:#0D0F17; border:1px solid rgba(0,255,255,0.12); border-radius:12px; padding:28px 20px; margin-top:32px;">

### Thanks for using CyberViewer! 🎉

Made by [**CyberGems**](https://cybergems.org)

</div>
