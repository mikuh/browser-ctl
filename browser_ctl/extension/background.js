/**
 * background.js — Service worker entry point for Browser-Ctl extension.
 *
 * Maintains a WebSocket connection to the local bridge server and dispatches
 * incoming commands to the appropriate handler module.
 */

import { doClick } from "./click.js";
import {
  extractExecutionContext,
  stripExecutionContext,
  runInPage,
  doBatch,
  doNavigate,
  doBack,
  doForward,
  doReload,
  doTabs,
  doSwitchTab,
  doNewTab,
  doCloseTab,
  doStatus,
  doScreenshot,
  doDownload,
  doPress,
  doEval,
  doWait,
  doUpload,
  doDialog,
} from "./actions.js";

const WS_URL = "ws://127.0.0.1:19876/ws";
const ACTION_TIMEOUT_MS = 45000;
const SUPPORTED_ACTIONS = [
  "navigate", "back", "forward", "reload",
  "click", "hover", "type", "press",
  "text", "html", "attr", "select", "count", "status",
  "assert-url", "assert-field-value",
  "eval",
  "tabs", "tab", "new-tab", "close-tab",
  "screenshot", "download",
  "wait", "scroll", "select-option", "set-field", "submit-and-assert",
  "upload", "dialog", "drag", "snapshot",
  "dblclick", "focus", "check", "uncheck", "input-text",
  "is-visible", "get-value",
  "batch",
  "capabilities",
];

let ws = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30000;

// =========================================================================
// WebSocket lifecycle
// =========================================================================

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
    immediateReconnect();
  };

  ws.onerror = (e) => {
    console.warn("[bctl] WebSocket error:", e);
    // onclose will fire after this
  };
}

let _reconnectTimer = null;

function immediateReconnect() {
  const delay = reconnectDelay;
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);

  clearTimeout(_reconnectTimer);
  _reconnectTimer = setTimeout(() => {
    connect();
  }, delay);

  // Alarm backup in case SW is killed mid-retry
  chrome.alarms.create("bctl-reconnect", {
    delayInMinutes: Math.max(delay / 1000, 1) / 60,
  });
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
    if (!ws || ws.readyState > WebSocket.OPEN) {
      connect();
    }
  }
});

// Start connection on load
connect();

// Reconnect when service worker wakes up
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);

// Periodic keepalive alarm (30s minimum in production)
chrome.alarms.create("bctl-keepalive", { periodInMinutes: 0.5 });

// Fast keepalive via setTimeout — checks every 5s while SW is alive
function fastKeepalive() {
  if (!ws || ws.readyState > WebSocket.OPEN) {
    connect();
  }
  setTimeout(fastKeepalive, 5000);
}
setTimeout(fastKeepalive, 5000);

// =========================================================================
// Command dispatch
// =========================================================================

async function dispatch(cmd) {
  const { id, action, params } = cmd;
  const ctx = extractExecutionContext(params || {});
  const cleanParams = stripExecutionContext(params || {});
  try {
    const result = await executeActionWithPolicy(action, cleanParams, ctx);
    const data = typeof result === "object" && result !== null
      ? { ...result, __context: ctx }
      : result;
    return { id, success: true, data };
  } catch (e) {
    const classified = classifyActionError(action, e);
    return {
      id,
      success: false,
      error: formatActionError(action, e, classified.code),
      code: classified.code,
      retriable: classified.retriable,
      hint: classified.hint,
    };
  }
}

function formatActionError(action, err, code = null) {
  const message = String(err?.message || err || "Unknown error");
  if (message.startsWith("[") && message.includes("]") && !code) {
    return message;
  }
  if (code) {
    return `[${action}:${code}] ${message}`;
  }
  return `[${action}] ${message}`;
}

function isRetryableError(err) {
  const msg = String(err?.message || err || "").toLowerCase();
  return (
    msg.includes("no active tab") ||
    msg.includes("no tab with id") ||
    msg.includes("content script returned no result")
  );
}

function classifyActionError(action, err) {
  const msg = String(err?.message || err || "").toLowerCase();
  if (msg.includes("ref not found")) {
    return {
      code: "STALE_REF",
      retriable: true,
      hint: "Element refs may be stale after UI updates. Re-run `bctl snapshot` and retry.",
    };
  }
  if (msg.includes("timeout") || msg.includes(":timeout]")) {
    return {
      code: "TIMEOUT",
      retriable: true,
      hint: "Retry the action or increase wait timeout.",
    };
  }
  if (msg.includes("no active tab") || msg.includes("no tab with id")) {
    return {
      code: "TAB_CONTEXT",
      retriable: true,
      hint: "Refresh tab context by running tabs/status and retry.",
    };
  }
  if (msg.includes("element not found") || msg.includes("index") && msg.includes("out of range")) {
    return {
      code: "SELECTOR",
      retriable: false,
      hint: "Re-run snapshot/select and use a stable ref or selector.",
    };
  }
  if (action === "upload" || action === "eval") {
    return {
      code: "DEBUGGER",
      retriable: false,
      hint: "Close DevTools and retry.",
    };
  }
  return {
    code: "ACTION_FAILED",
    retriable: isRetryableError(err),
    hint: "Check command params and retry.",
  };
}

function shouldRetryAction(action) {
  // Lightweight retry only for actions that frequently hit transient tab state.
  return (
    action === "click" ||
    action === "hover" ||
    action === "type" ||
    action === "snapshot" ||
    action === "select" ||
    action === "text" ||
    action === "attr" ||
    action === "count" ||
    action === "set-field" ||
    action === "submit-and-assert"
  );
}

function withTimeout(promise, ms, label) {
  let timer = null;
  return new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`[${label}:timeout] Operation exceeded ${ms}ms`));
    }, ms);
    promise
      .then((value) => resolve(value))
      .catch((err) => reject(err))
      .finally(() => clearTimeout(timer));
  });
}

async function executeActionWithPolicy(action, params, ctx) {
  try {
    return await withTimeout(handleAction(action, params, ctx), ACTION_TIMEOUT_MS, action);
  } catch (e) {
    if (shouldRetryAction(action) && isRetryableError(e)) {
      await new Promise((r) => setTimeout(r, 120));
      return await withTimeout(handleAction(action, params, ctx), ACTION_TIMEOUT_MS, action);
    }
    throw e;
  }
}

async function handleAction(action, params, ctx) {
  switch (action) {
    // -- Navigation --
    case "navigate":
      return await doNavigate(params, ctx);
    case "back":
      return await doBack(params, ctx);
    case "forward":
      return await doForward(params, ctx);
    case "reload":
      return await doReload(params, ctx);

    // -- Interaction --
    case "click":
      return await doClick(params, ctx);
    case "hover":
      return await runInPage("hover", params, ctx);
    case "type":
      return await runInPage("type", params, ctx);
    case "press":
      return await doPress(params, ctx);

    // -- Query (content-script) --
    case "text":
      return await runInPage("text", params, ctx);
    case "html":
      return await runInPage("html", params, ctx);
    case "attr":
      return await runInPage("attr", params, ctx);
    case "select":
      return await runInPage("select", params, ctx);
    case "count":
      return await runInPage("count", params, ctx);
    case "status":
      return await doStatus(params, ctx);
    case "assert-url":
      return await runInPage("assert-url", params, ctx);
    case "assert-field-value":
      return await runInPage("assert-field-value", params, ctx);

    // -- JavaScript --
    case "eval":
      return await doEval(params, ctx);

    // -- Tabs --
    case "tabs":
      return await doTabs();
    case "tab":
      return await doSwitchTab(params);
    case "new-tab":
      return await doNewTab(params);
    case "close-tab":
      return await doCloseTab(params, ctx);

    // -- Screenshot / Download --
    case "screenshot":
      return await doScreenshot();
    case "download":
      return await doDownload(params, ctx);

    // -- Wait --
    case "wait":
      return await doWait(params, ctx);

    // -- Scroll --
    case "scroll":
      return await runInPage("scroll", params, ctx);

    // -- Form --
    case "select-option":
      return await runInPage("select-option", params, ctx);
    case "set-field":
      return await runInPage("set-field", params, ctx);
    case "submit-and-assert":
      return await runInPage("submit-and-assert", params, ctx);

    // -- Upload --
    case "upload":
      return await doUpload(params, ctx);

    // -- Dialog --
    case "dialog":
      return await doDialog(params, ctx);

    // -- Drag --
    case "drag":
      return await runInPage("drag", params, ctx);

    // -- Snapshot --
    case "snapshot":
      return await runInPage("snapshot", params, ctx);

    // -- Extra interaction --
    case "dblclick":
      return await runInPage("dblclick", params, ctx);
    case "focus":
      return await runInPage("focus", params, ctx);
    case "check":
      return await runInPage("check", params, ctx);
    case "uncheck":
      return await runInPage("uncheck", params, ctx);
    case "input-text":
      return await runInPage("input-text", params, ctx);

    // -- Extra query --
    case "is-visible":
      return await runInPage("is-visible", params, ctx);
    case "get-value":
      return await runInPage("get-value", params, ctx);

    // -- Batch --
    case "batch":
      return await doBatch(params, ctx);
    case "capabilities":
      return {
        actions: SUPPORTED_ACTIONS,
        protocolVersion: 2,
      };

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
