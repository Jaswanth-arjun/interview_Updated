/**
 * Screen Capture Protection Module
 * 
 * Uses the Windows API SetWindowDisplayAffinity with WDA_EXCLUDEFROMCAPTURE (0x11)
 * to make a window completely invisible during screen sharing, screenshots,
 * and screen recording (Google Meet, Zoom, OBS, etc.)
 * 
 * Requires: Windows 10 version 2004 (Build 19041) or later
 */

const WDA_NONE = 0x00000000;
const WDA_MONITOR = 0x00000001;          // Shows black rectangle in capture
const WDA_EXCLUDEFROMCAPTURE = 0x00000011; // Completely invisible in capture

let SetWindowDisplayAffinity = null;
let isAvailable = false;

// Load the Win32 API via koffi (N-API FFI)
if (process.platform === 'win32') {
  try {
    const koffi = require('koffi');
    const user32 = koffi.load('user32.dll');
    SetWindowDisplayAffinity = user32.func(
      'bool SetWindowDisplayAffinity(int64 hWnd, uint32 dwAffinity)'
    );
    isAvailable = true;
    console.log('✓ Screen capture protection (koffi) loaded');
  } catch (e) {
    console.warn('⚠ koffi not available, will fall back to Electron API:', e.message);
  }
}

/**
 * Read the native HWND from an Electron BrowserWindow
 */
function readHwnd(electronWindow) {
  const buf = electronWindow.getNativeWindowHandle();
  if (buf.length >= 8) {
    // 64-bit Windows: HWND is 8 bytes
    return Number(buf.readBigUInt64LE(0));
  }
  // 32-bit Windows
  return buf.readUInt32LE(0);
}

/**
 * Exclude a window from all screen capture.
 * The window remains visible on the physical display but is invisible in:
 *   - Google Meet / Zoom / Teams screen sharing
 *   - OBS / screen recorders
 *   - Screenshots (Win+Shift+S, PrintScreen)
 *
 * @param {BrowserWindow} electronWindow
 * @returns {boolean} true if native API succeeded
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

    // WDA_EXCLUDEFROMCAPTURE failed (older Windows?), try WDA_MONITOR as fallback
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

module.exports = { excludeFromCapture, removeProtection };
