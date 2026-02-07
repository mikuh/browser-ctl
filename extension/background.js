/**
 * background.js — Service worker for Browser-Ctl extension.
 *
 * Maintains a WebSocket connection to the local bridge server and dispatches
 * incoming commands to the appropriate Chrome API or content-script handler.
 */

const WS_URL = "ws://127.0.0.1:19876/ws";

let ws = null;
let reconnectDelay = 1000; // ms, doubles on each failure up to 30s
const MAX_RECONNECT_DELAY = 30000;

// ---------------------------------------------------------------------------
// WebSocket lifecycle
// ---------------------------------------------------------------------------

function connect() {
  if (ws && ws.readyState <= WebSocket.OPEN) return;

  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    console.warn("[bctl] WebSocket creation failed:", e);
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    console.log("[bctl] Connected to bridge server");
    reconnectDelay = 1000;
  };

  ws.onmessage = async (event) => {
    let cmd;
    try {
      cmd = JSON.parse(event.data);
    } catch (e) {
      console.error("[bctl] Bad JSON from server:", event.data);
      return;
    }
    const response = await dispatch(cmd);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(response));
    }
  };

  ws.onclose = () => {
    console.log("[bctl] Disconnected from bridge server");
    ws = null;
    scheduleReconnect();
  };

  ws.onerror = (e) => {
    console.warn("[bctl] WebSocket error:", e);
    // onclose will fire after this
  };
}

function scheduleReconnect() {
  // Use chrome.alarms for reliable reconnection in MV3 service workers.
  // setTimeout/setInterval are unreliable because the service worker can be
  // terminated at any time, losing all JS timers.
  const delaySec = Math.max(1, reconnectDelay / 1000);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  chrome.alarms.create("bctl-reconnect", { delayInMinutes: delaySec / 60 });
}

// Handle alarm-based reconnection
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bctl-reconnect") {
    connect();
  }
  if (alarm.name === "bctl-keepalive") {
    // Reconnect if disconnected
    if (!ws || ws.readyState > WebSocket.OPEN) {
      connect();
    }
  }
});

// Start connection on load
connect();

// Also reconnect when service worker wakes up
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Keep-alive: periodic alarm every 25s to detect disconnection and reconnect.
// Unlike setInterval, chrome.alarms persist across service worker restarts.
chrome.alarms.create("bctl-keepalive", { periodInMinutes: 25 / 60 });

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

async function dispatch(cmd) {
  const { id, action, params } = cmd;
  try {
    const result = await handleAction(action, params || {});
    return { id, success: true, data: result };
  } catch (e) {
    return { id, success: false, error: String(e.message || e) };
  }
}

async function handleAction(action, params) {
  switch (action) {
    // -- Navigation --
    case "navigate":
      return await doNavigate(params);
    case "back":
      return await doBack();
    case "forward":
      return await doForward();
    case "reload":
      return await doReload();

    // -- Interaction (content-script) --
    case "click":
      return await runInPage("click", params);
    case "hover":
      return await runInPage("hover", params);
    case "type":
      return await runInPage("type", params);
    case "press":
      return await doPress(params);

    // -- Query (content-script) --
    case "text":
      return await runInPage("text", params);
    case "html":
      return await runInPage("html", params);
    case "attr":
      return await runInPage("attr", params);
    case "select":
      return await runInPage("select", params);
    case "count":
      return await runInPage("count", params);
    case "status":
      return await doStatus();

    // -- JavaScript --
    case "eval":
      return await doEval(params);

    // -- Tabs --
    case "tabs":
      return await doTabs();
    case "tab":
      return await doSwitchTab(params);
    case "new-tab":
      return await doNewTab(params);
    case "close-tab":
      return await doCloseTab(params);

    // -- Screenshot / Download --
    case "screenshot":
      return await doScreenshot();
    case "download":
      return await doDownload(params);

    // -- Wait --
    case "wait":
      return await doWait(params);

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get the currently active tab. */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) throw new Error("No active tab");
  return tab;
}

/** Wait for a tab to finish loading after navigation. */
function waitForTabLoad(tabId, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // resolve even on timeout — page may be usable
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ---------------------------------------------------------------------------
// Navigation commands
// ---------------------------------------------------------------------------

async function doNavigate(params) {
  const url = params.url;
  if (!url) throw new Error("Missing 'url' parameter");
  const tab = await activeTab();
  await chrome.tabs.update(tab.id, { url });
  await waitForTabLoad(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return { url: updated.url, title: updated.title };
}

async function doBack() {
  const tab = await activeTab();
  await chrome.tabs.goBack(tab.id);
  await waitForTabLoad(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return { url: updated.url, title: updated.title };
}

async function doForward() {
  const tab = await activeTab();
  await chrome.tabs.goForward(tab.id);
  await waitForTabLoad(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return { url: updated.url, title: updated.title };
}

async function doReload() {
  const tab = await activeTab();
  await chrome.tabs.reload(tab.id);
  await waitForTabLoad(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return { url: updated.url, title: updated.title };
}

// ---------------------------------------------------------------------------
// Tab commands
// ---------------------------------------------------------------------------

async function doTabs() {
  const tabs = await chrome.tabs.query({});
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
    })),
  };
}

async function doSwitchTab(params) {
  const tabId = parseInt(params.id, 10);
  if (isNaN(tabId)) throw new Error("Missing or invalid 'id' parameter");
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  return { id: tab.id, url: tab.url, title: tab.title };
}

async function doNewTab(params) {
  const tab = await chrome.tabs.create({ url: params.url || "about:blank" });
  if (params.url) await waitForTabLoad(tab.id);
  const updated = await chrome.tabs.get(tab.id);
  return { id: updated.id, url: updated.url, title: updated.title };
}

async function doCloseTab(params) {
  const tabId = params.id ? parseInt(params.id, 10) : (await activeTab()).id;
  await chrome.tabs.remove(tabId);
  return { closed: tabId };
}

// ---------------------------------------------------------------------------
// Status / screenshot
// ---------------------------------------------------------------------------

async function doStatus() {
  const tab = await activeTab();
  return { url: tab.url, title: tab.title, id: tab.id };
}

async function doScreenshot() {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, {
    format: "png",
  });
  // Strip the data:image/png;base64, prefix
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  return { format: "png", base64 };
}

// ---------------------------------------------------------------------------
// Download (using chrome.downloads API or fetch with cookies)
// ---------------------------------------------------------------------------

async function doDownload(params) {
  const { url, selector, filename, index } = params;

  let downloadUrl = url;

  // If selector is provided, extract the src/href from the element
  if (selector && !url) {
    const result = await runInPage("extractUrl", { selector, index });
    downloadUrl = result.url;
    if (!downloadUrl) throw new Error(`No downloadable URL found on element: ${selector}`);
  }

  if (!downloadUrl) throw new Error("Missing 'url' or 'selector' parameter");

  // Use chrome.downloads API which carries the browser's auth cookies
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: downloadUrl,
        filename: filename || undefined,
        conflictAction: "uniquify",
      },
      (id) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
        }
      }
    );
  });

  // Wait for download to complete
  const info = await waitForDownload(downloadId);
  return info;
}

function waitForDownload(downloadId, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.downloads.onChanged.removeListener(listener);
      resolve({ downloadId, state: "timeout" });
    }, timeoutMs);

    function listener(delta) {
      if (delta.id !== downloadId) return;
      if (delta.state && delta.state.current === "complete") {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        chrome.downloads.search({ id: downloadId }, (results) => {
          const item = results[0];
          resolve({
            downloadId,
            state: "complete",
            filename: item?.filename,
            fileSize: item?.fileSize,
            mime: item?.mime,
          });
        });
      } else if (delta.state && delta.state.current === "interrupted") {
        clearTimeout(timer);
        chrome.downloads.onChanged.removeListener(listener);
        resolve({ downloadId, state: "failed", error: delta.error?.current });
      }
    }
    chrome.downloads.onChanged.addListener(listener);
  });
}

// ---------------------------------------------------------------------------
// Press key (via debugger or content script)
// ---------------------------------------------------------------------------

async function doPress(params) {
  const key = params.key;
  if (!key) throw new Error("Missing 'key' parameter");
  return await runInPage("press", { key });
}

// ---------------------------------------------------------------------------
// Eval
// ---------------------------------------------------------------------------

async function doEval(params) {
  const code = params.code;
  if (!code) throw new Error("Missing 'code' parameter");
  const tab = await activeTab();

  // Strategy 1: MAIN world <script> tag injection.
  // Fast path — works on most sites without strict CSP.
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (userCode) => {
      const key = "__bctl_r_" + Math.random().toString(36).slice(2);
      const script = document.createElement("script");
      // textContent is not a Trusted Types sink, bypassing
      // require-trusted-types-for 'script' policies.
      script.textContent =
        "try{window['" + key + "']={v:(0,eval)(" + JSON.stringify(userCode) + ")}}" +
        "catch(e){window['" + key + "']={e:e.message||String(e)}}";
      (document.head || document.documentElement).appendChild(script);
      script.remove();
      const r = window[key];
      delete window[key];
      if (!r) return null; // CSP blocked — fall through to debugger
      if (r.e !== undefined) return { error: r.e };
      return { value: r.v, ok: true };
    },
    args: [code],
    world: "MAIN",
  });

  const r = results[0]?.result;
  if (r && r.ok) return { result: r.value ?? null };
  if (r && r.error) throw new Error(r.error);

  // Strategy 2: Chrome DevTools Protocol via chrome.debugger.
  // Fallback for strict-CSP pages (YouTube, Google, etc.) where script
  // injection is blocked. Runtime.evaluate bypasses all CSP restrictions.
  return await evalViaDebugger(tab.id, code);
}

async function evalViaDebugger(tabId, code) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    // Already attached (DevTools open?) or restricted page
    if (e.message?.includes("Another debugger")) {
      throw new Error("eval: cannot attach debugger (DevTools may be open). Close DevTools and retry, or use 'bctl select'/'bctl text' for DOM queries.");
    }
    throw new Error("eval: cannot attach debugger — " + (e.message || e));
  }

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      {
        expression: code,
        returnByValue: true,
        awaitPromise: false,
      }
    );

    if (result.exceptionDetails) {
      const desc =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "Evaluation failed";
      throw new Error(desc);
    }

    return { result: result.result?.value ?? null };
  } finally {
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {
      // ignore detach errors
    }
  }
}

// ---------------------------------------------------------------------------
// Wait
// ---------------------------------------------------------------------------

async function doWait(params) {
  const selector = params.selector;
  const timeout = params.timeout ?? 5;

  if (!selector) {
    // Interpret as sleep in seconds
    const seconds = parseFloat(params.seconds ?? params.selector ?? timeout);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return { waited: seconds };
  }

  return await runInPage("wait", { selector, timeout });
}

// ---------------------------------------------------------------------------
// Content-script injection
// ---------------------------------------------------------------------------

/**
 * Run a DOM operation in the active tab via chrome.scripting.executeScript.
 * The content.js logic is inlined here to avoid needing a separate content script file
 * that must be declared in manifest.json.
 */
async function runInPage(op, params) {
  const tab = await activeTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: contentScriptHandler,
    args: [op, params],
  });

  const r = results[0]?.result;
  if (!r) throw new Error("Content script returned no result");
  if (r.error) throw new Error(r.error);
  return r.data;
}

/**
 * This function is serialized and injected into the page.
 * It CANNOT reference any variables from the outer scope.
 */
function contentScriptHandler(op, params) {
  try {
    function qs(selector, index) {
      if (!selector) return document.body;
      if (index !== undefined && index !== null) {
        const els = document.querySelectorAll(selector);
        if (els.length === 0) throw new Error(`Element not found: ${selector}`);
        if (index < 0) index = els.length + index; // negative index from end
        if (index >= els.length) throw new Error(`Index ${index} out of range (found ${els.length} elements for: ${selector})`);
        return els[index];
      }
      const el = document.querySelector(selector);
      if (!el) throw new Error(`Element not found: ${selector}`);
      return el;
    }

    switch (op) {
      case "click": {
        const el = qs(params.selector, params.index);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.click();
        const total = params.selector ? document.querySelectorAll(params.selector).length : 1;
        return { data: { clicked: params.selector || "body", index: params.index ?? 0, total } };
      }

      case "hover": {
        const el = qs(params.selector, params.index);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true }));
        el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
        return { data: { hovered: params.selector } };
      }

      case "type": {
        const el = qs(params.selector);
        el.focus();
        // Clear existing value
        if ("value" in el) {
          el.value = "";
        }
        // Simulate typing
        const text = params.text || "";
        if ("value" in el) {
          el.value = text;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          el.textContent = text;
        }
        return { data: { typed: text, selector: params.selector } };
      }

      case "press": {
        const key = params.key;
        const target = document.activeElement || document.body;
        const opts = { key, bubbles: true, cancelable: true };
        target.dispatchEvent(new KeyboardEvent("keydown", opts));
        target.dispatchEvent(new KeyboardEvent("keypress", opts));
        target.dispatchEvent(new KeyboardEvent("keyup", opts));
        return { data: { pressed: key } };
      }

      case "text": {
        const el = qs(params.selector);
        return { data: { text: el.innerText } };
      }

      case "html": {
        const el = qs(params.selector);
        return { data: { html: el.innerHTML } };
      }

      case "attr": {
        const el = qs(params.selector, params.index);
        const name = params.name;
        if (!name) {
          // Return all attributes
          const attrs = {};
          for (const a of el.attributes) {
            attrs[a.name] = a.value;
          }
          return { data: { attributes: attrs } };
        }
        return { data: { [name]: el.getAttribute(name) } };
      }

      case "select": {
        const selector = params.selector;
        if (!selector) throw new Error("Missing 'selector' parameter");
        const els = document.querySelectorAll(selector);
        const limit = params.limit || 20;
        const items = [];
        for (let i = 0; i < Math.min(els.length, limit); i++) {
          const el = els[i];
          const item = { index: i, tag: el.tagName.toLowerCase() };
          // Include useful text (truncated)
          const text = (el.innerText || el.textContent || "").trim();
          if (text) item.text = text.substring(0, 200);
          // Include key attributes
          if (el.id) item.id = el.id;
          if (el.className && typeof el.className === "string") item.class = el.className;
          if (el.href) item.href = el.href;
          if (el.src) item.src = el.src;
          if (el.getAttribute("aria-label")) item.ariaLabel = el.getAttribute("aria-label");
          if (el.getAttribute("data-test-id")) item.testId = el.getAttribute("data-test-id");
          items.push(item);
        }
        return { data: { selector, total: els.length, items } };
      }

      case "count": {
        const selector = params.selector;
        if (!selector) throw new Error("Missing 'selector' parameter");
        const count = document.querySelectorAll(selector).length;
        return { data: { selector, count } };
      }

      case "extractUrl": {
        const el = qs(params.selector, params.index);
        const url = el.src || el.href || el.getAttribute("data-src") || el.currentSrc || null;
        return { data: { url, tag: el.tagName.toLowerCase() } };
      }

      case "wait": {
        const selector = params.selector;
        const timeout = (params.timeout ?? 5) * 1000;
        return new Promise((resolve) => {
          const start = Date.now();
          function check() {
            const el = document.querySelector(selector);
            if (el) {
              resolve({ data: { found: true, selector } });
            } else if (Date.now() - start > timeout) {
              resolve({ error: `Timeout waiting for: ${selector}` });
            } else {
              setTimeout(check, 100);
            }
          }
          check();
        });
      }

      default:
        return { error: `Unknown content operation: ${op}` };
    }
  } catch (e) {
    return { error: String(e.message || e) };
  }
}
