/**
 * background.js — Service worker entry point for Browser-Ctl extension.
 *
 * Maintains a WebSocket connection to the local bridge server and dispatches
 * incoming commands to the appropriate handler module.
 */

import { doClick } from "./click.js";
import {
  activeTab,
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
  try {
    const result = await handleAction(action, params || {});
    return { id, success: true, data: result };
  } catch (e) {
    return { id, success: false, error: `[${action}] ${String(e.message || e)}` };
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

    // -- Interaction --
    case "click":
      return await doClick(params);
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

    // -- Batch --
    case "batch":
      return await doBatch(params);

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}
