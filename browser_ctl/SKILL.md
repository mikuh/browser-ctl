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
bctl ping
```

If extension is not connected, tell the user to check Chrome and the extension.

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
```

### JavaScript
```
bctl eval <code>          Execute JS in page context (MAIN world)
```

### Tabs
```
bctl tabs                 List all tabs (id, url, title, active)
bctl tab <id>             Switch to tab
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
bctl ping                 Check server and extension status
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

### SPA Video Sites (Tencent Video, Bilibili, etc.)
`bctl click` intercepts `window.open()` calls from SPA frameworks and opens the
target URL via `chrome.tabs.create`. Just click like a normal user:
```bash
bctl go "https://v.qq.com" && bctl wait 2
bctl type "input" "西游记" && bctl press Enter && bctl wait 3
bctl click ".root.list-item .poster-view" -i 0   # opens video in new tab
```

Fallback — extract content ID and navigate directly:
```bash
bctl attr ".root.list-item [dt-eid='poster']" "dt-params" | grep -o 'cid=[^&]*'
bctl go "https://v.qq.com/x/cover/<cid>.html"
```

### Waiting Strategy
- After navigation: `bctl wait 2-3` or `bctl wait "<selector>" 10`
- After hover for overlay: `bctl wait 1`
- AI generation: **poll** with `bctl wait 5 && bctl count "selector"` in a loop

### Data Extraction
Prefer `bctl select` over `bctl eval` — it's more reliable, works on all sites,
and returns text/href/id/class/aria-label automatically.

## Efficiency Tips

1. **NEVER screenshot to "see" the page.** Use `status` + `text` + `select` + `snapshot`.
2. **Use `count` before `click`** when you expect multiple matches.
3. **Use `download` for authenticated resources** — never `curl` from sites behind login.
4. **Use `hover` before clicking overlay buttons** — many UIs hide actions until hover.
5. **Check `tabs` after tab-opening actions** — popups may switch the active tab.
6. **Chain commands** with `&&`: `bctl go "https://example.com" && bctl wait 2 && bctl status`

## Known Limitations

- `eval` blocked by Trusted Types on some sites (Gemini, YouTube) — use `attr`/`select` instead
- `screenshot` captures visible viewport only — scroll for full-page capture
- Without `-i`, `click` always hits the FIRST match — use `count` to check first

## Error Handling

- `bctl ping` shows `"extension": false` → user must check Chrome and the extension
- Selector fails → use `bctl select` or `bctl count` to debug
- Dynamic content → use `bctl wait` before interacting
