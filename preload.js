const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Setup data
  saveSetupData: (data) => ipcRenderer.invoke('save-setup-data', data),
  getSetupData: () => ipcRenderer.invoke('get-setup-data'),

  // PDF parsing
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  parsePDF: (filePath) => ipcRenderer.invoke('parse-pdf', filePath),

  // AI & Audio
  generateAnswer: (question) => ipcRenderer.invoke('generate-answer', question),
  onAnswerChunk: (callback) => ipcRenderer.on('answer-chunk', (event, chunk) => callback(chunk)),
  transcribeAudio: (base64Audio, mimeType) => ipcRenderer.invoke('transcribe-audio', base64Audio, mimeType),

  // Auth, Machine ID & Credits
  getMachineId: () => ipcRenderer.invoke('get-machine-id'),
  getUserProfile: () => ipcRenderer.invoke('get-user-profile'),
  loginUser: (email, password) => ipcRenderer.invoke('login-user', { email, password }),
  registerUser: (email, password) => ipcRenderer.invoke('register-user', { email, password }),
  logoutUser: () => ipcRenderer.invoke('logout-user'),
  topUpCredits: () => ipcRenderer.invoke('top-up-credits'),
  enterDemoMode: () => ipcRenderer.invoke('enter-demo-mode'),
  loginWithGoogle: () => ipcRenderer.invoke('login-with-google'),

  // Razorpay Payments
  getRechargeTiers: () => ipcRenderer.invoke('get-recharge-tiers'),
  createRazorpayOrder: (amountPaise) => ipcRenderer.invoke('create-razorpay-order', amountPaise),
  verifyRazorpayPayment: (paymentDetails) => ipcRenderer.invoke('verify-razorpay-payment', paymentDetails),
  getPaymentHistory: () => ipcRenderer.invoke('get-payment-history'),

  // Admin Dashboard Services
  getAdminDashboard: () => ipcRenderer.invoke('get-admin-dashboard'),
  adminGetUsers: (query, page) => ipcRenderer.invoke('admin-get-users', { query, page }),
  adminResetDevice: (userId) => ipcRenderer.invoke('admin-reset-device', userId),
  adminBlockUser: (userId, block) => ipcRenderer.invoke('admin-block-user', { userId, block }),
  adminManualCredit: (userId, amountPaise, reason) => ipcRenderer.invoke('admin-manual-credit', { userId, amountPaise, reason }),
  adminRefundPayment: (paymentId) => ipcRenderer.invoke('admin-refund-payment', paymentId),

  // Window controls
  startPractice: () => ipcRenderer.invoke('start-practice'),
  hideOverlay: () => ipcRenderer.invoke('hide-overlay'),
  showSetup: () => ipcRenderer.invoke('show-setup'),
  minimizeWindow: () => ipcRenderer.invoke('minimize-window'),
  closeWindow: () => ipcRenderer.invoke('close-window'),
});
