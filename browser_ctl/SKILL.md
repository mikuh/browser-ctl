---
name: browser-ctl
description: Control the user's Chrome browser via CLI commands that return JSON. Use when the user asks to interact with a browser, navigate web pages, click elements, extract page content, take screenshots, download files, or perform any browser automation task.
---

# Browser-Ctl

Control Chrome via CLI. All commands return JSON to stdout.

## Prerequisites

- Chrome with the Browser-Ctl extension loaded
- Bridge server (auto-starts on first `bctl` command)

## Always Start With

```bash
bctl ensure-ready
```

`ensure-ready` auto-starts the local bridge server and will try to launch Chrome
if the extension is not connected yet.

Fallback diagnostics:

```bash
bctl ping
```

If it still shows `"extension": false`, tell the user to check Chrome and the extension.

## Core Principle: Text-First Page Perception

**NEVER use `bctl screenshot` to understand page state.** Use text-based commands:

1. `bctl status` — current URL + title
2. `bctl text "<sel>"` — read visible text
3. `bctl select "<sel>"` — discover page structure (tag, text, id, class, href, src, aria-label)
4. `bctl snapshot` — list all interactive elements with refs (e0, e1, …)
5. `bctl count "<sel>"` — check if elements exist and how many
6. `bctl attr "<sel>" "<name>"` — get specific attributes

Only use `bctl screenshot` when the user explicitly asks for a visual capture.

## Commands

### Navigation
```
bctl navigate <url>       Go to URL (aliases: nav, go; auto-prepends https://)
bctl back                 Go back
bctl forward              Go forward (alias: fwd)
bctl reload               Reload page
```

### Interaction
All `<sel>` accept CSS selectors or snapshot refs (e.g. `e5`).
```
bctl click <sel> [-i N] [-t text]    Click element; -t filters by visible text
bctl dblclick <sel> [-i N] [-t text] Double-click
bctl hover <sel> [-i N] [-t text]    Hover (triggers mouseover)
bctl focus <sel> [-i N] [-t text]    Focus element
bctl type <sel> <text>               Type text (replaces existing; React-compatible)
bctl input-text <sel> <text> [--clear] [--delay ms]  Char-by-char (rich editors)
bctl press <key>                     Press key: Enter, Escape, Tab, ArrowDown, etc.
bctl check <sel> [-i N] [-t text]    Check checkbox/radio
bctl uncheck <sel> [-i N] [-t text]  Uncheck checkbox
bctl scroll <dir|sel> [n]            Scroll: up/down/top/bottom/<selector> [pixels]
bctl select-option <sel> <val> [--text]  Select dropdown option (alias: sopt)
bctl drag <src> [target] [--dx N --dy N] Drag element to target or by offset
bctl set-field <sel> <value> [--no-clear] [--text]            Generic field setter
bctl submit-and-assert [sel] [--assert-selector CSS] [--assert-url EXP] [--mode ...] [--timeout s]
```

### Query
```
bctl snapshot [--all]     List interactive elements as e0, e1, … (alias: snap)
bctl text [sel]           Get text content (default: body)
bctl html [sel]           Get innerHTML
bctl attr <sel> [name]    Get attribute(s) [-i N for Nth element]
bctl select <sel> [-l N]  List matching elements (alias: sel, limit default: 20)
bctl count <sel>          Count matching elements
bctl status               Current page URL and title
bctl is-visible <sel>     Check if element is visible (returns rect)
bctl get-value <sel>      Get form element value (input/select/textarea)
bctl assert-url <exp> [--mode equals|includes|regex]          Assert current URL
bctl assert-field-value <sel> <exp> [--mode ...] [--by-text]  Assert field value/text
```

### JavaScript
```
bctl eval <code>          Execute JS in page context (MAIN world)
```

### Tabs
```
bctl tabs                 List all tabs (id, url, title, active, windowId)
bctl tab <id>             Switch to tab (also focuses the containing window)
bctl new-tab [url]        Open new tab
bctl close-tab [id]       Close tab (default: active)
```

### Screenshot & Download
```
bctl screenshot [path]    Capture screenshot (alias: ss)
bctl download <target>    Download file/image (alias: dl) [-o path] [-i N]
bctl upload <sel> <files> Upload file(s) to <input type="file">
```

Downloads use `chrome.downloads` API and carry the browser's full auth session — use
this instead of `curl` for sites requiring login.

### Wait
```
bctl wait <sel|seconds>   Wait for element or sleep [timeout]
```

### Dialog
```
bctl dialog [accept|dismiss] [--text <val>]  Handle next alert/confirm/prompt
```

### Batch / Pipe
```
bctl pipe                 Read commands from stdin (one per line, JSONL output)
bctl batch '<c1>' '<c2>'  Execute multiple commands in one call
```

Use `bctl pipe` for 2+ consecutive commands on the same page — merges into a single
browser call, reducing overhead by ~90%.

### Server
```
bctl ensure-ready         Ensure server + extension are ready (auto-launch Chrome)
bctl ping                 Check server and extension status
bctl capabilities         Show extension-supported actions
bctl self-test            Run generic end-to-end smoke checks
bctl serve                Start server (foreground)
bctl stop                 Stop server
```

## Output Format

All commands return JSON:
- Success: `{"success": true, "data": {...}}`
- Error: `{"success": false, "error": "..."}`

Parse with `jq`: `bctl status | jq -r '.data.title'`

## Best Practices

### Snapshot-first Workflow
Use `bctl snapshot` to get a numbered list of interactive elements, then operate by
ref. This eliminates guessing CSS selectors on unfamiliar pages:
```bash
bctl snapshot                    # List all interactive elements
bctl click e3                    # Click the 3rd element
bctl type e7 "hello world"      # Type into the 7th element
```

### Click by Text (SPA-friendly)
Use `-t` to filter by visible text — ideal for SPAs where class names are dynamic:
```bash
bctl click "button" -t "Submit"   # click button containing "Submit"
```

### Generic Submit + Assertion Flow
Prefer assertions after every important state change:
```bash
bctl click "button" -t "Open settings"
bctl set-field "input[name='displayName']" "Alice"
bctl submit-and-assert "button[type='submit']" --assert-selector ".toast-success" --timeout 8
bctl assert-field-value "input[name='displayName']" "Alice"
```

### GitHub Release (minimal, safe pattern)
When publishing a GitHub release (for workflows that auto-publish to PyPI), keep
the flow strict and verify each step:
```bash
bctl go "https://github.com/<owner>/<repo>/releases/new?tag=vX.Y.Z"   # preselect tag
bctl text "#ref-picker-releases-tag"                                   # must show "Tag: vX.Y.Z", not "Select tag"
bctl type "#release_name" "vX.Y.Z"
bctl type "#release_body" "Release vX.Y.Z ..."
bctl click "button" -t "Publish release"
bctl assert-url "/releases/tag/vX.Y.Z" --mode includes
```
Then confirm automation side effects separately (e.g. Actions run appears/completes,
and PyPI shows the new version).

### Waiting Strategy
- After navigation: `bctl wait 2-3` or `bctl wait "<selector>" 10`
- After hover for overlay: `bctl wait 1`
- AI generation: **poll** with `bctl wait 5 && bctl count "selector"` in a loop
- Pure sleep (`bctl wait N`) runs locally in Python — no extension round-trip, so it
  never times out even on heavy pages.

### Heavy SPA Pages
Heavy pages can cause the extension service worker to become unresponsive during
page load. To avoid timeouts:
- **Don't chain `bctl wait` with navigation via `&&`** — if the page is loading, the
  wait command may timeout because the extension is busy. Instead, run them separately:
  ```bash
  bctl go "https://example.com"
  bctl wait 3
  bctl status
  ```
- **Use `bctl go` instead of `bctl new-tab`** when you just need to navigate — it's
  more reliable because it reuses the current tab instead of creating a new one.
- **If `new-tab` times out but the tab was created**, use `bctl tabs` to find it and
  `bctl tab <id>` to switch to it.

### Multi-Window Awareness
`bctl tabs` returns tabs from ALL windows with `windowId` and `focusedWindowId`.
`bctl tab <id>` automatically focuses the containing window before activating the tab,
so cross-window tab switching works reliably.

When working with multiple windows:
- Check `windowId` in `bctl tabs` output to understand which window each tab belongs to
- `bctl tab <id>` handles cross-window switching automatically
- `bctl status` and `bctl snapshot` always operate on the active tab of the **focused** window

### SPA Form Interactions (React, Vue, Angular, etc.)
Modern SPA frameworks manage form state internally. **Never use `bctl eval` to set
form values or click buttons** — it bypasses the framework's event system:

```bash
# BAD — bypasses React state, the dropdown/filter won't actually update:
bctl eval "document.querySelector('input').value = 'hello'; ..."

# GOOD — triggers real keyboard events that React/Vue can observe:
bctl type "input" "hello"

# BAD — JS .click() doesn't fire full pointer+mouse sequence, SPA may ignore it:
bctl eval "document.querySelector('button').click()"

# GOOD — dispatches real mousedown/mouseup/click events:
bctl click "button" -t "Submit"
```

**`bctl type`** — sets value and fires focus/input/change events; works for most
React/Vue inputs including search filters and form fields.

**`bctl input-text`** — types character-by-character with real keydown/keypress/keyup
events; use for rich text editors, autocomplete fields, or when `type` doesn't trigger
the expected behavior. Add `--delay 50` if the app debounces input.

**Complex dropdowns/pickers** (tag selectors, date pickers, combo boxes):
1. `bctl click` to open the dropdown
2. `bctl wait 1` for the dropdown to render
3. `bctl type` into the filter/search input (NOT `bctl eval` with `value =`)
4. `bctl wait 1` for results to filter
5. `bctl click` on the target option (use `-t` for text matching)
6. **Verify** the selection: `bctl snapshot` or `bctl text` to confirm state changed

Always verify after complex interactions — if the state didn't change, retry with
`bctl input-text --delay 50` instead of `bctl type`.

### Data Extraction
Prefer `bctl select` over `bctl eval` — it's more reliable, works on all sites,
and returns text/href/id/class/aria-label automatically.

## Efficiency Tips

1. **NEVER screenshot to "see" the page.** Use `status` + `text` + `select` + `snapshot`.
2. **Use `count` before `click`** when you expect multiple matches.
3. **Use `download` for authenticated resources** — never `curl` from sites behind login.
4. **Use `hover` before clicking overlay buttons** — many UIs hide actions until hover.
5. **Check `tabs` after tab-opening actions** — popups may switch the active tab.
6. **Don't chain `&&` with `bctl wait` after navigation** — run them as separate commands.
7. **Prefer `bctl go` over `bctl new-tab`** for simple navigation — fewer failure modes.
8. **Never use `eval` to set input values or click buttons on SPA sites** — use `type`/`input-text`/`click`.
9. **Verify after complex UI interactions** — `snapshot` or `text` to confirm state changed.
10. **Use assertion primitives** — `assert-url`, `assert-field-value`, `submit-and-assert`.

## Universal Interaction Template

Use this sequence on any site:

1. `bctl ensure-ready`
2. `bctl status` and `bctl snapshot`
3. Prefer `eN` refs from snapshot when possible
4. Execute (`click`/`set-field`/`type`)
5. Assert (`assert-url` / `assert-field-value` / `count`)
6. Retry only when error is retriable; otherwise refresh snapshot and re-select

## Known Limitations

- `eval` may be blocked by Trusted Types/CSP on some pages — use `attr`/`select` instead
- `eval` with `input.value = ...` or `.click()` bypasses SPA framework state — use `type`/`click` instead
- `screenshot` captures visible viewport only — scroll for full-page capture
- Without `-i`, `click` always hits the FIRST match — use `count` to check first

## Error Handling

- `bctl ping` shows `"extension": false` → user must check Chrome and the extension
- Selector fails → use `bctl select` or `bctl count` to debug
- Dynamic content → use `bctl wait` before interacting
