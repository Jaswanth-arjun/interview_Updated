// ─── DOM References ──────────────────────────────────────────
const $ = (sel) => document.querySelector(sel);
const uploadZone  = $('#uploadZone');
const uploadStatus = $('#uploadStatus');
const resumeText  = $('#resumeText');
const companyName = $('#companyName');
const roleName    = $('#roleName');
const jobDesc     = $('#jobDescription');
const projects    = $('#projects');
const extraNotes  = $('#extraNotes');
const toast       = $('#toast');

// Auth View DOM Elements
const authView = $('#authView');
const dashboardView = $('#dashboardView');
const demoBtn = $('#demoBtn');
const systemFingerprint = $('#systemFingerprint');
const googleAuthBtn = $('#googleAuthBtn');

// Dashboard View DOM Elements
const dbEmail = $('#dbEmail');
const dbTier = $('#dbTier');
const dbFreeMinutes = $('#dbFreeMinutes');
const dbBalance = $('#dbBalance');
const logoutBtn = $('#logoutBtn');

// Tab Navigation Elements
const navTabButtons = document.querySelectorAll('.nav-tab-btn');
const tabPanes = document.querySelectorAll('.tab-pane');
const navAdminBtn = $('#navAdminBtn');

// Wallet & Recharge Elements
const walletDisplayBalance = $('#walletDisplayBalance');
const pricingGrid = $('#pricingGrid');
const paymentHistoryBody = $('#paymentHistoryBody');

// Admin Portal Elements
const adminStatUsers = $('#adminStatUsers');
const adminStatBlocked = $('#adminStatBlocked');
const adminStatRevenue = $('#adminStatRevenue');
const adminStatRequests = $('#adminStatRequests');
const adminSearchInput = $('#adminSearchInput');
const adminSearchBtn = $('#adminSearchBtn');
const adminUsersBody = $('#adminUsersBody');

// ─── Toast helper ────────────────────────────────────────────
function showToast(msg, type = 'success') {
  toast.textContent = msg;
  toast.className = 'toast show ' + type;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.className = 'toast', 3000);
}

// ─── Navigation Tabs Logic ────────────────────────────────────
navTabButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    const targetTab = btn.getAttribute('data-tab');
    
    // Deactivate all tabs
    navTabButtons.forEach(b => b.classList.remove('active'));
    tabPanes.forEach(pane => pane.classList.remove('active'));
    
    // Activate target
    btn.classList.add('active');
    $(`#${targetTab}`).classList.add('active');

    // Trigger tab-specific loads
    if (targetTab === 'tabWallet') {
      await loadRechargeOptions();
      await loadPaymentHistory();
    } else if (targetTab === 'tabAdmin') {
      await loadAdminDashboard();
    }
  });
});

// ─── Session status management ──────────────────────────────
async function updateSessionStatus() {
  try {
    const profile = await window.api.getUserProfile();
    if (profile && profile.success) {
      authView.style.display = 'none';
      dashboardView.style.display = 'block';
      
      dbEmail.textContent = profile.email;
      dbTier.textContent = profile.tier.toUpperCase();
      dbTier.className = 'badge ' + profile.tier;

      // Handle isAdmin visibility
      if (profile.isAdmin) {
        navAdminBtn.style.display = 'flex';
      } else {
        navAdminBtn.style.display = 'none';
      }

      if (profile.tier === 'demo') {
        dbFreeMinutes.textContent = 'Unlimited (slow AI)';
        dbBalance.textContent = 'N/A';
        walletDisplayBalance.textContent = 'N/A (Demo)';
      } else {
        // Metred limits
        const trialRemaining = Math.max(0, profile.freeTrialRequests - profile.freeTrialUsed);
        dbFreeMinutes.textContent = `${trialRemaining} Left`;
        
        const balanceINR = '₹' + (profile.walletBalancePaise / 100).toFixed(2);
        dbBalance.textContent = balanceINR;
        walletDisplayBalance.textContent = balanceINR;
      }
    } else {
      authView.style.display = 'flex';
      dashboardView.style.display = 'none';
      const machineId = await window.api.getMachineId();
      systemFingerprint.textContent = machineId.substring(0, 16) + '...';
    }
  } catch (e) {
    console.error('Failed to get user profile', e);
    authView.style.display = 'flex';
    dashboardView.style.display = 'none';
  }
}

// ─── Welcome Auth Buttons ─────────────────────────────────────
demoBtn.addEventListener('click', async () => {
  try {
    const res = await window.api.enterDemoMode();
    if (res.success) {
      showToast('Entered Demo Mode! Unlimited slow-speed queries.');
      await updateSessionStatus();
    } else {
      showToast(res.error, 'error');
    }
  } catch (err) {
    showToast('Failed to enter Demo Mode', 'error');
  }
});

googleAuthBtn.addEventListener('click', async () => {
  try {
    showToast('Redirecting to Google Sign-In in your browser...', 'info');
    const res = await window.api.loginWithGoogle();
    if (res.success) {
      showToast('Signed in with Google successfully!');
      await updateSessionStatus();
    } else {
      showToast(res.error || 'Google sign-in cancelled', 'error');
    }
  } catch (err) {
    showToast('Google Sign-In failed', 'error');
  }
});

logoutBtn.addEventListener('click', async () => {
  await window.api.logoutUser();
  showToast('Logged out successfully');
  await updateSessionStatus();
  
  // Switch back to Profile Setup active tab
  navTabButtons.forEach(b => b.classList.remove('active'));
  tabPanes.forEach(pane => pane.classList.remove('active'));
  navTabButtons[0].classList.add('active');
  tabPanes[0].classList.add('active');
});

// ─── Profile Fields & Saving ───────────────────────────────────
(async function init() {
  await updateSessionStatus();
  try {
    const data = await window.api.getSetupData();
    if (!data) return;
    resumeText.value  = data.resumeText  || '';
    companyName.value  = data.companyName  || '';
    roleName.value     = data.roleName     || '';
    jobDesc.value      = data.jobDescription || '';
    projects.value     = data.projects     || '';
    extraNotes.value   = data.extraNotes   || '';
    if (data.resumeText) {
      uploadStatus.textContent = 'Resume loaded from saved profile';
      uploadStatus.classList.add('success');
    }
  } catch (e) {
    console.warn('Could not load saved profile data', e);
  }
})();

// PDF drag and drop
uploadZone.addEventListener('click', async () => {
  const result = await window.api.openFileDialog();
  if (!result.success) return;
  await parsePDF(result.filePath);
});

uploadZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  uploadZone.classList.add('drag-over');
});
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag-over'));
uploadZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  uploadZone.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file && file.name.endsWith('.pdf')) {
    await parsePDF(file.path);
  } else {
    showToast('Please drop a PDF file', 'error');
  }
});

async function parsePDF(filePath) {
  uploadStatus.textContent = 'Parsing PDF...';
  uploadStatus.classList.remove('success');
  try {
    const result = await window.api.parsePDF(filePath);
    if (result.success) {
      resumeText.value = result.text;
      uploadStatus.textContent = '✅ Resume parsed successfully!';
      uploadStatus.classList.add('success');
      showToast('Resume PDF loaded!');
    } else {
      throw new Error(result.error);
    }
  } catch (e) {
    uploadStatus.textContent = 'Failed to parse PDF';
    showToast('PDF parsing failed: ' + e.message, 'error');
  }
}

function collectData() {
  return {
    resumeText:     resumeText.value.trim(),
    companyName:    companyName.value.trim(),
    roleName:       roleName.value.trim(),
    jobDescription: jobDesc.value.trim(),
    projects:       projects.value.trim(),
    extraNotes:     extraNotes.value.trim(),
  };
}

$('#saveBtn').addEventListener('click', async () => {
  const data = collectData();
  if (!data.resumeText && !data.jobDescription) {
    showToast('Please add at least a resume or job description', 'error');
    return;
  }
  const res = await window.api.saveSetupData(data);
  if (res.success) {
    showToast('Profile saved! ✅');
  } else {
    showToast(res.error || 'Failed to save profile', 'error');
  }
});

$('#startBtn').addEventListener('click', async () => {
  const data = collectData();
  if (!data.resumeText && !data.jobDescription) {
    showToast('Please add at least a resume or job description', 'error');
    return;
  }
  const res = await window.api.saveSetupData(data);
  if (!res.success) {
    showToast(res.error || 'Failed to save profile', 'error');
    return;
  }
  showToast('Starting practice mode...');
  setTimeout(async () => {
    await window.api.startPractice();
  }, 600);
});

// ─── Wallet & Recharge Tab Logic ──────────────────────────────
async function loadRechargeOptions() {
  try {
    const res = await window.api.getRechargeTiers();
    if (res.success && res.tiers) {
      pricingGrid.innerHTML = res.tiers.map(tier => `
        <div class="pricing-card ${tier.popular ? 'popular' : ''}">
          <div>
            <div class="tier-name">${tier.name}</div>
            <div class="tier-price">₹${tier.amount}</div>
            ${tier.bonus > 0 ? `<div class="tier-bonus">+₹${tier.bonus} Bonus Credit</div>` : ''}
            <ul class="tier-features">
              <li>Sub-second Fast Answers</li>
              <li>High accuracy transcription</li>
              <li>Anti-fingerprint verification</li>
            </ul>
          </div>
          <button type="button" class="btn btn-primary btn-full buy-tier-btn" data-amount="${tier.amount * 100}">
            Recharge
          </button>
        </div>
      `).join('');

      // Bind button clicks
      document.querySelectorAll('.buy-tier-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const amountPaise = parseInt(btn.getAttribute('data-amount'), 10);
          await handlePaymentRecharge(amountPaise);
        });
      });
    } else {
      pricingGrid.innerHTML = `<div style="text-align: center; color: var(--danger); padding: 20px; grid-column: 1 / -1;">Failed to load billing tiers</div>`;
    }
  } catch (err) {
    pricingGrid.innerHTML = `<div style="text-align: center; color: var(--danger); padding: 20px; grid-column: 1 / -1;">Error: ${err.message}</div>`;
  }
}

async function handlePaymentRecharge(amountPaise) {
  try {
    showToast('Initializing secure checkout order...', 'info');
    const orderRes = await window.api.createRazorpayOrder(amountPaise);
    if (!orderRes.success) {
      showToast(orderRes.error || 'Failed to create payment order', 'error');
      return;
    }

    const { keyId, orderId, amount, userEmail, userName } = orderRes;

    const options = {
      key: keyId,
      amount: amount,
      currency: 'INR',
      name: 'Interview Practice Assistant',
      description: 'Upgrade Wallet Credits',
      order_id: orderId,
      handler: async function (response) {
        showToast('Payment received. Finalizing confirmation...', 'info');
        const verifyRes = await window.api.verifyRazorpayPayment({
          razorpayOrderId: orderId,
          razorpayPaymentId: response.razorpay_payment_id,
          razorpaySignature: response.razorpay_signature
        });

        if (verifyRes.success) {
          showToast('Payment verified successfully! Balance updated. 🚀', 'success');
          await updateSessionStatus();
          await loadPaymentHistory();
        } else {
          showToast(verifyRes.error || 'Payment signature verification failed.', 'error');
        }
      },
      prefill: {
        name: userName || '',
        email: userEmail || ''
      },
      theme: {
        color: '#6366f1'
      }
    };

    const rzp = new Razorpay(options);
    rzp.open();
  } catch (err) {
    showToast('Payment checkout flow failed: ' + err.message, 'error');
  }
}

async function loadPaymentHistory() {
  try {
    const res = await window.api.getPaymentHistory();
    if (res.success && res.payments) {
      if (res.payments.length === 0) {
        paymentHistoryBody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-dim); padding: 16px;">No transactions recorded.</td></tr>`;
        return;
      }
      paymentHistoryBody.innerHTML = res.payments.map(pay => {
        const dateStr = new Date(pay.createdAt).toLocaleDateString(undefined, {
          month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
        });
        const amountINR = '₹' + (pay.amountPaise / 100).toFixed(2);
        
        let statusClass = 'status-paid';
        if (pay.status === 'FAILED') statusClass = 'status-failed';
        else if (pay.status === 'REFUNDED') statusClass = 'status-refunded';

        return `
          <tr>
            <td>${dateStr}</td>
            <td>${pay.razorpayOrderId}</td>
            <td>${amountINR}</td>
            <td><span class="${statusClass}">${pay.status}</span></td>
          </tr>
        `;
      }).join('');
    }
  } catch (err) {
    console.error('Failed to load transaction history', err);
  }
}

// ─── Admin Tab Control Panel Logic ───────────────────────────
async function loadAdminDashboard() {
  try {
    const res = await window.api.getAdminDashboard();
    if (res.success) {
      adminStatUsers.textContent = res.stats.totalUsers;
      adminStatBlocked.textContent = res.stats.blockedUsers;
      adminStatRevenue.textContent = '₹' + (res.stats.grossRevenuePaise / 100).toFixed(2);
      adminStatRequests.textContent = res.stats.totalUsageLogs;
      
      // Auto trigger blank lookup
      await searchAdminUsers('');
    } else {
      showToast(res.error || 'Failed to load administrator metrics', 'error');
    }
  } catch (err) {
    console.error(err);
  }
}

async function searchAdminUsers(query) {
  try {
    adminUsersBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: 16px;">Searching database...</td></tr>`;
    const res = await window.api.adminGetUsers(query, 1);
    if (res.success && res.users) {
      if (res.users.length === 0) {
        adminUsersBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--text-dim); padding: 16px;">No matching users found.</td></tr>`;
        return;
      }

      adminUsersBody.innerHTML = res.users.map(user => {
        const isBlocked = user.isBlocked;
        const blockText = isBlocked ? 'Unblock' : 'Block';
        const blockClass = isBlocked ? 'success' : 'danger';
        const fingerprintText = user.DeviceRegistry[0]?.deviceFingerprint || 'None';

        return `
          <tr>
            <td>
              <div style="font-weight: 600; color: #fff;">${user.name || 'No Name'}</div>
              <div style="font-size: 11px; color: var(--text-dim);">${user.email}</div>
            </td>
            <td><span class="badge ${user.tier}">${user.tier}</span></td>
            <td>₹${(user.walletBalancePaise / 100).toFixed(2)}</td>
            <td>
              <span class="admin-fprint-badge" title="${fingerprintText}">${fingerprintText}</span>
            </td>
            <td>
              <button type="button" class="admin-action-btn" onclick="adminResetDevice('${user.id}')">Reset Device</button>
              <button type="button" class="admin-action-btn ${blockClass}" onclick="adminToggleBlock('${user.id}', ${isBlocked})">${blockText}</button>
              <button type="button" class="admin-action-btn" onclick="adminManualCredit('${user.id}')">Credit</button>
            </td>
          </tr>
        `;
      }).join('');
    }
  } catch (err) {
    adminUsersBody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: var(--danger); padding: 16px;">Query error: ${err.message}</td></tr>`;
  }
}

adminSearchBtn.addEventListener('click', async () => {
  const query = adminSearchInput.value.trim();
  await searchAdminUsers(query);
});

adminSearchInput.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const query = adminSearchInput.value.trim();
    await searchAdminUsers(query);
  }
});

// Expose admin actions to global window context for inline onclick handlers
window.adminResetDevice = async (userId) => {
  if (!confirm('Are you sure you want to release the device hardware registration lock for this user?')) return;
  const res = await window.api.adminResetDevice(userId);
  if (res.success) {
    showToast('Device lock reset successfully!');
    await searchAdminUsers(adminSearchInput.value.trim());
  } else {
    showToast(res.error || 'Failed to reset device', 'error');
  }
};

window.adminToggleBlock = async (userId, isBlocked) => {
  const action = isBlocked ? 'unblock' : 'block';
  if (!confirm(`Are you sure you want to ${action} this user?`)) return;
  const res = await window.api.adminBlockUser(userId, !isBlocked);
  if (res.success) {
    showToast(`User ${action}ed successfully!`);
    await searchAdminUsers(adminSearchInput.value.trim());
    await loadAdminDashboard();
  } else {
    showToast(res.error || 'Operation failed', 'error');
  }
};

window.adminManualCredit = async (userId) => {
  const amountStr = prompt('Enter manual adjustment amount in INR (e.g. 150 for ₹150.00, or -50 for negative correction):');
  if (amountStr === null) return;
  const amountFloat = parseFloat(amountStr);
  if (isNaN(amountFloat)) {
    alert('Invalid amount input');
    return;
  }
  const reason = prompt('Enter a reason description for this credit audit log:');
  if (!reason) {
    alert('A reason description is required');
    return;
  }

  const amountPaise = Math.round(amountFloat * 100);
  const res = await window.api.adminManualCredit(userId, amountPaise, reason);
  if (res.success) {
    showToast('Account balance adjusted successfully!');
    await searchAdminUsers(adminSearchInput.value.trim());
    await loadAdminDashboard();
  } else {
    showToast(res.error || 'Failed to adjust balance', 'error');
  }
};

// ─── Titlebar controls ──────────────────────────────────────
$('#btnMinimize').addEventListener('click', () => window.api.minimizeWindow());
$('#btnClose').addEventListener('click', () => window.api.closeWindow());
