// ─── RAG Chat Assistant Renderer ─────────────────────────────────
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('sendBtn');
const statusEl = document.getElementById('status');
const statusTextEl = document.getElementById('statusText');
const liDot = document.getElementById('liDot');
const liBtn = document.getElementById('linkedinBtn');
const clearBtn = document.getElementById('clearBtn');
const closeBtn = document.getElementById('closeBtn');

// Conversation history sent with each request: [{ role, content }]
let history = [];
let streaming = false;

function setStatus(text) {
  statusTextEl.textContent = text;
  statusEl.hidden = !text;
}

function setLinkedInState(state) {
  liDot.classList.remove('connected', 'busy');
  if (state === 'connected') liDot.classList.add('connected');
  if (state === 'busy') liDot.classList.add('busy');
  liBtn.title = state === 'connected'
    ? 'LinkedIn connected'
    : 'Connect your LinkedIn account';
}

function removeWelcome() {
  const w = messagesEl.querySelector('.welcome');
  if (w) w.remove();
}

function addMessage(role, text, cls) {
  removeWelcome();
  const div = document.createElement('div');
  div.className = `msg ${cls || role}`;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function scrollBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ─── Send flow ───────────────────────────────────────────────────
async function send() {
  const question = inputEl.value.trim();
  if (!question || streaming) return;

  inputEl.value = '';
  inputEl.style.height = 'auto';
  addMessage('user', question);

  streaming = true;
  sendBtn.disabled = true;

  const answerEl = addMessage('assistant', '');
  let answer = '';

  try {
    // LinkedIn-related questions trigger a background scrape first
    setStatus('Checking your question...');
    const result = await window.api.sendChatMessage(question, history.slice(-6), (chunk) => {
      answer += chunk;
      answerEl.textContent = answer;
      scrollBottom();
    });

    if (!result.success) {
      answerEl.remove();
      addMessage('error', result.error || 'Something went wrong. Please try again.');
    } else if (!answer.trim()) {
      answerEl.textContent = 'Sorry, I could not generate an answer. Please try again.';
    }
  } catch (e) {
    answerEl.remove();
    addMessage('error', e.message);
  } finally {
    streaming = false;
    sendBtn.disabled = false;
    setStatus('');
    if (answer.trim()) history.push({ role: 'user', content: question }, { role: 'assistant', content: answer });
    if (history.length > 12) history = history.slice(-12);
    refreshLinkedInStatus();
  }
}

async function refreshLinkedInStatus() {
  try {
    const res = await window.api.getLinkedInStatus();
    setLinkedInState(res.connected ? 'connected' : '');
  } catch {
    setLinkedInState('');
  }
}

// ─── Events ──────────────────────────────────────────────────────
sendBtn.addEventListener('click', send);
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 100) + 'px';
});

liBtn.addEventListener('click', async () => {
  if (streaming) return;
  setLinkedInState('busy');
  setStatus('Opening LinkedIn — please complete login in the window that opens...');
  const res = await window.api.connectLinkedIn();
  setStatus('');
  if (res.success) {
    setLinkedInState('connected');
    addMessage('assistant', 'LinkedIn connected ✓ You can now ask questions like "Who among my connections works at MongoDB?"');
  } else {
    setLinkedInState('');
    addMessage('error', res.error || 'LinkedIn connection failed.');
  }
});

clearBtn.addEventListener('click', () => {
  history = [];
  messagesEl.innerHTML = `
    <div class="welcome">
      <div class="welcome-icon">🤖</div>
      <h3>Ask me anything</h3>
      <p>App questions, your profile, or your LinkedIn network — e.g. <em>"Who among my LinkedIn connections currently works at MongoDB?"</em></p>
    </div>`;
});

closeBtn.addEventListener('click', () => window.api.closeWindow());

// Live status updates from the main process (e.g. "Checking your LinkedIn...")
if (window.api.onChatStatus) {
  window.api.onChatStatus((status) => setStatus(status));
}

refreshLinkedInStatus();
