/**
 * Screen Capture Protection & Stealth Module
 * 
 * Features:
 * 1. WDA_EXCLUDEFROMCAPTURE — Window invisible in screen sharing / screenshots
 * 2. WS_EX_TOOLWINDOW       — Window hidden from Alt+Tab app switcher
 * 
 * Both use direct Win32 API calls via koffi (N-API FFI).
 * Requires: Windows 10 version 2004 (Build 19041) or later
 */

// ─── Constants ───────────────────────────────────────────────────
const WDA_NONE = 0x00000000;
const WDA_MONITOR = 0x00000001;            // Shows black rectangle in capture
const WDA_EXCLUDEFROMCAPTURE = 0x00000011;  // Completely invisible in capture

const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080;       // Hides from Alt+Tab
const WS_EX_APPWINDOW  = 0x00040000;       // Shows in Alt+Tab / taskbar

// ─── Win32 API Bindings ──────────────────────────────────────────
let SetWindowDisplayAffinity = null;
let GetWindowLongPtrW = null;
let SetWindowLongPtrW = null;
let isAvailable = false;

if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');

    SetWindowDisplayAffinity = user32.func(
      'bool SetWindowDisplayAffinity(int64 hWnd, uint32 dwAffinity)'
    );
    GetWindowLongPtrW = user32.func(
      'int64 GetWindowLongPtrW(int64 hWnd, int nIndex)'
    );
    SetWindowLongPtrW = user32.func(
      'int64 SetWindowLongPtrW(int64 hWnd, int nIndex, int64 dwNewLong)'
    );

    isAvailable = true;
    console.log('✓ Screen protection & stealth (koffi) loaded');
  } catch (e) {
    console.warn('⚠ koffi not available, will fall back to Electron API:', e.message);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────
/**
 * Read the native HWND from an Electron BrowserWindow
 */
function readHwnd(electronWindow) {
  const buf = electronWindow.getNativeWindowHandle();
  if (buf.length >= 8) {
    return Number(buf.readBigUInt64LE(0));
  }
  return buf.readUInt32LE(0);
}

// ─── Screen Capture Protection ───────────────────────────────────
/**
 * Exclude a window from all screen capture.
 * The window remains visible on the physical display but is invisible in:
 *   - Google Meet / Zoom / Teams screen sharing
 *   - OBS / screen recorders
 *   - Screenshots (Win+Shift+S, PrintScreen)
 */
function excludeFromCapture(electronWindow) {
  if (process.platform !== 'win32') {
    electronWindow.setContentProtection(true);
    return true;
  }

  if (!isAvailable || !SetWindowDisplayAffinity) {
    console.warn('Native API unavailable, using Electron fallback');
    electronWindow.setContentProtection(true);
    return false;
  }

  try {
    const hwnd = readHwnd(electronWindow);
    const result = SetWindowDisplayAffinity(hwnd, WDA_EXCLUDEFROMCAPTURE);

    if (result) {
      console.log(`✓ WDA_EXCLUDEFROMCAPTURE applied (HWND: ${hwnd})`);
      return true;
    }

    console.warn('WDA_EXCLUDEFROMCAPTURE failed, trying WDA_MONITOR fallback');
    const fallbackResult = SetWindowDisplayAffinity(hwnd, WDA_MONITOR);
    if (fallbackResult) {
      console.log('✓ WDA_MONITOR fallback applied (shows black in capture)');
    } else {
      console.error('✗ Both WDA methods failed');
      electronWindow.setContentProtection(true);
    }
    return fallbackResult;
  } catch (e) {
    console.error('Screen protection error:', e);
    electronWindow.setContentProtection(true);
    return false;
  }
}

/**
 * Remove capture protection (make window visible in screen capture again)
 */
function removeProtection(electronWindow) {
  if (process.platform !== 'win32' || !isAvailable) {
    electronWindow.setContentProtection(false);
    return;
  }
  try {
    const hwnd = readHwnd(electronWindow);
    SetWindowDisplayAffinity(hwnd, WDA_NONE);
    console.log('✓ Screen capture protection removed');
  } catch (e) {
    electronWindow.setContentProtection(false);
  }
}

// ─── Alt+Tab Stealth ─────────────────────────────────────────────
/**
 * Hide a window from Alt+Tab app switcher.
 * Sets WS_EX_TOOLWINDOW and removes WS_EX_APPWINDOW extended styles.
 * The window remains fully functional and visible on screen.
 */
function hideFromAltTab(electronWindow) {
  if (process.platform !== 'win32' || !isAvailable) return false;

  try {
    const hwnd = readHwnd(electronWindow);
    let exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    exStyle = (exStyle | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW;
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle);
    console.log(`✓ Window hidden from Alt+Tab (HWND: ${hwnd})`);
    return true;
  } catch (e) {
    console.error('hideFromAltTab error:', e);
    return false;
  }
}

/**
 * Restore a window to Alt+Tab visibility.
 */
function restoreToAltTab(electronWindow) {
  if (process.platform !== 'win32' || !isAvailable) return false;

  try {
    const hwnd = readHwnd(electronWindow);
    let exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    exStyle = (exStyle | WS_EX_APPWINDOW) & ~WS_EX_TOOLWINDOW;
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle);
    console.log(`✓ Window restored to Alt+Tab (HWND: ${hwnd})`);
    return true;
  } catch (e) {
    console.error('restoreToAltTab error:', e);
    return false;
  }
}

/**
 * Apply full stealth mode to a window:
 *   1. Exclude from screen capture
 *   2. Hide from Alt+Tab
 *   3. Already hidden from taskbar (skipTaskbar: true in Electron)
 * Result: Window is invisible in Task Manager "Apps" tab, Alt+Tab,
 * screen sharing, and screenshots — but fully visible on physical display.
 */
function applyFullStealth(electronWindow) {
  const captureResult = excludeFromCapture(electronWindow);
  const altTabResult = hideFromAltTab(electronWindow);
  if (captureResult && altTabResult) {
    console.log('✓ Full stealth mode activated');
  }
  return captureResult && altTabResult;
}

/**
 * Remove all stealth from a window.
 */
function removeFullStealth(electronWindow) {
  removeProtection(electronWindow);
  restoreToAltTab(electronWindow);
  console.log('✓ Stealth mode deactivated');
}

module.exports = {
  excludeFromCapture,
  removeProtection,
  hideFromAltTab,
  restoreToAltTab,
  applyFullStealth,
  removeFullStealth
};
