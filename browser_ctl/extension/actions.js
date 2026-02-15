/**
 * actions.js — Chrome API action handlers for Browser-Ctl.
 *
 * Handles navigation, tabs, screenshot, eval, download, upload, dialog,
 * wait, and the runInPage/doBatch helpers for content-script operations.
 */

import { contentScriptHandler } from "./content-script.js";

// =========================================================================
// Shared helpers
// =========================================================================

/** Get the currently active tab. */
export async function activeTab(context = {}) {
  if (context.tabId !== undefined && context.tabId !== null) {
    return await getTabOrThrow(context.tabId);
  }

  const query = { active: true };
  if (context.windowId !== undefined && context.windowId !== null) {
    query.windowId = context.windowId;
  } else {
    query.currentWindow = true;
  }

  const [tab] = await chrome.tabs.query(query);
  if (!tab) throw new Error("No active tab");
  return tab;
}

export function extractExecutionContext(params = {}) {
  const embedded = params.__context && typeof params.__context === "object"
    ? params.__context
    : {};

  const parseId = (v) => {
    if (v === undefined || v === null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  const worldRaw = String(
    embedded.world ?? params.world ?? "ISOLATED"
  ).toUpperCase();
  const world = worldRaw === "MAIN" ? "MAIN" : "ISOLATED";

  return {
    sessionId: String(embedded.sessionId ?? params.sessionId ?? "default"),
    tabId: parseId(embedded.tabId ?? params.tabId),
    windowId: parseId(embedded.windowId ?? params.windowId),
    world,
  };
}

export function stripExecutionContext(params = {}) {
  const clean = { ...params };
  delete clean.__context;
  delete clean.sessionId;
  delete clean.tabId;
  delete clean.windowId;
  delete clean.world;
  return clean;
}

/**
 * Return a live tab by id, or throw a stable error.
 */
async function getTabOrThrow(tabId) {
  if (tabId === undefined || tabId === null) {
    throw new Error("Missing tab id");
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch (_) {
    throw new Error(`No tab with id: ${tabId}.`);
  }
}

/**
 * Wait for a tab to finish loading after navigation.
 * Returns { loaded: boolean, timedOut: boolean } so callers can decide.
 */
export async function waitForTabLoad(tabId, timeoutMs = 10000) {
  // Fast path: avoid race where tab already finished loading.
  const existing = await getTabOrThrow(tabId);
  if (existing.status === "complete") {
    return { loaded: true, timedOut: false };
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(value);
    };

    const timer = setTimeout(() => {
      finish({ loaded: false, timedOut: true });
    }, timeoutMs);

    function onUpdated(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        finish({ loaded: true, timedOut: false });
      }
    }

    function onRemoved(removedTabId) {
      if (removedTabId === tabId) {
        finish({ loaded: false, timedOut: false, removed: true });
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

// =========================================================================
// Content-script injection helpers
// =========================================================================

/**
 * Run a single DOM operation in the active tab.
 * Wraps the command as a 1-element batch and extracts the first result.
 * Includes lightweight retry for transient service-worker issues.
 */
export async function runInPage(op, params, context = extractExecutionContext(params)) {
  const tab = await activeTab(context);
  await getTabOrThrow(tab.id);
  const opParams = stripExecutionContext(params || {});

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: contentScriptHandler,
        args: [[{ op, params: opParams }]],
        world: context.world || "ISOLATED",
      });

      const arr = results[0]?.result;
      if (!arr || !arr.length) {
        if (attempt === 0) continue; // Retry once
        throw new Error("Content script returned no result");
      }
      const r = arr[0];
      if (!r.success)
        throw new Error(r.error || "Content script operation failed");
      return r.data;
    } catch (e) {
      if (attempt === 0 && e.message?.includes("no result")) continue;
      throw e;
    }
  }
}

/**
 * Execute multiple DOM operations in a single executeScript call.
 * Called by the "batch" action.
 */
export async function doBatch(params, context = extractExecutionContext(params)) {
  const commands = params.commands || [];
  if (!commands.length) return { results: [] };

  const tab = await activeTab(context);
  await getTabOrThrow(tab.id);
  const ops = commands.map((c) => ({ op: c.action, params: c.params }));

  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: contentScriptHandler,
    args: [ops],
    world: context.world || "ISOLATED",
  });

  const arr = results[0]?.result;
  if (!arr) throw new Error("Batch content script returned no result");
  return { results: arr };
}

// =========================================================================
// Navigation commands
// =========================================================================

export async function doNavigate(params, context = extractExecutionContext(params)) {
  const url = params.url;
  if (!url) throw new Error("Missing 'url' parameter");
  const tab = await activeTab(context);
  await chrome.tabs.update(tab.id, { url });
  await waitForTabLoad(tab.id);
  const updated = await getTabOrThrow(tab.id);
  return { url: updated.url, title: updated.title };
}

export async function doBack(params = {}, context = extractExecutionContext(params)) {
  const tab = await activeTab(context);
  await chrome.tabs.goBack(tab.id);
  await waitForTabLoad(tab.id);
  const updated = await getTabOrThrow(tab.id);
  return { url: updated.url, title: updated.title };
}

export async function doForward(params = {}, context = extractExecutionContext(params)) {
  const tab = await activeTab(context);
  await chrome.tabs.goForward(tab.id);
  await waitForTabLoad(tab.id);
  const updated = await getTabOrThrow(tab.id);
  return { url: updated.url, title: updated.title };
}

export async function doReload(params = {}, context = extractExecutionContext(params)) {
  const tab = await activeTab(context);
  await chrome.tabs.reload(tab.id);
  await waitForTabLoad(tab.id);
  const updated = await getTabOrThrow(tab.id);
  return { url: updated.url, title: updated.title };
}

// =========================================================================
// Tab commands
// =========================================================================

export async function doTabs() {
  const tabs = await chrome.tabs.query({});
  const focusedWindow = await chrome.windows.getLastFocused();
  return {
    tabs: tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.active,
      windowId: t.windowId,
    })),
    focusedWindowId: focusedWindow.id,
  };
}

export async function doSwitchTab(params) {
  const tabId = parseInt(params.id, 10);
  if (isNaN(tabId)) throw new Error("Missing or invalid 'id' parameter");
  const tab = await getTabOrThrow(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });
  const updated = await getTabOrThrow(tabId);
  return {
    id: updated.id,
    url: updated.url,
    title: updated.title,
    windowId: updated.windowId,
  };
}

export async function doNewTab(params) {
  const tab = await chrome.tabs.create({ url: params.url || "about:blank" });
  if (params.url) await waitForTabLoad(tab.id);
  const updated = await getTabOrThrow(tab.id);
  return { id: updated.id, url: updated.url, title: updated.title };
}

export async function doCloseTab(params, context = extractExecutionContext(params)) {
  const tabId = params.id ? parseInt(params.id, 10) : (await activeTab(context)).id;
  await chrome.tabs.remove(tabId);
  return { closed: tabId };
}

// =========================================================================
// Status / Screenshot
// =========================================================================

export async function doStatus(params = {}, context = extractExecutionContext(params)) {
  const tab = await activeTab(context);
  return { url: tab.url, title: tab.title, id: tab.id };
}

export async function doScreenshot() {
  const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: "png" });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, "");
  return { format: "png", base64 };
}

// =========================================================================
// Download
// =========================================================================

export async function doDownload(params, context = extractExecutionContext(params)) {
  const { url, selector, filename, index } = params;

  let downloadUrl = url;

  if (selector && !url) {
    const result = await runInPage("extractUrl", { selector, index }, context);
    downloadUrl = result.url;
    if (!downloadUrl)
      throw new Error(`No downloadable URL found on element: ${selector}`);
  }

  if (!downloadUrl)
    throw new Error("Missing 'url' or 'selector' parameter");

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

  const info = await waitForDownload(downloadId);
  return info;
}

function waitForDownload(downloadId, timeoutMs = 30000) {
  return new Promise((resolve) => {
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
        resolve({
          downloadId,
          state: "failed",
          error: delta.error?.current,
        });
      }
    }
    chrome.downloads.onChanged.addListener(listener);
  });
}

// =========================================================================
// Press key
// =========================================================================

export async function doPress(params, context = extractExecutionContext(params)) {
  const key = params.key;
  if (!key) throw new Error("Missing 'key' parameter");
  return await runInPage("press", { key }, context);
}

// =========================================================================
// Eval (script injection with CDP fallback)
// =========================================================================

export async function doEval(params, context = extractExecutionContext(params)) {
  const code = params.code;
  if (!code) throw new Error("Missing 'code' parameter");
  const tab = await activeTab(context);

  // Strategy 1: MAIN world <script> tag injection (fast path)
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (userCode) => {
      const key = "__bctl_r_" + Math.random().toString(36).slice(2);
      const script = document.createElement("script");
      script.textContent =
        "try{window['" +
        key +
        "']={v:(0,eval)(" +
        JSON.stringify(userCode) +
        ")}}" +
        "catch(e){window['" +
        key +
        "']={e:e.message||String(e)}}";
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

  // Strategy 2: Chrome DevTools Protocol via chrome.debugger (CSP fallback)
  return await evalViaDebugger(tab.id, code);
}

async function evalViaDebugger(tabId, code) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    if (e.message?.includes("Another debugger")) {
      throw new Error(
        "eval: cannot attach debugger (DevTools may be open). Close DevTools and retry, or use 'bctl select'/'bctl text' for DOM queries."
      );
    }
    throw new Error("eval: cannot attach debugger — " + (e.message || e));
  }

  try {
    const result = await chrome.debugger.sendCommand(
      { tabId },
      "Runtime.evaluate",
      { expression: code, returnByValue: true, awaitPromise: false }
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

// =========================================================================
// Wait
// =========================================================================

export async function doWait(params, context = extractExecutionContext(params)) {
  const selector = params.selector;
  const timeout = params.timeout ?? 5;

  if (!selector) {
    const seconds = parseFloat(params.seconds ?? params.selector ?? timeout);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    return { waited: seconds };
  }

  return await runInPage("wait", { selector, timeout }, context);
}

// =========================================================================
// Upload (via Chrome DevTools Protocol)
// =========================================================================

export async function doUpload(params, context = extractExecutionContext(params)) {
  const { selector, files } = params;
  if (!selector) throw new Error("Missing 'selector' parameter");
  if (!files || !files.length) throw new Error("Missing 'files' parameter");

  const tab = await activeTab(context);

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

// =========================================================================
// Dialog handling
// =========================================================================

export async function doDialog(params, context = extractExecutionContext(params)) {
  const accept = params.accept !== false;
  const text = params.text || "";

  const tab = await activeTab(context);

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (shouldAccept, responseText) => {
      const origAlert = window.alert;
      const origConfirm = window.confirm;
      const origPrompt = window.prompt;

      function restore() {
        window.alert = origAlert;
        window.confirm = origConfirm;
        window.prompt = origPrompt;
      }

      window.alert = function (message) {
        window.__bctl_last_dialog = {
          type: "alert",
          message: String(message),
        };
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
        const value = shouldAccept
          ? responseText || defaultValue || ""
          : null;
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
