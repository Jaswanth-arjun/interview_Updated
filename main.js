const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Tray,
  Menu,
  screen,
  session,
  dialog,
  nativeImage,
  desktopCapturer,
  shell
} = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { excludeFromCapture, removeProtection } = require('./screen-protect');

const BACKEND_URL = app.isPackaged
  ? 'https://interview-updated.onrender.com'
  : 'http://localhost:4000';
const sessionPath = path.join(app.getPath('userData'), 'session-auth.json');

// ─── State ───────────────────────────────────────────────────────
let setupWindow = null;
let overlayWindow = null;
let tray = null;
let isOverlayVisible = false;

// Session structure: { accessToken: '', refreshToken: '', user: null, isDemo: false }
let sessionData = {
  accessToken: '',
  refreshToken: '',
  user: null,
  isDemo: false
};

// ─── Session Management ──────────────────────────────────────────
function loadSession() {
  try {
    if (fs.existsSync(sessionPath)) {
      sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
      console.log('✓ Session loaded from storage');
    }
  } catch (e) {
    console.error('Failed to load session:', e);
  }
}

function saveSession(data) {
  if (data) {
    sessionData = {
      accessToken: data.accessToken || '',
      refreshToken: data.refreshToken || '',
      user: data.user || null,
      isDemo: false
    };
  }
  try {
    fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2));
  } catch (e) {
    console.error('Failed to save session:', e);
  }
}

function clearSession() {
  sessionData = {
    accessToken: '',
    refreshToken: '',
    user: null,
    isDemo: false
  };
  try {
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
    }
  } catch (e) {}
}

// ─── Machine Fingerprinting (Multi-Signal) ───────────────────────
function getDeviceSignals() {
  const signals = {
    biosUuid: '',
    cpuId: '',
    diskSerial: '',
    machineGuid: '',
    platform: process.platform
  };

  if (process.platform === 'win32') {
    try {
      signals.biosUuid = execSync('powershell -Command "(Get-CimInstance Win32_ComputerSystemProduct).UUID"').toString().trim();
    } catch {
      try { signals.biosUuid = execSync('wmic csproduct get uuid').toString().replace('UUID', '').trim(); } catch {}
    }
    try {
      signals.cpuId = execSync('powershell -Command "(Get-CimInstance Win32_Processor).ProcessorId"').toString().trim();
    } catch {
      try { signals.cpuId = execSync('wmic cpu get processorid').toString().replace('ProcessorId', '').trim(); } catch {}
    }
    try {
      // Fetch physical media disk serial
      signals.diskSerial = execSync('powershell -Command "(Get-CimInstance Win32_PhysicalMedia)[0].SerialNumber"').toString().trim();
    } catch {
      try { 
        const raw = execSync('wmic diskdrive get serialnumber').toString();
        signals.diskSerial = raw.replace('SerialNumber', '').trim().split(/\r?\n/)[0] || '';
      } catch {}
    }
    try {
      signals.machineGuid = execSync('powershell -Command "(Get-ItemProperty -Path HKLM:\\SOFTWARE\\Microsoft\\Cryptography).MachineGuid"').toString().trim();
    } catch {}
  } else if (process.platform === 'darwin') {
    try {
      signals.biosUuid = execSync("ioreg -rd1 -c IOPlatformExpertDevice | awk '/IOPlatformUUID/ { print $4 }'").toString().replace(/"/g, '').trim();
    } catch {}
  } else {
    try {
      signals.biosUuid = execSync('cat /var/lib/dbus/machine-id').toString().trim();
    } catch {}
  }

  // Fallback to random GUID stored in user folder if completely blocked
  if (!signals.biosUuid && !signals.cpuId && !signals.diskSerial) {
    const fallbackFile = path.join(app.getPath('userData'), '.device-guid');
    if (fs.existsSync(fallbackFile)) {
      signals.biosUuid = fs.readFileSync(fallbackFile, 'utf8');
    } else {
      const generated = crypto.randomUUID();
      fs.writeFileSync(fallbackFile, generated, 'utf8');
      signals.biosUuid = generated;
    }
  }

  return signals;
}

function getDeviceFingerprint() {
  const s = getDeviceSignals();
  const parts = [s.biosUuid, s.cpuId, s.diskSerial, s.machineGuid, s.platform]
    .filter(Boolean)
    .map(p => p.trim().toLowerCase());
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// ─── API Fetch (Automatic Refresh Handling) ──────────────────────
async function apiFetch(endpoint, options = {}) {
  const url = `${BACKEND_URL}${endpoint}`;
  options.headers = options.headers || {};
  
  if (sessionData.accessToken && !sessionData.isDemo) {
    options.headers['Authorization'] = `Bearer ${sessionData.accessToken}`;
  } else if (sessionData.isDemo) {
    options.headers['Authorization'] = 'Bearer demo';
  }

  try {
    let response = await fetch(url, options);
    
    // Auto token refresh on 401 Unauthorized
    if (response.status === 401 && sessionData.refreshToken && !sessionData.isDemo) {
      console.log('Access token expired, attempting refresh...');
      const refreshResponse = await fetch(`${BACKEND_URL}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: sessionData.refreshToken })
      });

      if (refreshResponse.ok) {
        const refreshData = await refreshResponse.json();
        if (refreshData.success) {
          sessionData.accessToken = refreshData.accessToken;
          sessionData.refreshToken = refreshData.refreshToken;
          saveSession();
          
          // Retry the request with the new access token
          options.headers['Authorization'] = `Bearer ${sessionData.accessToken}`;
          response = await fetch(url, options);
        } else {
          clearSession();
        }
      } else {
        clearSession();
      }
    }

    return response;
  } catch (err) {
    console.error(`apiFetch failed for ${endpoint}:`, err);
    throw err;
  }
}

// ─── Windows ─────────────────────────────────────────────────────
function createSetupWindow() {
  setupWindow = new BrowserWindow({
    width: 1050,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    frame: false,
    backgroundColor: '#08081a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  setupWindow.loadFile(path.join(__dirname, 'src/setup/setup.html'));
  setupWindow.once('ready-to-show', () => setupWindow.show());
  setupWindow.on('closed', () => { setupWindow = null; });
}

/**
 * Check if the current user is eligible for screen capture protection.
 * Only premium (pro tier) and admin users get this feature.
 */
function isUserPremiumOrAdmin() {
  if (sessionData.isDemo) return false;
  if (!sessionData.user) return false;
  const tier = (sessionData.user.tier || '').toLowerCase();
  const isAdmin = sessionData.user.isAdmin === true;
  return isAdmin || tier === 'pro';
}

function createOverlayWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;

  overlayWindow = new BrowserWindow({
    width: 480,
    height: 620,
    x: width - 510,
    y: 40,
    frame: false,
    transparent: false,
    backgroundColor: '#08081a',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });

  overlayWindow.loadFile(path.join(__dirname, 'src/overlay/overlay.html'));
  overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Apply screen capture protection ONLY for premium/admin users
  overlayWindow.once('ready-to-show', () => {
    applyOverlayProtection();
  });
}

/**
 * Apply or remove screen capture protection based on user tier.
 * Premium (pro) & Admin → overlay hidden from screen capture
 * Demo & Free → overlay visible in screen capture (no protection)
 */
function applyOverlayProtection() {
  if (!overlayWindow) return;
  if (isUserPremiumOrAdmin()) {
    excludeFromCapture(overlayWindow);
    console.log('✓ Screen capture protection ON (premium/admin user)');
  } else {
    removeProtection(overlayWindow);
    console.log('⚠ Screen capture protection OFF (demo/free user)');
  }
}

function toggleOverlay() {
  if (!overlayWindow) return;
  if (isOverlayVisible) {
    overlayWindow.hide();
  } else {
    overlayWindow.show();
    // Re-apply capture protection based on user tier every time window is shown
    applyOverlayProtection();
  }
  isOverlayVisible = !isOverlayVisible;
}

// ─── Tray ────────────────────────────────────────────────────────
function createTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const ratio = (x + y) / (size * 2);
      buf[i]     = Math.round(99  + ratio * (6   - 99));  // R
      buf[i + 1] = Math.round(102 + ratio * (182 - 102)); // G
      buf[i + 2] = Math.round(241 + ratio * (212 - 241)); // B
      buf[i + 3] = 255;                                   // A
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function createTray() {
  try {
    const trayIcon = createTrayIcon();
    tray = new Tray(trayIcon);
  } catch (e) {
    console.error('Failed to create tray icon:', e);
    return;
  }

  tray.setToolTip('Interview Practice Assistant');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: 'Open Setup',
        click: () => {
          if (setupWindow) setupWindow.show();
          else createSetupWindow();
        },
      },
      {
        label: 'Toggle Overlay  (Ctrl+Shift+A)',
        click: toggleOverlay,
      },
      { type: 'separator' },
      { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
    ])
  );
  tray.on('double-click', () => {
    if (setupWindow) setupWindow.show();
    else createSetupWindow();
  });
}

// ─── Google OAuth 2.0 Loopback Listener ─────────────────────────
let oauthServer = null;
function startOauthListener(resolve) {
  if (oauthServer) {
    try { oauthServer.close(); } catch {}
  }

  oauthServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost:52981');
    if (url.pathname === '/oauth-callback') {
      const code = url.searchParams.get('code');
      if (!code) {
        res.end('Authentication code missing');
        resolve({ success: false, error: 'Authentication code missing' });
        return;
      }

      try {
        const signals = getDeviceSignals();
        const fprint = getDeviceFingerprint();

        const response = await fetch(`${BACKEND_URL}/auth/google/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            deviceFingerprint: fprint,
            ...signals
          })
        });

        const data = await response.json();
        if (data.success) {
          saveSession(data);
          res.end(`
            <html>
              <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background: #08081a; color: #fff;">
                <h2 style="color: #4ade80;">Login Successful!</h2>
                <p>You can now close this browser tab and return to the application.</p>
              </body>
            </html>
          `);
          resolve({ success: true, user: data.user });
        } else {
          res.end(`
            <html>
              <body style="font-family: sans-serif; text-align: center; padding-top: 50px; background: #08081a; color: #fff;">
                <h2 style="color: #ef4444;">Login Failed</h2>
                <p>Error: ${data.error || 'Unknown error'}</p>
              </body>
            </html>
          `);
          resolve({ success: false, error: data.error });
        }
      } catch (err) {
        res.end('Authentication failed during callback request');
        resolve({ success: false, error: err.message });
      }
    } else {
      res.end('Not found');
    }
  });

  oauthServer.listen(52981, '127.0.0.1', () => {
    console.log('Google Auth loopback server listening on port 52981');
  });

  // 3-minute handshake timeout
  setTimeout(() => {
    if (oauthServer) {
      try { oauthServer.close(); } catch {}
      oauthServer = null;
    }
  }, 180000);
}

// ─── IPC Handlers ────────────────────────────────────────────────
function registerIPC() {
  ipcMain.handle('get-machine-id', async () => {
    return getDeviceFingerprint();
  });

  ipcMain.handle('get-user-profile', async () => {
    if (sessionData.isDemo) {
      return { success: true, email: 'Demo Mode', tier: 'demo', limit: 'Unlimited' };
    }
    if (!sessionData.accessToken) {
      return { success: false, error: 'No active session' };
    }
    try {
      const response = await apiFetch('/auth/profile');
      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          sessionData.user = data.user;
          return {
            success: true,
            email: data.user.email,
            name: data.user.name,
            avatarUrl: data.user.avatarUrl,
            tier: data.user.tier,
            freeTrialRequests: data.user.freeTrialRequests,
            freeTrialUsed: data.user.freeTrialUsed,
            walletBalancePaise: data.user.walletBalancePaise,
            isAdmin: data.user.isAdmin
          };
        }
      }
      return { success: false, error: 'Session invalid' };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('login-user', async () => {
    return { success: false, error: 'Password log-in is disabled. Please use Continue with Google.' };
  });

  ipcMain.handle('register-user', async () => {
    return { success: false, error: 'Standard registration is disabled. Please use Continue with Google.' };
  });

  ipcMain.handle('logout-user', async () => {
    try {
      if (!sessionData.isDemo && sessionData.accessToken) {
        await apiFetch('/auth/logout', { method: 'POST' });
      }
    } catch {}
    clearSession();
    return { success: true };
  });

  ipcMain.handle('enter-demo-mode', async () => {
    sessionData = {
      accessToken: '',
      refreshToken: '',
      user: { email: 'Demo Mode', name: 'Demo Candidate', tier: 'demo' },
      isDemo: true
    };
    saveSession();
    return { success: true };
  });

  ipcMain.handle('login-with-google', async () => {
    return new Promise(async (resolve) => {
      let resolved = false;

      const safeResolve = (val) => {
        if (!resolved) {
          resolved = true;
          resolve(val);
          
          setTimeout(() => {
            if (oauthServer) {
              try { oauthServer.close(); } catch {}
              oauthServer = null;
            }
          }, 1200);
        }
      };

      try {
        startOauthListener(safeResolve);
        const response = await fetch(`${BACKEND_URL}/auth/google/url`);
        const data = await response.json();
        if (data.success && data.url) {
          // Open the system browser to handle Google OAuth securely
          shell.openExternal(data.url);
        } else {
          safeResolve({ success: false, error: 'Failed to retrieve auth URL' });
        }
      } catch (err) {
        safeResolve({ success: false, error: err.message });
      }
    });
  });

  // Profile data
  ipcMain.handle('save-setup-data', async (_e, data) => {
    if (sessionData.isDemo) return { success: true };
    try {
      const response = await apiFetch('/profile/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      return await response.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-setup-data', async () => {
    if (sessionData.isDemo) return {};
    try {
      const response = await apiFetch('/profile/setup');
      if (response.ok) {
        const data = await response.json();
        return data.profile || {};
      }
      return {};
    } catch {
      return {};
    }
  });

  // Razorpay Payments
  ipcMain.handle('get-recharge-tiers', async () => {
    try {
      const response = await apiFetch('/wallet/tiers');
      return await response.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('create-razorpay-order', async (_e, amountPaise) => {
    try {
      const response = await apiFetch('/wallet/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amountPaise })
      });
      return await response.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('verify-razorpay-payment', async (_e, paymentDetails) => {
    try {
      const response = await apiFetch('/wallet/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(paymentDetails)
      });
      return await response.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('get-payment-history', async () => {
    try {
      const response = await apiFetch('/wallet/history');
      return await response.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // Admin Portal Dashboard
  ipcMain.handle('get-admin-dashboard', async () => {
    try {
      const response = await apiFetch('/admin/dashboard');
      return await response.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('admin-get-users', async (_e, { query, page }) => {
    try {
      const response = await apiFetch(`/admin/users?query=${encodeURIComponent(query || '')}&page=${page || 1}`);
      return await response.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('admin-reset-device', async (_e, userId) => {
    try {
      const response = await apiFetch('/admin/users/reset-device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      });
      return await response.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('admin-block-user', async (_e, { userId, block }) => {
    try {
      const response = await apiFetch('/admin/users/block', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, block })
      });
      return await response.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('admin-manual-credit', async (_e, { userId, amountPaise, reason }) => {
    try {
      const response = await apiFetch('/admin/users/manual-credit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, amountPaise, reason })
      });
      return await response.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('admin-refund-payment', async (_e, paymentId) => {
    try {
      const response = await apiFetch('/admin/users/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentId })
      });
      return await response.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // AI Pipeline Execution
  ipcMain.handle('transcribe-audio', async (_e, base64Audio, mimeType) => {
    try {
      const response = await apiFetch('/ai/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64Audio, mimeType })
      });

      return await response.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('generate-answer', async (e, question) => {
    const webContents = e.sender;
    try {
      const response = await apiFetch('/ai/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question })
      });

      if (!response.ok) {
        const errorData = await response.json();
        return { success: false, error: errorData.error || 'AI request failed' };
      }

      // Stream SSE response chunks from backend to Electron renderer
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullAnswerText = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          const cleanLine = line.trim();
          if (cleanLine.startsWith('data: ')) {
            try {
              const parsed = JSON.parse(cleanLine.slice(6));
              if (parsed.chunk) {
                fullAnswerText += parsed.chunk;
                webContents.send('answer-chunk', parsed.chunk);
              } else if (parsed.done) {
                // Completed successfully
              } else if (parsed.error) {
                return { success: false, error: parsed.error };
              }
            } catch (err) {}
          }
        }
      }

      return { success: true, answer: fullAnswerText };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // File system & window controls
  ipcMain.handle('open-file-dialog', async () => {
    const result = await dialog.showOpenDialog(setupWindow, {
      properties: ['openFile'],
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });
    if (result.canceled) return { success: false };
    return { success: true, filePath: result.filePaths[0] };
  });

  ipcMain.handle('parse-pdf', async (_e, filePath) => {
    try {
      const pdfParse = require('pdf-parse');
      const buffer = fs.readFileSync(filePath);
      const data = await pdfParse(buffer);
      return { success: true, text: data.text };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  ipcMain.handle('start-practice', async () => {
    if (setupWindow) setupWindow.hide();
    if (!overlayWindow) createOverlayWindow();
    return { success: true };
  });

  ipcMain.handle('hide-overlay', async () => {
    if (overlayWindow) { overlayWindow.hide(); isOverlayVisible = false; }
  });

  ipcMain.handle('show-setup', async () => {
    if (setupWindow) setupWindow.show();
    else createSetupWindow();
  });

  ipcMain.handle('minimize-window', async (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize();
  });

  ipcMain.handle('close-window', async (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close();
  });
}

// ─── App Lifecycle ───────────────────────────────────────────────
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch((err) => {
      console.error('Desktop capturer error:', err);
      callback(null);
    });
  });

  loadSession();
  registerIPC();
  createSetupWindow();
  createTray();

  globalShortcut.register('CommandOrControl+Shift+A', toggleOverlay);
});

app.on('will-quit', () => globalShortcut.unregisterAll());

app.on('window-all-closed', () => {
  // Remain in tray
});
