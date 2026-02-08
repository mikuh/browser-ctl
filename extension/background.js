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
    // Try immediate reconnect via setTimeout (works while SW is alive).
    // chrome.alarms has a ~30s minimum in production, so we use setTimeout
    // for fast retries first, with alarms as a reliable backup.
    immediateReconnect();
  };

  ws.onerror = (e) => {
    console.warn("[bctl] WebSocket error:", e);
    // onclose will fire after this
  };
}

let _reconnectTimer = null;

function immediateReconnect() {
  // Fast reconnect via setTimeout — works as long as the service worker is alive.
  // We attempt rapid retries (1s, 2s, 4s…) which is much faster than chrome.alarms
  // (minimum ~30s in production). If the SW is terminated mid-retry, the alarm
  // backup in scheduleReconnect() will still fire.
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);

  clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(() => {
    connect();
  }, delay);

  // Also schedule an alarm as a reliable backup in case the SW is killed.
  chrome.alarms.create("bctl-reconnect", { delayInMinutes: Math.max(delay / 1000, 1) / 60 });
}

function scheduleReconnect() {
  immediateReconnect();
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

// Keep-alive: periodic alarm as a fallback to detect disconnection.
// chrome.alarms has a ~30s minimum in production, so we also use a faster
// setTimeout-based keepalive that runs while the service worker is alive.
chrome.alarms.create("bctl-keepalive", { periodInMinutes: 0.5 });

// Fast keepalive via setTimeout — checks every 5s while SW is alive.
function fastKeepalive() {
  if (!ws || ws.readyState > WebSocket.OPEN) {
    connect();
  }
  setTimeout(fastKeepalive, 5000);
}
setTimeout(fastKeepalive, 5000);

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

    // -- Scroll --
    case "scroll":
      return await runInPage("scroll", params);

    // -- Form --
    case "select-option":
      return await runInPage("select-option", params);

    // -- Upload --
    case "upload":
      return await doUpload(params);

    // -- Dialog --
    case "dialog":
      return await doDialog(params);

    // -- Drag --
    case "drag":
      return await runInPage("drag", params);

    // -- Snapshot --
    case "snapshot":
      return await runInPage("snapshot", params);

    // -- Extra interaction --
    case "dblclick":
      return await runInPage("dblclick", params);
    case "focus":
      return await runInPage("focus", params);
    case "check":
      return await runInPage("check", params);
    case "uncheck":
      return await runInPage("uncheck", params);
    case "input-text":
      return await runInPage("input-text", params);

    // -- Extra query --
    case "is-visible":
      return await runInPage("is-visible", params);
    case "get-value":
      return await runInPage("get-value", params);

    // -- Batch (multiple content-script ops in a single executeScript) --
    case "batch":
      return await doBatch(params);

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
// Upload (via Chrome DevTools Protocol)
// ---------------------------------------------------------------------------

async function doUpload(params) {
  const { selector, files } = params;
  if (!selector) throw new Error("Missing 'selector' parameter");
  if (!files || !files.length) throw new Error("Missing 'files' parameter");

  const tab = await activeTab();

  try {
    await chrome.debugger.attach({ tabId: tab.id }, "1.3");
  } catch (e) {
    if (e.message?.includes("Another debugger")) {
      throw new Error(
        "upload: cannot attach debugger (DevTools may be open). Close DevTools and retry."
      );
    }
    throw new Error("upload: cannot attach debugger — " + (e.message || e));
  }

  try {
    const doc = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "DOM.getDocument",
      {}
    );

    const nodeResult = await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "DOM.querySelector",
      { nodeId: doc.root.nodeId, selector }
    );

    if (!nodeResult.nodeId) {
      throw new Error(`Element not found: ${selector}`);
    }

    await chrome.debugger.sendCommand(
      { tabId: tab.id },
      "DOM.setFileInputFiles",
      { files, nodeId: nodeResult.nodeId }
    );

    return { uploaded: files.length, files, selector };
  } finally {
    try {
      await chrome.debugger.detach({ tabId: tab.id });
    } catch (_) {
      // ignore detach errors
    }
  }
}

// ---------------------------------------------------------------------------
// Dialog handling (override window.alert/confirm/prompt)
// ---------------------------------------------------------------------------

async function doDialog(params) {
  const accept = params.accept !== false;
  const text = params.text || "";

  const tab = await activeTab();

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (shouldAccept, responseText) => {
      const origAlert = window.alert;
      const origConfirm = window.confirm;
      const origPrompt = window.prompt;

      // Restore originals after first dialog fires
      function restore() {
        window.alert = origAlert;
        window.confirm = origConfirm;
        window.prompt = origPrompt;
      }

      window.alert = function (message) {
        window.__bctl_last_dialog = { type: "alert", message: String(message) };
        restore();
      };

      window.confirm = function (message) {
        window.__bctl_last_dialog = {
          type: "confirm",
          message: String(message),
          returned: shouldAccept,
        };
        restore();
        return shouldAccept;
      };

      window.prompt = function (message, defaultValue) {
        const value = shouldAccept ? responseText || defaultValue || "" : null;
        window.__bctl_last_dialog = {
          type: "prompt",
          message: String(message),
          returned: value,
        };
        restore();
        return value;
      };
    },
    args: [accept, text],
    world: "MAIN",
  });

  return { handler: accept ? "accept" : "dismiss", text: text || null };
}

// ---------------------------------------------------------------------------
// Content-script injection
// ---------------------------------------------------------------------------

/**
 * Run a single DOM operation in the active tab.
 * Wraps the command as a 1-element batch and extracts the first result.
 */
async function runInPage(op, params) {
  const tab = await activeTab();

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: contentScriptHandler,
    args: [[{ op, params }]],
  });

  const arr = results[0]?.result;
  if (!arr || !arr.length) throw new Error("Content script returned no result");
  const r = arr[0];
  if (!r.success) throw new Error(r.error || "Content script operation failed");
  return r.data;
}

/**
 * Execute multiple DOM operations in a single executeScript call.
 * Called by the "batch" action — receives {commands: [{action, params}, ...]}.
 */
async function doBatch(params) {
  const commands = params.commands || [];
  if (!commands.length) return { results: [] };

  const tab = await activeTab();

  // Map {action, params} to {op, params} for the content script
  const ops = commands.map((c) => ({ op: c.action, params: c.params }));

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: contentScriptHandler,
    args: [ops],
  });

  const arr = results[0]?.result;
  if (!arr) throw new Error("Batch content script returned no result");
  return { results: arr };
}

/**
 * Unified content-script handler — executes one or more DOM operations
 * inside the page context via a single chrome.scripting.executeScript call.
 *
 * @param {Array<{op: string, params: object}>} commands
 * @returns {Array<{success: boolean, data?: object, error?: string}>}
 *
 * This function is serialized and injected into the page.
 * It CANNOT reference any variables from the outer scope.
 */
async function contentScriptHandler(commands) {
  // -- Helper: query element by ref (e0, e1, …) or CSS selector with optional text filter --
  function qs(selector, index, textFilter) {
    if (!selector) return document.body;

    // Element ref support: "e0", "e1", "e2", … from snapshot
    if (/^e\d+$/.test(selector)) {
      const el = document.querySelector(`[data-bctl-ref="${selector}"]`);
      if (!el) throw new Error(`Ref not found: ${selector} (run 'snapshot' first to assign refs)`);
      return el;
    }

    let candidates = Array.from(document.querySelectorAll(selector));
    if (candidates.length === 0) throw new Error(`Element not found: ${selector}`);

    if (textFilter) {
      const lower = textFilter.toLowerCase();
      candidates = candidates.filter((el) => {
        const t = (el.innerText || el.textContent || "").toLowerCase();
        return t.includes(lower);
      });
      if (candidates.length === 0)
        throw new Error(`No element matching "${selector}" contains text "${textFilter}"`);
    }

    if (index !== undefined && index !== null) {
      if (index < 0) index = candidates.length + index;
      if (index >= candidates.length)
        throw new Error(`Index ${index} out of range (found ${candidates.length} elements for: ${selector})`);
      return candidates[index];
    }
    return candidates[0];
  }

  // -- Execute a single DOM operation (synchronous) --
  function executeOp(op, params) {
    switch (op) {
      case "click": {
        const el = qs(params.selector, params.index, params.text);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.click();
        const total = params.selector ? document.querySelectorAll(params.selector).length : 1;
        return { clicked: params.selector || "body", index: params.index ?? 0, total, text: params.text || null };
      }

      case "hover": {
        const el = qs(params.selector, params.index, params.text);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true }));
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: false, cancelable: true }));
        el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, cancelable: true }));
        return { hovered: params.selector, text: params.text || null };
      }

      case "type": {
        const el = qs(params.selector);
        el.focus();
        const text = params.text || "";
        if ("value" in el) {
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (nativeSetter) {
            nativeSetter.call(el, "");
            el.dispatchEvent(new Event("input", { bubbles: true }));
            nativeSetter.call(el, text);
          } else {
            el.value = text;
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          el.textContent = text;
        }
        return { typed: text, selector: params.selector };
      }

      case "press": {
        const key = params.key;
        const target = document.activeElement || document.body;
        const opts = { key, bubbles: true, cancelable: true };
        const cancelled = !target.dispatchEvent(new KeyboardEvent("keydown", opts));
        target.dispatchEvent(new KeyboardEvent("keypress", opts));
        target.dispatchEvent(new KeyboardEvent("keyup", opts));
        if (!cancelled && key === "Enter") {
          const form = target.closest && target.closest("form");
          if (form) {
            if (typeof form.requestSubmit === "function") form.requestSubmit();
            else form.submit();
          } else if (target.tagName === "A" && target.href) {
            target.click();
          }
        }
        if (!cancelled && key === "Escape") {
          const dialog = document.querySelector("dialog[open]");
          if (dialog && typeof dialog.close === "function") dialog.close();
        }
        return { pressed: key };
      }

      case "text": {
        const el = qs(params.selector);
        return { text: el.innerText };
      }

      case "html": {
        const el = qs(params.selector);
        return { html: el.innerHTML };
      }

      case "attr": {
        const el = qs(params.selector, params.index);
        const name = params.name;
        if (!name) {
          const attrs = {};
          for (const a of el.attributes) attrs[a.name] = a.value;
          return { attributes: attrs };
        }
        return { [name]: el.getAttribute(name) };
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
          const text = (el.innerText || el.textContent || "").trim();
          if (text) item.text = text.substring(0, 200);
          if (el.id) item.id = el.id;
          if (el.className && typeof el.className === "string") item.class = el.className;
          if (el.href) item.href = el.href;
          if (el.src) item.src = el.src;
          if (el.getAttribute("aria-label")) item.ariaLabel = el.getAttribute("aria-label");
          if (el.getAttribute("data-test-id")) item.testId = el.getAttribute("data-test-id");
          items.push(item);
        }
        return { selector, total: els.length, items };
      }

      case "count": {
        const selector = params.selector;
        if (!selector) throw new Error("Missing 'selector' parameter");
        return { selector, count: document.querySelectorAll(selector).length };
      }

      case "extractUrl": {
        const el = qs(params.selector, params.index);
        const url = el.src || el.href || el.getAttribute("data-src") || el.currentSrc || null;
        return { url, tag: el.tagName.toLowerCase() };
      }

      case "scroll": {
        const target = params.target;
        const amount = params.amount;
        if (target === "up") {
          const px = amount || Math.round(window.innerHeight * 0.8);
          window.scrollBy(0, -px);
          return { scrolled: "up", pixels: px, scrollY: Math.round(window.scrollY) };
        } else if (target === "down") {
          const px = amount || Math.round(window.innerHeight * 0.8);
          window.scrollBy(0, px);
          return { scrolled: "down", pixels: px, scrollY: Math.round(window.scrollY) };
        } else if (target === "top") {
          window.scrollTo(0, 0);
          return { scrolled: "top", scrollY: 0 };
        } else if (target === "bottom") {
          window.scrollTo(0, document.documentElement.scrollHeight);
          return { scrolled: "bottom", scrollY: Math.round(window.scrollY) };
        } else {
          const el = qs(target);
          el.scrollIntoView({ block: "center", behavior: "instant" });
          return { scrolled: target, tag: el.tagName.toLowerCase(), scrollY: Math.round(window.scrollY) };
        }
      }

      case "select-option": {
        const el = qs(params.selector);
        if (el.tagName.toLowerCase() !== "select") {
          throw new Error(`Element is not a <select>: ${params.selector} (found <${el.tagName.toLowerCase()}>)`);
        }
        const value = params.value;
        const byText = params.byText;
        let found = false;
        for (const opt of el.options) {
          if (byText ? opt.text.trim() === value : opt.value === value) {
            el.value = opt.value;
            found = true;
            break;
          }
        }
        if (!found) {
          const available = Array.from(el.options).map((o) => ({ value: o.value, text: o.text.trim() }));
          throw new Error(`Option not found: "${value}" in ${params.selector}. Available: ${JSON.stringify(available)}`);
        }
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return { selected: value, selector: params.selector };
      }

      case "drag": {
        const source = qs(params.source);
        source.scrollIntoView({ block: "center", behavior: "instant" });
        const srcRect = source.getBoundingClientRect();
        const startX = srcRect.left + srcRect.width / 2;
        const startY = srcRect.top + srcRect.height / 2;

        let endX, endY, dropTarget;
        if (params.target) {
          const tgt = qs(params.target);
          tgt.scrollIntoView({ block: "center", behavior: "instant" });
          const tgtRect = tgt.getBoundingClientRect();
          endX = tgtRect.left + tgtRect.width / 2;
          endY = tgtRect.top + tgtRect.height / 2;
          dropTarget = tgt;
        } else {
          endX = startX + (params.dx || 0);
          endY = startY + (params.dy || 0);
          dropTarget = document.elementFromPoint(endX, endY) || document.body;
        }

        const dataTransfer = new DataTransfer();
        source.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true, clientX: startX, clientY: startY, dataTransfer }));
        dropTarget.dispatchEvent(new DragEvent("dragenter", { bubbles: true, cancelable: true, clientX: endX, clientY: endY, dataTransfer }));
        dropTarget.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true, clientX: endX, clientY: endY, dataTransfer }));
        dropTarget.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, clientX: endX, clientY: endY, dataTransfer }));
        source.dispatchEvent(new DragEvent("dragend", { bubbles: true, cancelable: true, clientX: endX, clientY: endY, dataTransfer }));

        return { dragged: params.source, to: params.target || `offset(${params.dx || 0}, ${params.dy || 0})` };
      }

      // -- Double-click --
      case "dblclick": {
        const el = qs(params.selector, params.index, params.text);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        const total = params.selector ? document.querySelectorAll(params.selector).length : 1;
        return { dblclicked: params.selector || "body", index: params.index ?? 0, total, text: params.text || null };
      }

      // -- Focus --
      case "focus": {
        const el = qs(params.selector, params.index, params.text);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.focus();
        return { focused: params.selector, tag: el.tagName.toLowerCase() };
      }

      // -- Checkbox: check / uncheck --
      case "check":
      case "uncheck": {
        const el = qs(params.selector, params.index, params.text);
        const shouldCheck = (op === "check");
        if (el.type === "checkbox" || el.type === "radio") {
          if (el.checked !== shouldCheck) {
            el.click();
          }
        } else {
          // ARIA checkbox / switch
          const current = el.getAttribute("aria-checked") === "true";
          if (current !== shouldCheck) {
            el.click();
          }
        }
        const checked = el.type === "checkbox" || el.type === "radio"
          ? el.checked
          : el.getAttribute("aria-checked") === "true";
        return { selector: params.selector, checked };
      }

      // -- Visibility check --
      case "is-visible": {
        const el = qs(params.selector, params.index);
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          parseFloat(style.opacity) !== 0 &&
          (rect.width > 0 || rect.height > 0);
        return { selector: params.selector, visible, rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) } };
      }

      // -- Get value (form elements) --
      case "get-value": {
        const el = qs(params.selector, params.index);
        const tag = el.tagName.toLowerCase();
        if (tag === "select") {
          const opt = el.options[el.selectedIndex];
          return { selector: params.selector, value: el.value, text: opt ? opt.text.trim() : null, selectedIndex: el.selectedIndex };
        }
        if (tag === "input" && (el.type === "checkbox" || el.type === "radio")) {
          return { selector: params.selector, value: el.value, checked: el.checked };
        }
        if ("value" in el) {
          return { selector: params.selector, value: el.value };
        }
        // contenteditable
        return { selector: params.selector, value: el.textContent || "" };
      }

      // -- Snapshot: list interactive elements with refs --
      case "snapshot": {
        // Clear previous refs
        document.querySelectorAll("[data-bctl-ref]").forEach((el) => el.removeAttribute("data-bctl-ref"));

        const onlyInteractive = params.interactive !== false;
        let refIndex = 0;
        const refs = {};
        const lines = [];

        const INTERACTIVE_TAGS = new Set(["a", "button", "input", "textarea", "select", "summary"]);
        const INTERACTIVE_ROLES = new Set([
          "button", "link", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
          "option", "checkbox", "radio", "switch", "textbox", "combobox",
          "searchbox", "slider", "spinbutton", "treeitem",
        ]);

        function isInteractive(el) {
          if (INTERACTIVE_TAGS.has(el.tagName.toLowerCase())) return true;
          const role = el.getAttribute("role");
          if (role && INTERACTIVE_ROLES.has(role)) return true;
          if (el.contentEditable === "true" || el.contentEditable === "plaintext-only") return true;
          if (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") return true;
          if (el.hasAttribute("onclick")) return true;
          return false;
        }

        function isVisible(el) {
          // body/html are always considered visible (root containers)
          if (el === document.body || el === document.documentElement) return true;
          // Skip hidden elements quickly — offsetParent is null for
          // display:none, detached elements, and <body>/<html> (handled above).
          if (!el.offsetParent && getComputedStyle(el).position !== "fixed" && getComputedStyle(el).position !== "sticky") return false;
          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden") return false;
          if (parseFloat(style.opacity) === 0) return false;
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) return false;
          return true;
        }

        function walk(el) {
          if (!isVisible(el)) return;
          const tag = el.tagName.toLowerCase();
          const interactive = isInteractive(el);

          if (!onlyInteractive || interactive) {
            const ref = `e${refIndex}`;
            el.setAttribute("data-bctl-ref", ref);

            // Build compact description line
            let desc = `[${ref}] ${tag}`;
            if (el.type && tag === "input") desc += `[type=${el.type}]`;
            if (el.id) desc += `#${el.id}`;
            const role = el.getAttribute("role");
            if (role) desc += `[role=${role}]`;

            const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
            if (text && text.length <= 60) desc += ` "${text}"`;
            else if (text) desc += ` "${text.substring(0, 57)}..."`;

            if (el.name) desc += ` name="${el.name}"`;
            if (el.placeholder) desc += ` placeholder="${el.placeholder}"`;
            if (tag === "a" && el.href) desc += ` href="${el.href}"`;
            if (el.getAttribute("aria-label")) desc += ` aria-label="${el.getAttribute("aria-label")}"`;

            lines.push(desc);
            refs[ref] = {
              tag,
              ...(el.type && { type: el.type }),
              ...(el.id && { id: el.id }),
              ...(role && { role }),
              ...(text && { text: text.substring(0, 100) }),
              ...(el.name && { name: el.name }),
              ...(tag === "a" && el.href && { href: el.href }),
            };
            refIndex++;
          }

          for (const child of el.children) {
            walk(child);
          }
        }

        walk(document.body);
        return { url: location.href, title: document.title, snapshot: lines.join("\n"), refs, total: refIndex };
      }

      default:
        throw new Error(`Unknown content operation: ${op}`);
    }
  }

  // -- Main loop: execute commands sequentially, stop on first error --
  const results = [];
  for (const { op, params } of commands) {
    try {
      if (op === "input-text") {
        // Character-by-character typing (async — needs delays between chars)
        const el = qs(params.selector, params.index, params.text);
        el.focus();
        el.scrollIntoView({ block: "center", behavior: "instant" });
        const inputText = params.inputText || "";
        const delay = params.delay || 10;

        if (params.clear) {
          if ("value" in el) {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
            if (nativeSetter) nativeSetter.call(el, "");
            else el.value = "";
          } else {
            // contenteditable
            el.textContent = "";
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }

        for (const char of inputText) {
          const keyOpts = { key: char, bubbles: true, cancelable: true };
          el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
          el.dispatchEvent(new KeyboardEvent("keypress", keyOpts));
          if ("value" in el) {
            el.value += char;
          } else {
            // contenteditable: use execCommand for best compatibility
            document.execCommand("insertText", false, char);
          }
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }

        el.dispatchEvent(new Event("change", { bubbles: true }));
        results.push({ success: true, data: { typed: inputText, selector: params.selector, characters: inputText.length } });
      } else if (op === "wait") {
        // Handle wait (sleep or selector polling) with async support
        if (params.seconds !== undefined && params.seconds !== null) {
          const seconds = parseFloat(params.seconds);
          await new Promise((r) => setTimeout(r, seconds * 1000));
          results.push({ success: true, data: { waited: seconds } });
        } else if (params.selector) {
          const timeout = (params.timeout ?? 5) * 1000;
          const start = Date.now();
          let found = false;
          while (Date.now() - start < timeout) {
            if (document.querySelector(params.selector)) {
              found = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          if (!found) {
            results.push({ success: false, error: `Timeout waiting for: ${params.selector}` });
            break;
          }
          const elapsed = Math.round((Date.now() - start) / 100) / 10;
          results.push({ success: true, data: { found: true, selector: params.selector, elapsed } });
        } else {
          results.push({ success: true, data: { waited: 0 } });
        }
      } else {
        const data = executeOp(op, params);
        results.push({ success: true, data });
      }
    } catch (e) {
      results.push({ success: false, error: String(e.message || e) });
      break;
    }
  }
  return results;
}
