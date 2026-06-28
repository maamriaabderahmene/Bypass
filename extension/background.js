/**
 * background.js — service worker
 *
 * DESIGN:
 *  • This is the ONLY place that talks to the local server.
 *  • Per-tab state lives here. The popup reads it via get_state.
 *  • Deduplication: each tab gets exactly ONE solve attempt in flight at a time.
 *    If another request arrives while one is in flight, it is dropped (the
 *    injected script will fall back to the real grecaptcha.execute after 12 s).
 *  • Server health is cached and re-checked only every 10 s so the popup never
 *    needs to ping the server itself.
 */

const SERVER = "http://127.0.0.1:5000";

// ── Server health cache ─────────────────────────────────────────────────────
let serverOk = false;
let serverVersion = "?";
let lastPingMs = 0;
const PING_TTL = 10_000; // re-ping at most every 10 s

async function ensurePing() {
  const now = Date.now();
  if (now - lastPingMs < PING_TTL) return;
  lastPingMs = now;
  try {
    const r = await fetch(`${SERVER}/ping`);
    const j = await r.json();
    serverOk = j.status === "ok";
    serverVersion = j.v || "?";
  } catch {
    serverOk = false;
  }
}

// ── Per-tab state ────────────────────────────────────────────────────────────
// state: "idle" | "solving" | "solved" | "failed"
const tabs = {};

function getTab(id) {
  if (!tabs[id]) {
    tabs[id] = { state: "idle", siteKey: null, action: null, token: null };
  }
  return tabs[id];
}

// ── Solve ────────────────────────────────────────────────────────────────────
async function solve(tabId, { site_key, origin, action, hl }) {
  const tab = getTab(tabId);

  // Already solved or in flight — skip
  if (tab.state === "solving" || tab.state === "solved") return null;

  tab.state = "solving";
  tab.siteKey = site_key;
  tab.action = action || "submit";
  tab.token = null;

  try {
    await ensurePing();
    if (!serverOk) {
      tab.state = "failed";
      return null;
    }

    const r = await fetch(`${SERVER}/solve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site_key, origin, action: tab.action, hl }),
    });
    const j = await r.json();

    if (j && j.token) {
      tab.state = "solved";
      tab.token = j.token;
      return j.token;
    } else {
      tab.state = "failed";
      return null;
    }
  } catch {
    tab.state = "failed";
    return null;
  }
}

// ── Message router ───────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : msg.tabId;

  // Content script detected reCAPTCHA → solve it
  if (msg.type === "solve") {
    solve(tabId, msg.data).then((token) => sendResponse({ token }));
    return true; // async
  }

  // Popup wants current state for a tab
  if (msg.type === "get_state") {
    ensurePing().then(() => {
      const tab = getTab(msg.tabId);
      sendResponse({
        state: tab.state,
        siteKey: tab.siteKey,
        action: tab.action,
        serverOk,
        serverVersion,
      });
    });
    return true;
  }

  // Popup refresh button → force a fresh ping
  if (msg.type === "force_ping") {
    lastPingMs = 0;
    ensurePing().then(() => sendResponse({ serverOk, serverVersion }));
    return true;
  }
});

// ── Cleanup ──────────────────────────────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabs[tabId];
});

// Re-navigate on the same tab: reset state so a new solve can be attempted
chrome.webNavigation.onCommitted.addListener(({ tabId, frameId }) => {
  if (frameId !== 0) return; // main frame only
  delete tabs[tabId];
});
