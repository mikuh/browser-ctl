<p align="right">
  <strong>English</strong> | <a href="README_CN.md">中文</a>
</p>

<h1 align="center">browser-ctl</h1>

<p align="center">
  <strong>Browser automation built for AI agents.</strong><br>
  Give your LLM a real Chrome browser — with your sessions, cookies, and extensions — through simple CLI commands.
</p>

<p align="center">
  <a href="https://pypi.org/project/browser-ctl/"><img alt="PyPI" src="https://img.shields.io/pypi/v/browser-ctl?color=blue"></a>
  <a href="https://pypi.org/project/browser-ctl/"><img alt="Python" src="https://img.shields.io/pypi/pyversions/browser-ctl"></a>
  <a href="https://github.com/mikuh/browser-ctl/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/github/license/mikuh/browser-ctl"></a>
</p>

<br>

```bash
pip install browser-ctl

bctl go https://github.com
bctl snapshot                        # List interactive elements → e0, e1, e2, …
bctl click e3                        # Click by ref — no CSS selector needed
bctl type e5 "browser-ctl"          # Type into element by ref
bctl press Enter
bctl screenshot results.png
```

<br>

## The Problem with Existing Browser Automation

Tools like [browser-use](https://github.com/browser-use/browser-use), [Playwright MCP](https://github.com/microsoft/playwright-mcp), and [Puppeteer](https://github.com/puppeteer/puppeteer) are powerful, but they share a set of pain points when used with AI agents:

| Pain point | Typical tools | browser-ctl |
|---|---|---|
| **Heavy browser binaries** — must download and manage a bundled Chromium (~400 MB) | Playwright, Puppeteer | Uses your existing Chrome — zero browser downloads |
| **No access to real sessions** — launches a fresh, empty browser with no cookies, logins, or extensions | browser-use, Playwright MCP | Controls your real Chrome — all sessions, cookies, and extensions intact |
| **Anti-bot detection** — headless browsers are flagged and blocked by many websites | Puppeteer, Playwright | Uses your real browser profile — indistinguishable from normal browsing |
| **Complex SDK integration** — requires importing libraries and writing async code | browser-use, Stagehand | Pure CLI with JSON output — any LLM can call `bctl click "button"` |
| **Heavy dependencies** — Playwright alone pulls ~50 MB of packages + browser binary | Playwright, Puppeteer | CLI is stdlib-only; server needs only `aiohttp` |
| **Token-inefficient for LLMs** — verbose API calls waste context window tokens | SDK-based tools | Concise commands: `bctl text h1` vs pages of boilerplate |
| **Broken clicks on SPAs** — programmatic clicks get blocked by popup blockers | Puppeteer, Playwright | Intercepts `window.open()` and navigates via `chrome.tabs` — SPA-compatible |

<br>

## Designed for LLM Agents

browser-ctl is purpose-built for AI agent workflows:

- **Snapshot-first workflow** — `bctl snapshot` lists interactive elements as `e0`, `e1`, … then operate by ref (`bctl click e3`) — no CSS selector guessing
- **Tool-calling ready** — every command is a single shell call returning structured JSON, perfect for function-calling / tool-use patterns
- **Built-in AI skill** — ships with `SKILL.md` that teaches AI agents (Cursor, OpenCode, etc.) the full command set and best practices
- **Real browser = real access** — your LLM can operate on authenticated pages (Gmail, Jira, internal tools) without credential management
- **Deterministic output** — JSON responses with element refs or CSS selectors, no vision model needed for most tasks
- **Minimal token cost** — `bctl snapshot` + `bctl click e5` vs multi-step screenshot → vision → parse loops

```bash
# Install the AI skill for Cursor IDE in one command
bctl setup cursor
```

<br>

## How It Works

```
AI Agent / Terminal  ──HTTP──▶  Bridge Server  ◀──WebSocket──  Chrome Extension
     (bctl CLI)                  (:19876)                      (your browser)
```

1. **CLI** (`bctl`) sends commands via HTTP to a local bridge server
2. **Bridge server** relays them over WebSocket to the Chrome extension
3. **Extension** executes commands using Chrome APIs & content scripts in your real browser
4. Results flow back the same path as JSON

> The bridge server auto-starts on first command — no manual setup needed.

<br>

## Installation

**Step 1** — Install the Python package:

```bash
pip install browser-ctl
```

**Step 2** — Load the Chrome extension:

```bash
bctl setup
```

Then in Chrome: `chrome://extensions` → Enable **Developer mode** → **Load unpacked** → select `~/.browser-ctl/extension/`

**Step 3** — Verify:

```bash
bctl ensure-ready
# {"success": true, "data": {"server": true, "extension": true}}
```

<br>

## Command Reference

### Navigation

| Command | Description |
|---------|-------------|
| `bctl navigate <url>` | Navigate to URL &nbsp; *(aliases: `nav`, `go`; auto-prepends `https://`)* |
| `bctl back` | Go back in history |
| `bctl forward` | Go forward &nbsp; *(alias: `fwd`)* |
| `bctl reload` | Reload current page |

### Interaction

All `<sel>` arguments accept CSS selectors **or** element refs from `snapshot` (e.g. `e5`).

| Command | Description |
|---------|-------------|
| `bctl click <sel> [-i N] [-t text]` | Click element; `-t` filters by visible text (substring) |
| `bctl dblclick <sel> [-i N] [-t text]` | Double-click element |
| `bctl hover <sel> [-i N] [-t text]` | Hover over element; `-t` filters by visible text |
| `bctl focus <sel> [-i N] [-t text]` | Focus element |
| `bctl type <sel> <text>` | Type text into input/textarea (React-compatible, replaces value) |
| `bctl input-text <sel> <text>` | Char-by-char typing for rich text editors `[--clear] [--delay ms]` |
| `bctl press <key>` | Press key — Enter submits forms, Escape closes dialogs |
| `bctl check <sel> [-i N] [-t text]` | Check a checkbox or radio button |
| `bctl uncheck <sel> [-i N] [-t text]` | Uncheck a checkbox |
| `bctl scroll <dir\|sel> [px]` | Scroll: `up` / `down` / `top` / `bottom` or element into view |
| `bctl select-option <sel> <val>` | Select dropdown option &nbsp; *(alias: `sopt`)* `[--text]` |
| `bctl drag <src> [target]` | Drag to element or offset `[--dx N --dy N]` |

### DOM Query

| Command | Description |
|---------|-------------|
| `bctl snapshot [--all]` | List interactive elements with refs `e0`, `e1`, … &nbsp; *(alias: `snap`)* |
| `bctl text [sel]` | Get text content (default: `body`) |
| `bctl html [sel]` | Get innerHTML |
| `bctl attr <sel> [name] [-i N]` | Get attribute(s) of element |
| `bctl select <sel> [-l N]` | List matching elements &nbsp; *(alias: `sel`)* |
| `bctl count <sel>` | Count matching elements |
| `bctl status` | Current page URL and title |
| `bctl is-visible <sel> [-i N]` | Check if element is visible (returns bounding rect) |
| `bctl get-value <sel> [-i N]` | Get value of form element (input / select / textarea) |

### JavaScript

| Command | Description |
|---------|-------------|
| `bctl eval <code>` | Execute JS in page context (auto-bypasses CSP) |

### Tabs

| Command | Description |
|---------|-------------|
| `bctl tabs` | List all tabs |
| `bctl tab <id>` | Switch to tab by ID |
| `bctl new-tab [url]` | Open new tab |
| `bctl close-tab [id]` | Close tab (default: active) |

### Screenshot & Files

| Command | Description |
|---------|-------------|
| `bctl screenshot [path]` | Capture screenshot &nbsp; *(alias: `ss`)* |
| `bctl download <target> [-o path] [-i N]` | Download file/image &nbsp; *(alias: `dl`; `-o` supports absolute paths)* |
| `bctl upload <sel> <files...>` | Upload file(s) to `<input type="file">` |

### Wait & Dialog

| Command | Description |
|---------|-------------|
| `bctl wait <sel\|seconds> [timeout]` | Wait for element or sleep |
| `bctl dialog [accept\|dismiss] [--text val]` | Handle next alert / confirm / prompt |

### Batch / Pipe

| Command | Description |
|---------|-------------|
| `bctl pipe` | Read commands from stdin, one per line (JSONL output). Consecutive DOM ops are auto-batched into a single browser call |
| `bctl batch '<cmd1>' '<cmd2>' ...` | Execute multiple commands in one call with smart batching |

### Server

| Command | Description |
|---------|-------------|
| `bctl ensure-ready` | Ensure server + extension are ready (auto-starts server, auto-launches Chrome if needed) |
| `bctl ping` | Check server & extension status |
| `bctl capabilities` | Show actions supported by the connected extension |
| `bctl self-test` | Run generic end-to-end smoke tests for core skill actions |
| `bctl serve` | Start server in foreground |
| `bctl stop` | Stop server |
| `bctl setup` | Install extension to `~/.browser-ctl/extension/` + open Chrome extensions page |
| `bctl setup cursor` | Install AI skill (`SKILL.md`) into Cursor IDE |
| `bctl setup opencode` | Install AI skill into OpenCode |
| `bctl setup <path>` | Install AI skill to a custom directory |

<br>

## Examples

<details open>
<summary><b>Snapshot workflow (recommended for AI agents)</b></summary>

```bash
bctl go "https://example.com"
bctl snapshot                          # List all interactive elements as e0, e1, …
bctl click e3                          # Click by ref — no CSS selector needed
bctl type e5 "hello world"            # Type into element by ref
bctl get-value e5                      # Read form value
bctl is-visible e3                     # Check visibility
```
</details>

<details>
<summary><b>Search and extract</b></summary>

```bash
bctl go "https://news.ycombinator.com"
bctl select "a.titlelink" -l 5       # Top 5 links with text, href, etc.
```
</details>

<details>
<summary><b>Click by visible text (SPA-friendly)</b></summary>

```bash
bctl click "button" -t "Sign in"        # Click button containing "Sign in"
bctl click "a" -t "Settings"            # Click link containing "Settings"
bctl click "div[role=button]" -t "Save" # Works with any element + text filter
```
</details>

<details>
<summary><b>Fill a form</b></summary>

```bash
bctl type "input[name=email]" "user@example.com"
bctl type "input[name=password]" "hunter2"
bctl select-option "select#country" "US"
bctl upload "input[type=file]" ./resume.pdf
bctl click "button[type=submit]"
```
</details>

<details>
<summary><b>Scroll and screenshot</b></summary>

```bash
bctl go "https://en.wikipedia.org/wiki/Web_browser"
bctl scroll down 1000
bctl ss page.png
```
</details>

<details>
<summary><b>Handle dialogs</b></summary>

```bash
bctl dialog accept              # Set up handler BEFORE triggering
bctl click "#delete-button"     # This triggers a confirm() dialog
```
</details>

<details>
<summary><b>Drag and drop</b></summary>

```bash
bctl drag ".task-card" ".done-column"
bctl drag ".range-slider" --dx 50 --dy 0
```
</details>

<details>
<summary><b>Batch / Pipe (fast multi-step)</b></summary>

```bash
# Pipe mode: multiple commands in one call, auto-batched
bctl pipe <<'EOF'
click "button" -t "Select tag"
wait 1
type "input[placeholder='Search']" "v1.0.0"
wait 1
click "button" -t "Create new tag"
EOF

# Batch mode: same thing as arguments
bctl batch \
  'click "button" -t "Sign in"' \
  'wait 1' \
  'type "#email" "user@example.com"' \
  'type "#password" "secret"' \
  'click "button[type=submit]"'
```
</details>

<details>
<summary><b>Shell scripting</b></summary>

```bash
# Extract all image URLs from a page
bctl go "https://example.com"
bctl eval "JSON.stringify(Array.from(document.images).map(i=>i.src))"

# Wait for SPA content to load
bctl go "https://app.example.com/dashboard"
bctl wait ".dashboard-loaded" 15
bctl text ".metric-value"
```
</details>

<br>

## Output Format

All commands return JSON to stdout:

```jsonc
// Success
{"success": true, "data": {"url": "https://example.com", "title": "Example"}}

// Error
{"success": false, "error": "Element not found: .missing"}
```

Non-zero exit code on errors — works naturally with `set -e` and `&&` chains.

<br>

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  AI Agent / Terminal                                │
│  $ bctl click "button.submit"                       │
│       │                                             │
│       ▼  HTTP POST localhost:19876/command           │
│  ┌──────────────────────┐                           │
│  │   Bridge Server      │  (Python, aiohttp)        │
│  │   :19876             │                           │
│  └──────────┬───────────┘                           │
│             │  WebSocket                            │
│             ▼                                       │
│  ┌──────────────────────┐                           │
│  │  Chrome Extension    │  (Manifest V3)            │
│  │  Service Worker      │                           │
│  └──────────┬───────────┘                           │
│             │  chrome.scripting / chrome.debugger    │
│             ▼                                       │
│  ┌──────────────────────┐                           │
│  │  Your Real Browser   │  (sessions, cookies, etc) │
│  └──────────────────────┘                           │
└─────────────────────────────────────────────────────┘
```

| Component | Details |
|-----------|---------|
| **CLI** | Stdlib only, raw-socket HTTP (zero heavy imports, ~5ms cold start) |
| **Bridge Server** | Async relay (aiohttp), auto-daemonizes |
| **Extension** | MV3 service worker, auto-reconnects via `chrome.alarms` |
| **Click** | Three-phase: pointer events → MAIN-world click → `window.open()` interception for SPA compatibility |
| **Eval** | Dual strategy: MAIN-world injection (fast) + CDP fallback (CSP-safe) |

<br>

## Requirements

- Python >= 3.11
- Chrome / Chromium with the extension loaded
- macOS, Linux, or Windows

## Privacy

All communication is local (`127.0.0.1`). No analytics, no telemetry, no external servers. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)
