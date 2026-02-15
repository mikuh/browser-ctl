/**
 * click.js — Unified click implementation for Browser-Ctl.
 *
 * Replaces the fragile 4-phase doClick with a single MAIN-world
 * executeScript call that includes:
 *   - Playwright-style actionability checks (visible, stable, hit-test, enabled)
 *   - Progressive retry loop
 *   - window.open interception for SPA sites
 *   - CDP fallback for sites requiring fully trusted events
 */

import { activeTab } from "./actions.js";

export { doClick };

async function doClick(params) {
  const tab = await activeTab();

  // Single MAIN-world executeScript — everything in one round trip
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: clickHandler,
    args: [params.selector, params.index, params.text],
    world: "MAIN",
  });

  const result = results[0]?.result;
  if (!result || !result.success) {
    // If actionability failed, try CDP fallback for fully trusted events
    if (result?.cx !== undefined && result?.cy !== undefined && result?.error?.includes("obscured")) {
      try {
        return await clickViaCDP(tab.id, result.cx, result.cy, params);
      } catch (_) {
        // CDP fallback failed too — throw original error
      }
    }
    throw new Error(result?.error || "Click failed");
  }

  // If window.open was intercepted, navigate via chrome.tabs
  if (result.capturedUrl) {
    await chrome.tabs.create({ url: result.capturedUrl, active: true });
  }

  return {
    clicked: params.selector || "body",
    index: params.index ?? 0,
    total: result.total,
    text: params.text || null,
  };
}

// =========================================================================
// CDP fallback — fully trusted mouse events via chrome.debugger
// =========================================================================

async function clickViaCDP(tabId, x, y, params) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (e) {
    if (e.message?.includes("Another debugger")) {
      throw new Error(
        "click: cannot attach debugger (DevTools may be open)."
      );
    }
    throw e;
  }

  try {
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });
  } finally {
    try {
      await chrome.debugger.detach({ tabId });
    } catch (_) {
      // ignore detach errors
    }
  }

  return {
    clicked: params.selector || "body",
    index: params.index ?? 0,
    total: 1,
    text: params.text || null,
    method: "cdp",
  };
}

// =========================================================================
// Self-contained click handler — injected into MAIN world
// =========================================================================

/**
 * This function is serialized and injected into the page.
 * It CANNOT reference any variables from the outer module scope.
 *
 * Flow:
 * 1. Find element (qs with Shadow DOM support)
 * 2. Actionability loop: visible → stable → scroll → hit-test → enabled
 * 3. Hook window.open
 * 4. Dispatch pointer/mouse events + el.click()
 * 5. Flush microtask queue
 * 6. Read captured URL, restore window.open
 * 7. Return result
 */
async function clickHandler(selector, index, textFilter) {
  // -- Deep query helpers --
  function deepQueryOne(root, sel) {
    const found = root.querySelector(sel);
    if (found) return found;
    const els = root.querySelectorAll("*");
    for (let i = 0; i < els.length; i++) {
      if (els[i].shadowRoot) {
        const f = deepQueryOne(els[i].shadowRoot, sel);
        if (f) return f;
      }
    }
    return null;
  }

  function deepQueryAll(root, sel) {
    const results = Array.from(root.querySelectorAll(sel));
    const els = root.querySelectorAll("*");
    for (let i = 0; i < els.length; i++) {
      if (els[i].shadowRoot) {
        results.push(...deepQueryAll(els[i].shadowRoot, sel));
      }
    }
    return results;
  }

  // -- Unified element query --
  function qs(sel, idx, tf) {
    if (!sel) return document.body;

    if (/^e\d+$/.test(sel)) {
      const el = deepQueryOne(document, `[data-bctl-ref="${sel}"]`);
      if (!el) throw new Error(`Ref not found: ${sel}`);
      return el;
    }

    let candidates = Array.from(document.querySelectorAll(sel));
    if (candidates.length === 0) candidates = deepQueryAll(document, sel);
    if (candidates.length === 0) throw new Error(`Element not found: ${sel}`);

    if (tf) {
      const lc = tf.toLowerCase();
      candidates = candidates.filter(
        (e) =>
          e.textContent && e.textContent.toLowerCase().includes(lc)
      );
      if (candidates.length === 0)
        throw new Error(
          `No element matching "${sel}" contains text "${tf}"`
        );
    }

    if (idx !== undefined && idx !== null) {
      const actual = idx < 0 ? candidates.length + idx : idx;
      if (actual < 0 || actual >= candidates.length)
        throw new Error(
          `Index ${idx} out of range (0..${candidates.length - 1}) for: ${sel}`
        );
      return candidates[actual];
    }
    return candidates[0];
  }

  // -- Actionability helpers --
  function checkVisible(el) {
    if (el === document.body || el === document.documentElement) return true;
    const style = getComputedStyle(el);
    if (style.display === "contents") return true;
    if (
      !el.offsetParent &&
      style.position !== "fixed" &&
      style.position !== "sticky"
    )
      return false;
    if (style.display === "none" || style.visibility === "hidden") return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function hitTest(el, cx, cy) {
    const hitEl = document.elementFromPoint(cx, cy);
    if (!hitEl) return { pass: false, reason: "no element at coordinates" };
    if (el === hitEl || el.contains(hitEl)) return { pass: true };
    if (hitEl.contains(el)) return { pass: true };
    return {
      pass: false,
      reason: `obscured by <${hitEl.tagName.toLowerCase()}${hitEl.className ? "." + String(hitEl.className).split(" ")[0] : ""}>`,
    };
  }

  /** Wait for bounding box to be stable across 2 rAF frames. */
  function waitForStable(el) {
    return new Promise((resolve) => {
      const rect1 = el.getBoundingClientRect();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const rect2 = el.getBoundingClientRect();
          resolve(
            Math.abs(rect1.left - rect2.left) < 1 &&
              Math.abs(rect1.top - rect2.top) < 1 &&
              Math.abs(rect1.width - rect2.width) < 1 &&
              Math.abs(rect1.height - rect2.height) < 1
          );
        });
      });
    });
  }

  // -- Main logic --
  try {
    const el = qs(selector, index, textFilter);
    const total = selector
      ? document.querySelectorAll(selector).length
      : 1;

    // Actionability retry loop (Playwright-style progressive delays)
    const RETRY_DELAYS = [0, 20, 100, 100, 500, 500, 500];
    let lastReason = "";
    let lastCx = 0;
    let lastCy = 0;

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }

      // 1. Visible
      if (!checkVisible(el)) {
        lastReason = "element not visible";
        continue;
      }

      // 2. Enabled
      if (el.disabled) {
        lastReason = "element is disabled";
        continue;
      }

      // 3. Stable (not animating)
      const stable = await waitForStable(el);
      if (!stable) {
        lastReason = "element is not stable (animating)";
        continue;
      }

      // 4. Scroll into view
      el.scrollIntoView({ block: "center", behavior: "instant" });
      // Small delay for scroll to settle
      await new Promise((r) => setTimeout(r, 0));

      // 5. Calculate center coordinates
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      lastCx = cx;
      lastCy = cy;

      // 6. Hit-test: verify element receives pointer events
      const hit = hitTest(el, cx, cy);
      if (!hit.pass) {
        lastReason = `element does not receive pointer events: ${hit.reason}`;
        continue;
      }

      // All checks passed — perform the click

      // Hook window.open to capture popup URLs
      const origOpen = window.open;
      let capturedUrl = null;
      window.open = function (url) {
        if (url && typeof url === "string" && url.startsWith("http")) {
          capturedUrl = url;
        }
        return null;
      };

      try {
        // Dispatch full pointer/mouse sequence with coordinates
        const mOpts = {
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
          button: 0,
          view: window,
        };
        el.dispatchEvent(
          new PointerEvent("pointerdown", { ...mOpts, pointerId: 1 })
        );
        el.dispatchEvent(new MouseEvent("mousedown", mOpts));
        el.dispatchEvent(
          new PointerEvent("pointerup", { ...mOpts, pointerId: 1 })
        );
        el.dispatchEvent(new MouseEvent("mouseup", mOpts));

        // Single trusted click
        el.click();

        // Wait for microtask queue to flush (async handlers like window.open)
        await new Promise((r) => setTimeout(r, 50));
      } finally {
        // Restore window.open
        window.open = origOpen;
      }

      return { success: true, total, capturedUrl };
    }

    // All retries exhausted
    return {
      success: false,
      error: `click: actionability check failed for "${selector}": ${lastReason}`,
      cx: lastCx,
      cy: lastCy,
    };
  } catch (e) {
    return { success: false, error: e.message || String(e) };
  }
}
