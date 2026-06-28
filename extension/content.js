const PREFIX = "__rc_bypass__";

// ── Detect context ───────────────────────────────────────────────────────────
const isRecaptchaIframe =
  window.location.hostname === "www.google.com" &&
  (window.location.pathname.includes("/recaptcha/api2/anchor") ||
   window.location.pathname.includes("/recaptcha/enterprise/anchor"));

if (isRecaptchaIframe) {
  // Inject iframe script into the iframe's main world
  (function injectIframeScript() {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inject-iframe.js");
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  })();
} else {
  // ── Main frame logic ──

  // Inject the page-world script
  (function injectScript() {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inject.js");
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  })();

  // ── State ──
  let solveDispatched = false;
  let cachedToken     = null;
  let pendingIds      = [];

  function deliver(token, id) {
    window.postMessage({ type: PREFIX + "result", token, id }, "*");
  }

  function forwardToIframes(token) {
    var iframes = document.querySelectorAll('iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"]');
    iframes.forEach(function (iframe) {
      try {
        if (iframe.contentWindow) {
          iframe.contentWindow.postMessage({ type: PREFIX + "_token", token: token }, "*");
        }
      } catch (e) {}
    });
  }

  function dispatchSolve(sitekey, action, origin, id) {
    if (solveDispatched) {
      if (cachedToken) {
        if (id !== -1) deliver(cachedToken, id);
      } else {
        if (id !== -1 && !pendingIds.includes(id)) pendingIds.push(id);
      }
      return;
    }
    solveDispatched = true;

    chrome.runtime.sendMessage(
      {
        type: "solve",
        data: {
          site_key: sitekey,
          origin:   origin || location.origin,
          action:   action || "submit",
          hl:       document.documentElement.lang || "en",
        },
      },
      function (resp) {
        cachedToken = (resp && resp.token) || null;
        deliver(cachedToken, id);
        while (pendingIds.length) deliver(cachedToken, pendingIds.shift());
        if (cachedToken) forwardToIframes(cachedToken);
      }
    );
  }

  function tryProactiveSolve() {
    if (solveDispatched) return;
    const el = document.querySelector(
      ".g-recaptcha[data-sitekey], div[data-sitekey]"
    );
    if (!el) return;
    const sitekey = el.getAttribute("data-sitekey");
    if (!sitekey) return;
    dispatchSolve(sitekey, "submit", location.origin, -1);
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window || !e.data || typeof e.data.type !== "string") return;

    if (e.data.type === PREFIX + "solve") {
      dispatchSolve(e.data.sitekey, e.data.action, e.data.origin, e.data.id);
      return;
    }

    if (e.data.type === PREFIX + "detected") {
      tryProactiveSolve();
    }
  });

  window.addEventListener("DOMContentLoaded", tryProactiveSolve);
  setTimeout(tryProactiveSolve, 2000);
  setTimeout(tryProactiveSolve, 5000);
}
