// ─── LinkedIn Background Session Manager ─────────────────────────
// Maintains the user's LinkedIn session inside a persistent hidden
// Electron window. When the RAG chatbot receives a LinkedIn-related
// question, it opens LinkedIn in the background, scrapes the needed
// data (connections at a company, message threads) and returns it as
// grounding context for the answer.
//
// NOTE: Automated access is against LinkedIn's User Agreement and may
// lead to account restriction. The session is the user's own account,
// and actions are read-only (search + view).

const { BrowserWindow } = require('electron');

const LINKEDIN_PARTITION = 'persist:linkedin';
const BASE = 'https://www.linkedin.com';

let win = null;
let loginWaiter = null;

// ─── Window / Session helpers ────────────────────────────────────

function getWindow() {
  if (win && !win.isDestroyed()) return win;
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      partition: LINKEDIN_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.on('closed', () => { win = null; });
  return win;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function goto(url) {
  const w = getWindow();
  await w.loadURL(url).catch(() => {});
  // Give SPA/DOM a moment to settle
  await sleep(1200);
  return w.webContents.getURL();
}

/**
 * Check login state by hitting /feed/ (redirects to login/authwall when
 * the session is missing or expired).
 */
async function isLoggedIn() {
  const url = await goto(`${BASE}/feed/`);
  if (/\/login|\/authwall|\/checkpoint|\/uas\/login/.test(url)) return false;

  const state = await w.webContents.executeJavaScript(`(() => {
    const me = document.querySelector('.global-nav__me-photo, .global-nav__me, img[alt*="profile photo" i], #global-nav');
    return { hasNav: !!document.querySelector('#global-nav'), hasMe: !!me };
  })().catch(() => ({ hasNav: false, hasMe: false }))`);
  return !!(state && (state.hasNav || state.hasMe));
}

/**
 * Ensure a LinkedIn session exists. If not and `interactive` is true,
 * show the login window and wait (max 3 minutes) for the user to log in.
 */
async function ensureLoggedIn({ interactive = true } = {}) {
  if (await isLoggedIn()) return { success: true };

  if (!interactive) {
    return { success: false, error: 'LinkedIn session missing. Connect your LinkedIn account first.' };
  }

  const w = getWindow();
  w.show();
  w.focus();
  await goto(`${BASE}/login`);

  const ok = await new Promise((resolve) => {
    let settled = false;
    loginWaiter = resolve;
    const poll = setInterval(async () => {
      if (settled) { clearInterval(poll); return; }
      try {
        if (!win || win.isDestroyed()) { settled = true; clearInterval(poll); resolve(false); return; }
        const url = win.webContents.getURL();
        if (/\/feed\/?$|\/feed\/|\/messaging|\/notifications/.test(url)) {
          settled = true;
          clearInterval(poll);
          resolve(true);
        }
      } catch {
        settled = true;
        clearInterval(poll);
        resolve(false);
      }
    }, 1500);
    setTimeout(() => {
      if (!settled) { settled = true; clearInterval(poll); resolve(false); }
    }, 180000);
  });

  loginWaiter = null;
  if (!win || win.isDestroyed()) return { success: false, error: 'LinkedIn window closed before login' };
  if (!ok) {
    w.hide();
    return { success: false, error: 'LinkedIn login not completed in time. Please try again.' };
  }
  w.hide();
  return { success: true };
}

/** Called from renderer (login window can navigate freely). */
function notifyLoginNavigation() {
  if (loginWaiter) loginWaiter(true);
}

// ─── Scraping helpers ────────────────────────────────────────────

async function autoScroll(maxScrolls = 4) {
  const w = getWindow();
  await w.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < ${maxScrolls}; i++) {
      window.scrollBy(0, 900);
      const c = document.querySelector('.scaffold-finite-scroll__content, main');
      if (c) c.scrollBy ? c.scrollBy(0, 900) : null;
      await sleep(1000);
    }
  })()`.replace(/\n/g, ' ')).catch(() => {});
}

/** Wait until search results actually render (anchors or JSON-LD appear). */
async function waitForResults(minAnchors = 2, timeoutMs = 10000) {
  const w = getWindow();
  await w.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const start = Date.now();
    while (Date.now() - start < ${timeoutMs}) {
      const anchors = document.querySelectorAll('main a[href*="/in/"]').length;
      const ld = document.querySelector('script[type="application/ld+json"]');
      if (anchors >= ${minAnchors} || ld) return true;
      await sleep(500);
    }
    return false;
  })()`.replace(/\n/g, ' ')).catch(() => false);
}

/** True if the current page is a login/authwall/checkpoint page. */
async function isBlockedPage() {
  const w = getWindow();
  const url = w.webContents.getURL();
  if (/\/login|\/authwall|\/checkpoint|\/uas\//.test(url)) return true;
  return w.webContents.executeJavaScript(`(() => {
    const body = document.body ? document.body.innerText.slice(0, 2000) : '';
    return /sign in to continue|authwall|session has expired|log in to continue/i.test(body);
  })().catch(() => false)`);
}

/**
 * Scrape people-search results.
 * Strategy 1: JSON-LD embedded by LinkedIn (stable across redesigns).
 * Strategy 2: classname-agnostic DOM walk over /in/ profile anchors.
 * Returns [{ name, headline, profileUrl, degree }]
 */
async function scrapePeopleCards() {
  const w = getWindow();
  return w.webContents.executeJavaScript(`(() => {
    const out = new Map();

    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      let ld;
      try { ld = JSON.parse(s.textContent); } catch { return; }
      const roots = [ld, ...((ld && ld['@graph']) || [])];
      for (const g of roots) {
        if (!g) continue;
        const raw = g.itemListElement !== undefined ? g.itemListElement : (g.item ? [g] : []);
        const arr = Array.isArray(raw) ? raw : [raw];
        for (const it of arr) {
          const p = (it && it.item) || it;
          if (!p || !p.name || !p.url) continue;
          const types = Array.isArray(p['@type']) ? p['@type'] : [p['@type']];
          if (p['@type'] && !types.includes('Person')) continue;
          const url = String(p.url).split('?')[0];
          if (url.includes('/in/') && !out.has(url)) {
            out.set(url, {
              name: String(p.name).replace(/\\s+/g, ' ').trim(),
              headline: p.jobTitle ? String(p.jobTitle).replace(/\\s+/g, ' ').trim() : '',
              profileUrl: url,
              degree: ''
            });
          }
        }
      }
    });

    if (out.size === 0) {
      const anchors = document.querySelectorAll('main a[href*="/in/"], a[href*="/in/"]');
      anchors.forEach((a) => {
        const href = a.href ? a.href.split('?')[0] : '';
        if (!href || !href.includes('/in/') || out.has(href)) return;
        const card = a.closest('li') || a.closest('div.entity-result') || a.closest('div[data-view-name]') || (a.parentElement && a.parentElement.parentElement);
        if (!card) return;
        let name = (a.getAttribute('aria-label') || '').trim();
        if (!name) {
          const span = a.querySelector('span[aria-hidden="true"]');
          name = span ? span.textContent.trim() : '';
        }
        if (!name) name = (card.innerText || '').split('\\n')[0].trim();
        name = name.replace(/\\s+/g, ' ').trim();
        if (!name || name.length > 80) return;

        const lines = (card.innerText || '').split('\\n').map((l) => l.replace(/\\s+/g, ' ').trim()).filter(Boolean);
        let headline = '';
        for (const l of lines) {
          if (l !== name && l.length > 3 && l.length < 160 &&
              !/^(message|view|connect|follow|past:|current:|education|\\d+(st|nd|rd|th))/i.test(l) &&
              !/mutual connection/i.test(l) &&
              (l.includes(' at ') || l.includes('|') || l.includes('•') === false && /engineer|manager|developer|designer|analyst|scientist|consultant|intern|associate|director|lead|recruiter|architect|founder|specialist|administrator|executive/i.test(l))) {
            headline = l;
            break;
          }
        }
        const cardText = card.innerText || '';
        const degree = /\\b1st\\b/.test(cardText) ? '1st' : /\\b2nd\\b/.test(cardText) ? '2nd' : '';
        out.set(href, { name, headline, profileUrl: href, degree });
      });
    }

    return Array.from(out.values());
  })()`.replace(/\n/g, ' ')).catch(() => []);
}

/**
 * Search the user's 1st-degree connections for a given company.
 * Tries multiple search URL variants (LinkedIn's facet values change);
 * stops as soon as one returns readable results.
 */
async function searchConnectionsAtCompany(company) {
  const kw = encodeURIComponent(company);
  const variants = [
    `${BASE}/search/results/people/?keywords=${kw}&network=%5B%22S%22%5D&origin=GLOBAL_SEARCH_HEADER`,
    `${BASE}/search/results/people/?keywords=${kw}&origin=FACETED_SEARCH&network=%5B%22F%22%5D`,
    `${BASE}/search/results/people/?keywords=${kw}&origin=FACETED_SEARCH`
  ];

  let results = [];
  let blocked = false;

  for (const url of variants) {
    await goto(url);

    if (await isBlockedPage()) {
      blocked = true;
      break;
    }

    await waitForResults();
    await autoScroll(3);
    results = await scrapePeopleCards();

    // Retry once after a pause — first render is sometimes slow
    if (!results.length) {
      await sleep(2000);
      await waitForResults(1, 6000);
      results = await scrapePeopleCards();
    }

    if (results.length) break;
  }

  if (blocked) {
    return { error: 'LinkedIn is showing a login/authwall page. Please click "LinkedIn" in the chat top bar and log in again.' };
  }

  // Prefer cards explicitly marked 1st degree; keep everything as fallback
  const first = results.filter((r) => r.degree === '1st');
  const connections = (first.length ? first : results).map((r) => ({
    ...r,
    company
  }));

  return { connections, total: connections.length };
}

/**
 * Scrape the messaging thread list. Returns
 * [{ participants, snippet, lastMessageFromMe }]
 */
async function getMessageThreads() {
  await goto(`${BASE}/messaging/`);

  if (await isBlockedPage()) {
    return { error: 'LinkedIn is showing a login/authwall page. Please click "LinkedIn" in the chat top bar and log in again.' };
  }

  // Wait for thread list to render
  const w = getWindow();
  await w.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const start = Date.now();
    while (Date.now() - start < 8000) {
      if (document.querySelectorAll('li.msg-conversation-listitem, li.msg-conversation-card, .msg-conversations-container__convo-item, [class*="msg-conversation"]').length > 0) return true;
      await sleep(500);
    }
    return false;
  })()`.replace(/\n/g, ' ')).catch(() => false);

  await autoScroll(3);

  const threads = await w.webContents.executeJavaScript(`(() => {
    const seen = new Map();
    const links = document.querySelectorAll('a[href*="/messaging/thread/"]');
    links.forEach((a) => {
      const li = a.closest('li') || a.closest('[class*="msg-conversation"]') || a;
      const text = (li.innerText || '').replace(/\\s+/g, ' ').trim();
      const nameEl = li.querySelector('[class*="participant"]');
      const img = li.querySelector('img[alt]');
      let names = '';
      if (nameEl && nameEl.textContent.trim()) {
        names = nameEl.textContent.replace(/\\s+/g, ' ').trim();
      } else if (img && img.alt && img.alt.trim()) {
        names = img.alt.replace(/\\s+/g, ' ').trim();
      } else {
        names = text.split(' · ')[0].split('  ')[0].trim();
      }
      names = names.replace(/\\s+and\\s+you.*$/i, '').trim();
      if (!names || names.length > 100) return;
      const key = names.toLowerCase();
      if (seen.has(key)) return;
      const snippetEl = li.querySelector('[class*="snippet"]');
      const snippet = snippetEl ? snippetEl.textContent.replace(/\\s+/g, ' ').trim() : text.slice(0, 200);
      const fromMe = /^you\\s*:/i.test(snippet);
      seen.set(key, { participants: names, lastMessageSnippet: snippet, lastMessageFromMe: fromMe });
    });
    return Array.from(seen.values());
  })()`.replace(/\n/g, ' ')).catch(() => []);

  return { threads, total: threads.length };
}

// ─── Public API ──────────────────────────────────────────────────

async function getStatus() {
  try {
    const logged = await isLoggedIn();
    return { success: true, connected: logged };
  } catch (e) {
    return { success: false, connected: false, error: e.message };
  }
}

async function connect() {
  return ensureLoggedIn({ interactive: true });
}

/**
 * Extract the likely company name from a LinkedIn question.
 * e.g. "Who among my LinkedIn connections currently works at MongoDB?" → "MongoDB"
 */
function extractCompany(question) {
  const patterns = [
    /(?:works?|working|work(?:ed)?)\s+(?:at|for|in)\s+([A-Za-z][\w&.'-]*(?:\s+[A-Za-z][\w&.'-]*){0,3})/i,
    /(?:at|in|from)\s+((?:[A-Z][\w&.'-]*)(?:\s+(?:[A-Z][\w&.'-]*))*)(?:\s*\?|$|\s+(?:who|that|which|has|have|and|replied|currently))/,
    /(?:company|employer)\s+([A-Za-z][\w&.'-]*(?:\s+[A-Za-z][\w&.'-]*){0,3})/i
  ];
  const stop = new Set(['LinkedIn', 'My', 'The', 'A', 'An', 'Who', 'What', 'Which', 'Currently', 'Reply', 'Replied', 'Messages', 'Message', 'Connections', 'People', 'Mongo', 'In']);
  for (const re of patterns) {
    const m = question.match(re);
    if (m && m[1]) {
      let cand = m[1].trim().replace(/\s*\?$/, '');
      // Cut at common trailing words
      cand = cand.split(/\s+(?:who|that|which|has|have|currently|replied|and|messages?)\b/i)[0].trim();
      if (cand && !stop.has(cand) && cand.length >= 2) return cand;
    }
  }
  // Fallback: any standalone capitalized token that looks like a brand
  const brands = question.match(/\b([A-Z][a-z]+(?:DB|Hub|Point|ify|IO|Labs)?[A-Z]?[a-z]*)\b/g) || [];
  const filtered = brands.filter((b) => !stop.has(b) && b.length > 2 && !/^(Who|What|Which|When|Where|Why|How|The|My|I)$/i.test(b));
  return filtered.length ? filtered[filtered.length - 1] : null;
}

/**
 * Detect whether a chat question requires live LinkedIn data.
 */
function isLinkedInQuestion(question) {
  const q = question.toLowerCase();
  if (/\blinkedin\b/.test(q)) return true;
  if (/\b(connections?|my network|1st degree|2nd degree|contacts?)\b/.test(q) && /\b(my|mine|i)\b/.test(q)) return true;
  if (/\b(replied|reply|inbox|dm|dm'ed|dmed|message[d]?\s+me|messaging)\b/.test(q)) return true;
  if (/\bwho\b.*\b(work(s|ing)?\s+(at|for|in))\b/.test(q) && /\b(my|among)\b/.test(q)) return true;
  return false;
}

/**
 * Decide whether the question touches messages/replies.
 */
function needsMessages(question) {
  return /\b(replied|reply|inbox|message|messages|dm|chat|conversation)\b/i.test(question);
}

/**
 * Main entry: gather grounding context for a LinkedIn question.
 */
async function collectContext(question) {
  try {
    const login = await ensureLoggedIn({ interactive: true });
    if (!login.success) return { success: false, error: login.error };

    const context = {
      fetchedAt: new Date().toISOString(),
      source: "user's own LinkedIn account (read-only background check)",
      searchedCompany: null,
      connections: [],
      messages: []
    };

    let hadError = null;

    const company = extractCompany(question);
    if (company) {
      context.searchedCompany = company;
      const res = await searchConnectionsAtCompany(company);
      if (res.error) {
        hadError = res.error;
      } else {
        context.connections = res.connections;
        if (!res.connections.length) {
          context.dataQualityNote = `The LinkedIn people search for "${company}" loaded but no readable result cards were found. Do NOT claim the user has 0 connections — say the check could not be completed and suggest reconnecting LinkedIn or searching manually.`;
        }
      }
    }

    if (needsMessages(question)) {
      const res = await getMessageThreads();
      if (res.error) {
        hadError = hadError || res.error;
      } else {
        context.messages = res.threads;
      }
    }

    // Only fail hard when we got nothing at all
    if (hadError && !context.connections.length && !context.messages.length) {
      return { success: false, error: hadError };
    }

    return { success: true, context };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function destroy() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

module.exports = {
  getStatus,
  connect,
  collectContext,
  isLinkedInQuestion,
  extractCompany,
  destroy
};
