/**
 * content-script.js — Unified DOM operations handler for Browser-Ctl.
 *
 * Exports contentScriptHandler — a self-contained function that gets
 * serialized and injected into pages via chrome.scripting.executeScript.
 *
 * IMPORTANT: contentScriptHandler CANNOT reference any variables from the
 * outer module scope because it is serialized as a string and eval'd in
 * the page context.
 */

export { contentScriptHandler };

/**
 * Unified content-script handler — executes one or more DOM operations
 * inside the page context via a single chrome.scripting.executeScript call.
 *
 * @param {Array<{op: string, params: object}>} commands
 * @returns {Array<{success: boolean, data?: object, error?: string}>}
 */
async function contentScriptHandler(commands) {
  // ===================================================================
  // Deep query helpers for Shadow DOM support
  // ===================================================================

  function deepQueryOne(root, selector) {
    const found = root.querySelector(selector);
    if (found) return found;
    const els = root.querySelectorAll("*");
    for (let i = 0; i < els.length; i++) {
      if (els[i].shadowRoot) {
        const found = deepQueryOne(els[i].shadowRoot, selector);
        if (found) return found;
      }
    }
    return null;
  }

  function deepQueryAll(root, selector) {
    const results = Array.from(root.querySelectorAll(selector));
    const els = root.querySelectorAll("*");
    for (let i = 0; i < els.length; i++) {
      if (els[i].shadowRoot) {
        results.push(...deepQueryAll(els[i].shadowRoot, selector));
      }
    }
    return results;
  }

  // ===================================================================
  // Unified element query (Shadow DOM + text filter + ref support)
  // ===================================================================

  function qs(selector, index, textFilter) {
    if (!selector) return document.body;

    // Element ref support: "e0", "e1", … from snapshot
    if (/^e\d+$/.test(selector)) {
      const el = deepQueryOne(document, `[data-bctl-ref="${selector}"]`);
      if (!el)
        throw new Error(
          `Ref not found: ${selector} (run 'snapshot' first to assign refs)`
        );
      return el;
    }

    // Fast path: light DOM query
    let candidates = Array.from(document.querySelectorAll(selector));
    // Fallback: search through open shadow roots
    if (candidates.length === 0) {
      candidates = deepQueryAll(document, selector);
    }
    if (candidates.length === 0)
      throw new Error(`Element not found: ${selector}`);

    if (textFilter) {
      const lower = textFilter.toLowerCase();
      candidates = candidates.filter((el) => {
        const t = (el.innerText || el.textContent || "").toLowerCase();
        return t.includes(lower);
      });
      if (candidates.length === 0)
        throw new Error(
          `No element matching "${selector}" contains text "${textFilter}"`
        );
    }

    if (index !== undefined && index !== null) {
      const actual = index < 0 ? candidates.length + index : index;
      if (actual < 0 || actual >= candidates.length)
        throw new Error(
          `Index ${index} out of range (found ${candidates.length} elements for: ${selector})`
        );
      return candidates[actual];
    }
    return candidates[0];
  }

  // ===================================================================
  // Actionability checks (inspired by Playwright)
  // ===================================================================

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

  /** Hit-test: verify element receives pointer events at (cx, cy). */
  function hitTest(el, cx, cy) {
    const hitEl = document.elementFromPoint(cx, cy);
    if (!hitEl) return { pass: false, reason: "no element at coordinates" };
    if (el === hitEl || el.contains(hitEl)) return { pass: true };
    // Check if hitEl is inside the target (e.g. icon inside button)
    if (hitEl.contains && hitEl.contains(el)) return { pass: true };
    return {
      pass: false,
      reason: `obscured by <${hitEl.tagName.toLowerCase()}${hitEl.className ? "." + hitEl.className.split(" ")[0] : ""}>`,
    };
  }

  /**
   * Wait for element to pass actionability checks with progressive retry.
   * checks: { visible, enabled, stable, receivesEvents }
   * Returns: { pass: true } or { pass: false, reason: string }
   */
  async function ensureActionable(el, checks = {}, timeoutMs = 3000) {
    const RETRY_DELAYS = [0, 20, 100, 100, 500, 500, 500];
    const start = Date.now();

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (attempt > 0) {
        if (Date.now() - start > timeoutMs) break;
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
      }

      // Visible check
      if (checks.visible !== false && !checkVisible(el)) continue;

      // Enabled check
      if (checks.enabled && el.disabled) continue;

      // Stable check (two rAF frames, bounding box unchanged)
      if (checks.stable) {
        const rect1 = el.getBoundingClientRect();
        const stable = await new Promise((resolve) => {
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
        if (!stable) continue;
      }

      // Scroll into view
      el.scrollIntoView({ block: "center", behavior: "instant" });

      // Receives events check (hit-testing)
      if (checks.receivesEvents) {
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const hit = hitTest(el, cx, cy);
        if (!hit.pass) continue;
      }

      return { pass: true };
    }

    // Build failure reason
    if (checks.visible !== false && !checkVisible(el))
      return { pass: false, reason: "element not visible" };
    if (checks.enabled && el.disabled)
      return { pass: false, reason: "element is disabled" };

    // Check hit-test for reason
    if (checks.receivesEvents) {
      el.scrollIntoView({ block: "center", behavior: "instant" });
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const hit = hitTest(el, cx, cy);
      if (!hit.pass)
        return { pass: false, reason: `element does not receive pointer events: ${hit.reason}` };
    }

    return { pass: false, reason: "actionability timeout" };
  }

  // ===================================================================
  // Pointer/mouse event dispatch helper
  // ===================================================================

  function dispatchClickEvents(el) {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const mOpts = {
      bubbles: true,
      cancelable: true,
      clientX: cx,
      clientY: cy,
      button: 0,
      view: window,
    };
    // Full pointer/mouse sequence for SPA framework compatibility
    el.dispatchEvent(
      new PointerEvent("pointerdown", { ...mOpts, pointerId: 1 })
    );
    el.dispatchEvent(new MouseEvent("mousedown", mOpts));
    el.dispatchEvent(
      new PointerEvent("pointerup", { ...mOpts, pointerId: 1 })
    );
    el.dispatchEvent(new MouseEvent("mouseup", mOpts));
    // Single trusted click via el.click() — do NOT add synthetic MouseEvent("click")
    el.click();
    return { cx, cy };
  }

  // ===================================================================
  // Execute a single DOM operation
  // ===================================================================

  function executeOp(op, params) {
    switch (op) {
      case "click": {
        const el = qs(params.selector, params.index, params.text);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        dispatchClickEvents(el);
        const total = params.selector
          ? document.querySelectorAll(params.selector).length
          : 1;
        return {
          clicked: params.selector || "body",
          index: params.index ?? 0,
          total,
          text: params.text || null,
        };
      }

      case "hover": {
        const el = qs(params.selector, params.index, params.text);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const mOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy };
        el.dispatchEvent(new MouseEvent("mouseover", mOpts));
        el.dispatchEvent(
          new MouseEvent("mouseenter", { ...mOpts, bubbles: false })
        );
        el.dispatchEvent(new MouseEvent("mousemove", mOpts));
        return { hovered: params.selector, text: params.text || null };
      }

      case "type": {
        const el = qs(params.selector);
        el.focus();
        const text = params.text || "";
        if ("value" in el) {
          const proto =
            el instanceof HTMLTextAreaElement
              ? HTMLTextAreaElement.prototype
              : HTMLInputElement.prototype;
          const nativeSetter = Object.getOwnPropertyDescriptor(
            proto,
            "value"
          )?.set;
          if (nativeSetter) {
            // Clear
            nativeSetter.call(el, "");
            el.dispatchEvent(
              new InputEvent("beforeinput", {
                bubbles: true,
                cancelable: true,
                inputType: "deleteContent",
              })
            );
            el.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                inputType: "deleteContent",
              })
            );
            // Set value
            nativeSetter.call(el, text);
            el.dispatchEvent(
              new InputEvent("beforeinput", {
                bubbles: true,
                cancelable: true,
                inputType: "insertText",
                data: text,
              })
            );
            el.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                inputType: "insertText",
                data: text,
              })
            );
          } else {
            el.value = text;
            el.dispatchEvent(
              new InputEvent("input", {
                bubbles: true,
                inputType: "insertText",
                data: text,
              })
            );
          }
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else {
          // contenteditable
          el.textContent = text;
          el.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: text,
            })
          );
        }
        return { typed: text, selector: params.selector };
      }

      case "press": {
        const key = params.key;
        // Traverse shadow DOM to find actual focused element
        let target = document.activeElement || document.body;
        while (target.shadowRoot && target.shadowRoot.activeElement) {
          target = target.shadowRoot.activeElement;
        }
        const opts = { key, bubbles: true, cancelable: true };
        const cancelled = !target.dispatchEvent(
          new KeyboardEvent("keydown", opts)
        );
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
        const els = deepQueryAll(document, selector);
        const limit = params.limit || 20;
        const items = [];
        for (let i = 0; i < Math.min(els.length, limit); i++) {
          const el = els[i];
          const item = { index: i, tag: el.tagName.toLowerCase() };
          const text = (el.innerText || el.textContent || "").trim();
          if (text) item.text = text.substring(0, 200);
          if (el.id) item.id = el.id;
          if (el.className && typeof el.className === "string")
            item.class = el.className;
          if (el.href) item.href = el.href;
          if (el.src) item.src = el.src;
          if (el.getAttribute("aria-label"))
            item.ariaLabel = el.getAttribute("aria-label");
          if (el.getAttribute("data-test-id"))
            item.testId = el.getAttribute("data-test-id");
          items.push(item);
        }
        return { selector, total: els.length, items };
      }

      case "count": {
        const selector = params.selector;
        if (!selector) throw new Error("Missing 'selector' parameter");
        return { selector, count: deepQueryAll(document, selector).length };
      }

      case "extractUrl": {
        const el = qs(params.selector, params.index);
        const url =
          el.src ||
          el.href ||
          el.getAttribute("data-src") ||
          el.currentSrc ||
          null;
        return { url, tag: el.tagName.toLowerCase() };
      }

      case "scroll": {
        const target = params.target;
        const amount = params.amount;
        if (target === "up") {
          const px = amount || Math.round(window.innerHeight * 0.8);
          window.scrollBy(0, -px);
          return {
            scrolled: "up",
            pixels: px,
            scrollY: Math.round(window.scrollY),
          };
        } else if (target === "down") {
          const px = amount || Math.round(window.innerHeight * 0.8);
          window.scrollBy(0, px);
          return {
            scrolled: "down",
            pixels: px,
            scrollY: Math.round(window.scrollY),
          };
        } else if (target === "top") {
          window.scrollTo(0, 0);
          return { scrolled: "top", scrollY: 0 };
        } else if (target === "bottom") {
          window.scrollTo(0, document.documentElement.scrollHeight);
          return {
            scrolled: "bottom",
            scrollY: Math.round(window.scrollY),
          };
        } else {
          const el = qs(target);
          el.scrollIntoView({ block: "center", behavior: "instant" });
          return {
            scrolled: target,
            tag: el.tagName.toLowerCase(),
            scrollY: Math.round(window.scrollY),
          };
        }
      }

      case "select-option": {
        const el = qs(params.selector);
        if (el.tagName.toLowerCase() !== "select") {
          throw new Error(
            `Element is not a <select>: ${params.selector} (found <${el.tagName.toLowerCase()}>)`
          );
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
          const available = Array.from(el.options).map((o) => ({
            value: o.value,
            text: o.text.trim(),
          }));
          throw new Error(
            `Option not found: "${value}" in ${params.selector}. Available: ${JSON.stringify(available)}`
          );
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
        source.dispatchEvent(
          new DragEvent("dragstart", {
            bubbles: true,
            cancelable: true,
            clientX: startX,
            clientY: startY,
            dataTransfer,
          })
        );
        dropTarget.dispatchEvent(
          new DragEvent("dragenter", {
            bubbles: true,
            cancelable: true,
            clientX: endX,
            clientY: endY,
            dataTransfer,
          })
        );
        dropTarget.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            clientX: endX,
            clientY: endY,
            dataTransfer,
          })
        );
        dropTarget.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            clientX: endX,
            clientY: endY,
            dataTransfer,
          })
        );
        source.dispatchEvent(
          new DragEvent("dragend", {
            bubbles: true,
            cancelable: true,
            clientX: endX,
            clientY: endY,
            dataTransfer,
          })
        );

        return {
          dragged: params.source,
          to:
            params.target ||
            `offset(${params.dx || 0}, ${params.dy || 0})`,
        };
      }

      case "dblclick": {
        const el = qs(params.selector, params.index, params.text);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const mOpts = {
          bubbles: true,
          cancelable: true,
          clientX: cx,
          clientY: cy,
          button: 0,
          view: window,
        };
        el.dispatchEvent(new MouseEvent("dblclick", mOpts));
        const total = params.selector
          ? document.querySelectorAll(params.selector).length
          : 1;
        return {
          dblclicked: params.selector || "body",
          index: params.index ?? 0,
          total,
          text: params.text || null,
        };
      }

      case "focus": {
        const el = qs(params.selector, params.index, params.text);
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.focus();
        return { focused: params.selector, tag: el.tagName.toLowerCase() };
      }

      case "check":
      case "uncheck": {
        const el = qs(params.selector, params.index, params.text);
        const shouldCheck = op === "check";
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
        const checked =
          el.type === "checkbox" || el.type === "radio"
            ? el.checked
            : el.getAttribute("aria-checked") === "true";
        return { selector: params.selector, checked };
      }

      case "is-visible": {
        const el = qs(params.selector, params.index);
        const visible = checkVisible(el);
        const rect = el.getBoundingClientRect();
        return {
          selector: params.selector,
          visible,
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }

      case "get-value": {
        const el = qs(params.selector, params.index);
        const tag = el.tagName.toLowerCase();
        if (tag === "select") {
          const opt = el.options[el.selectedIndex];
          return {
            selector: params.selector,
            value: el.value,
            text: opt ? opt.text.trim() : null,
            selectedIndex: el.selectedIndex,
          };
        }
        if (
          tag === "input" &&
          (el.type === "checkbox" || el.type === "radio")
        ) {
          return {
            selector: params.selector,
            value: el.value,
            checked: el.checked,
          };
        }
        if ("value" in el) {
          return { selector: params.selector, value: el.value };
        }
        // contenteditable
        return { selector: params.selector, value: el.textContent || "" };
      }

      case "snapshot": {
        // Clear previous refs (including inside open shadow DOMs)
        function clearRefs(root) {
          root
            .querySelectorAll("[data-bctl-ref]")
            .forEach((el) => el.removeAttribute("data-bctl-ref"));
          root.querySelectorAll("*").forEach((el) => {
            if (el.shadowRoot) clearRefs(el.shadowRoot);
          });
        }
        clearRefs(document);

        const onlyInteractive = params.interactive !== false;
        let refIndex = 0;
        const refs = {};
        const lines = [];

        const INTERACTIVE_TAGS = new Set([
          "a",
          "button",
          "input",
          "textarea",
          "select",
          "summary",
        ]);
        const INTERACTIVE_ROLES = new Set([
          "button",
          "link",
          "tab",
          "menuitem",
          "menuitemcheckbox",
          "menuitemradio",
          "option",
          "checkbox",
          "radio",
          "switch",
          "textbox",
          "combobox",
          "searchbox",
          "slider",
          "spinbutton",
          "treeitem",
        ]);

        function isInteractive(el) {
          if (INTERACTIVE_TAGS.has(el.tagName.toLowerCase())) return true;
          const role = el.getAttribute("role");
          if (role && INTERACTIVE_ROLES.has(role)) return true;
          if (
            el.contentEditable === "true" ||
            el.contentEditable === "plaintext-only"
          )
            return true;
          if (
            el.hasAttribute("tabindex") &&
            el.getAttribute("tabindex") !== "-1"
          )
            return true;
          if (el.hasAttribute("onclick")) return true;
          return false;
        }

        function walk(el) {
          if (!checkVisible(el)) return;
          const tag = el.tagName.toLowerCase();
          const interactive = isInteractive(el);

          if (!onlyInteractive || interactive) {
            const ref = `e${refIndex}`;
            el.setAttribute("data-bctl-ref", ref);

            let desc = `[${ref}] ${tag}`;
            if (el.type && tag === "input") desc += `[type=${el.type}]`;
            if (el.id) desc += `#${el.id}`;
            const role = el.getAttribute("role");
            if (role) desc += `[role=${role}]`;

            const text = (el.innerText || el.textContent || "")
              .trim()
              .replace(/\s+/g, " ");
            if (text && text.length <= 60) desc += ` "${text}"`;
            else if (text) desc += ` "${text.substring(0, 57)}..."`;

            if (el.name) desc += ` name="${el.name}"`;
            if (el.placeholder) desc += ` placeholder="${el.placeholder}"`;
            if (tag === "a" && el.href) desc += ` href="${el.href}"`;
            if (el.getAttribute("aria-label"))
              desc += ` aria-label="${el.getAttribute("aria-label")}"`;

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
          // Traverse into open shadow DOMs
          if (el.shadowRoot) {
            for (const child of el.shadowRoot.children) {
              walk(child);
            }
          }
        }

        walk(document.body);
        return {
          url: location.href,
          title: document.title,
          snapshot: lines.join("\n"),
          refs,
          total: refIndex,
        };
      }

      default:
        throw new Error(`Unknown content operation: ${op}`);
    }
  }

  // ===================================================================
  // Main loop: execute commands, handle async ops specially
  // ===================================================================

  const results = [];
  for (const { op, params } of commands) {
    try {
      if (op === "input-text") {
        // Character-by-character typing (async)
        const el = qs(params.selector, params.index, params.text);
        el.focus();
        el.scrollIntoView({ block: "center", behavior: "instant" });
        const inputText = params.inputText || "";
        const delay = params.delay || 10;

        if (params.clear) {
          if ("value" in el) {
            const proto =
              el instanceof HTMLTextAreaElement
                ? HTMLTextAreaElement.prototype
                : HTMLInputElement.prototype;
            const nativeSetter = Object.getOwnPropertyDescriptor(
              proto,
              "value"
            )?.set;
            if (nativeSetter) nativeSetter.call(el, "");
            else el.value = "";
          } else {
            el.textContent = "";
          }
          el.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "deleteContent",
            })
          );
        }

        for (const char of inputText) {
          const keyOpts = { key: char, bubbles: true, cancelable: true };
          el.dispatchEvent(new KeyboardEvent("keydown", keyOpts));
          el.dispatchEvent(
            new InputEvent("beforeinput", {
              bubbles: true,
              cancelable: true,
              inputType: "insertText",
              data: char,
            })
          );
          if ("value" in el) {
            el.value += char;
          } else {
            // contenteditable: use Selection API instead of deprecated execCommand
            const sel = window.getSelection();
            if (sel && sel.rangeCount) {
              const range = sel.getRangeAt(0);
              range.deleteContents();
              range.insertNode(document.createTextNode(char));
              sel.collapseToEnd();
            } else {
              el.textContent += char;
            }
          }
          el.dispatchEvent(
            new InputEvent("input", {
              bubbles: true,
              inputType: "insertText",
              data: char,
            })
          );
          el.dispatchEvent(new KeyboardEvent("keyup", keyOpts));
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        }

        el.dispatchEvent(new Event("change", { bubbles: true }));
        results.push({
          success: true,
          data: {
            typed: inputText,
            selector: params.selector,
            characters: inputText.length,
          },
        });
      } else if (op === "wait") {
        // Wait: sleep or selector polling (async)
        if (params.seconds !== undefined && params.seconds !== null) {
          const seconds = parseFloat(params.seconds);
          await new Promise((r) => setTimeout(r, seconds * 1000));
          results.push({ success: true, data: { waited: seconds } });
        } else if (params.selector) {
          const timeout = (params.timeout ?? 5) * 1000;
          const start = Date.now();
          let found = false;
          while (Date.now() - start < timeout) {
            if (deepQueryOne(document, params.selector)) {
              found = true;
              break;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          if (!found) {
            results.push({
              success: false,
              error: `Timeout waiting for: ${params.selector}`,
            });
            break;
          }
          const elapsed = Math.round((Date.now() - start) / 100) / 10;
          results.push({
            success: true,
            data: { found: true, selector: params.selector, elapsed },
          });
        } else {
          results.push({ success: true, data: { waited: 0 } });
        }
      } else if (
        op === "click" ||
        op === "dblclick" ||
        op === "check" ||
        op === "uncheck"
      ) {
        // Interaction ops with full actionability checks
        const el = qs(
          params.selector || params.source,
          params.index,
          params.text
        );
        const check = await ensureActionable(el, {
          visible: true,
          stable: true,
          receivesEvents: true,
          enabled: true,
        });
        if (!check.pass) {
          results.push({
            success: false,
            error: `${op}: ${check.reason} for "${params.selector}"`,
          });
          break;
        }
        const data = executeOp(op, params);
        results.push({ success: true, data });
      } else if (op === "hover" || op === "drag") {
        // Hover/drag: visible + stable + receives events
        const el = qs(
          params.selector || params.source,
          params.index,
          params.text
        );
        const check = await ensureActionable(el, {
          visible: true,
          stable: true,
          receivesEvents: true,
        });
        if (!check.pass) {
          results.push({
            success: false,
            error: `${op}: ${check.reason} for "${params.selector || params.source}"`,
          });
          break;
        }
        const data = executeOp(op, params);
        results.push({ success: true, data });
      } else if (op === "type" || op === "focus") {
        // Type/focus: visible + enabled
        const el = qs(params.selector, params.index, params.text);
        const check = await ensureActionable(el, {
          visible: true,
          enabled: op === "type",
        });
        if (!check.pass) {
          results.push({
            success: false,
            error: `${op}: ${check.reason} for "${params.selector}"`,
          });
          break;
        }
        const data = executeOp(op, params);
        results.push({ success: true, data });
      } else {
        // All other ops: no actionability checks (query, scroll, etc.)
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
