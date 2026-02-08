# browser-ctl

**Control Chrome from your terminal.** A lightweight CLI tool for browser automation — navigate, click, type, scroll, screenshot, and more, all through simple commands.

```bash
pip install browser-ctl

bctl go https://github.com
bctl click "a.search-button"
bctl type "input[name=q]" "browser-ctl"
bctl press Enter
bctl screenshot results.png
```

## Why browser-ctl?

- **Zero-config CLI** — single `bctl` command, JSON output, works in any shell or script
- **No browser binary management** — uses your existing Chrome with a lightweight extension
- **Stdlib-only CLI** — the CLI itself has zero external Python dependencies
- **AI-agent friendly** — ships with an AI coding skill file (`SKILL.md`) for Cursor / OpenCode integration
- **Local & private** — all communication stays on `localhost`, no data leaves your machine

## How It Works

```
Terminal (bctl)  ──HTTP──▶  Bridge Server  ◀──WebSocket──  Chrome Extension
```

1. The **CLI** (`bctl`) sends commands via HTTP to a local bridge server
2. The **bridge server** relays them over WebSocket to the Chrome extension
3. The **extension** executes commands using Chrome APIs and content scripts
4. Results flow back the same path as JSON

The bridge server auto-starts on first command — no manual setup needed.

## Installation

### 1. Install the Python package

```bash
pip install browser-ctl
```

### 2. Load the Chrome extension

```bash
bctl setup
```

This copies the extension to `~/.browser-ctl/extension/` and opens Chrome's extension page. Then:

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `~/.browser-ctl/extension/` directory

### 3. Verify

```bash
bctl ping
```

You should see `{"success": true, "data": {"server": true, "extension": true}}`.

## Commands

### Navigation

```bash
bctl navigate <url>       # Navigate to URL (aliases: nav, go)
bctl back                 # Go back in history
bctl forward              # Go forward (alias: fwd)
bctl reload               # Reload current page
```

### Interaction

```bash
bctl click <sel> [-i N]           # Click element (CSS selector, optional Nth match)
bctl hover <sel> [-i N]           # Hover over element
bctl type <sel> <text>            # Type text into input/textarea
bctl press <key>                  # Press key (Enter, Escape, Tab, etc.)
bctl scroll <dir|sel> [pixels]    # Scroll: up/down/top/bottom or element into view
bctl select-option <sel> <val>    # Select dropdown option (alias: sopt) [--text]
bctl drag <src> [target]          # Drag to element or offset [--dx N --dy N]
```

### DOM Query

```bash
bctl text [sel]           # Get text content (default: body)
bctl html [sel]           # Get innerHTML
bctl attr <sel> [name]    # Get attribute(s) [-i N for Nth element]
bctl select <sel> [-l N]  # List matching elements (alias: sel, limit default: 20)
bctl count <sel>          # Count matching elements
bctl status               # Current page URL and title
```

### JavaScript

```bash
bctl eval <code>          # Execute JS in page context (auto-bypasses CSP)
```

### Tabs

```bash
bctl tabs                 # List all tabs
bctl tab <id>             # Switch to tab by ID
bctl new-tab [url]        # Open new tab
bctl close-tab [id]       # Close tab (default: active)
```

### Screenshot & Files

```bash
bctl screenshot [path]    # Capture screenshot (alias: ss)
bctl download <target>    # Download file/image (alias: dl) [-o file] [-i N]
bctl upload <sel> <files> # Upload file(s) to <input type="file">
```

### Wait & Dialog

```bash
bctl wait <sel|seconds>   # Wait for element or sleep [timeout]
bctl dialog [accept|dismiss] [--text <val>]  # Handle next alert/confirm/prompt
```

### Server

```bash
bctl ping                 # Check server & extension status
bctl serve                # Start server in foreground
bctl stop                 # Stop server
```

## Examples

### Search and extract

```bash
bctl go "https://news.ycombinator.com"
bctl select "a.titlelink" -l 5       # Top 5 links with text, href, etc.
```

### Fill a form

```bash
bctl type "input[name=email]" "user@example.com"
bctl type "input[name=password]" "hunter2"
bctl select-option "select#country" "US"
bctl upload "input[type=file]" ./resume.pdf
bctl click "button[type=submit]"
```

### Scroll and screenshot

```bash
bctl go "https://en.wikipedia.org/wiki/Web_browser"
bctl scroll down 1000
bctl ss page.png
```

### Handle dialogs

```bash
bctl dialog accept              # Set up handler BEFORE triggering
bctl click "#delete-button"     # This triggers a confirm() dialog
```

### Drag and drop

```bash
bctl drag ".task-card" ".done-column"
bctl drag ".range-slider" --dx 50 --dy 0
```

### Use in shell scripts

```bash
# Extract all image URLs from a page
bctl go "https://example.com"
bctl eval "JSON.stringify(Array.from(document.images).map(i=>i.src))"

# Wait for SPA content to load
bctl go "https://app.example.com/dashboard"
bctl wait ".dashboard-loaded" 15
bctl text ".metric-value"
```

## AI Agent Integration

browser-ctl ships with a `SKILL.md` file designed for AI coding assistants. Install it for your tool:

```bash
bctl setup cursor       # Install skill for Cursor IDE
bctl setup opencode     # Install skill for OpenCode
bctl setup /path/to/dir # Install to custom directory
```

Once installed, AI agents can use `bctl` commands to automate browser tasks on your behalf.

## Output Format

All commands return JSON to stdout:

```json
// Success
{"success": true, "data": {"url": "https://example.com", "title": "Example"}}

// Error
{"success": false, "error": "Element not found: .missing"}
```

Non-zero exit code on errors — works naturally with `set -e` and `&&` chains.

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Terminal                                       │
│  $ bctl click "button.submit"                   │
│       │                                         │
│       ▼ HTTP POST localhost:19876/command        │
│  ┌─────────────────────┐                        │
│  │   Bridge Server     │ (Python, aiohttp)      │
│  │   :19876            │                        │
│  └────────┬────────────┘                        │
│           │ WebSocket                           │
│           ▼                                     │
│  ┌─────────────────────┐                        │
│  │  Chrome Extension   │ (Manifest V3)          │
│  │  Service Worker     │                        │
│  └────────┬────────────┘                        │
│           │ chrome.scripting / chrome.debugger   │
│           ▼                                     │
│  ┌─────────────────────┐                        │
│  │  Web Page           │                        │
│  └─────────────────────┘                        │
└─────────────────────────────────────────────────┘
```

- **CLI** → stdlib only, communicates via HTTP
- **Bridge Server** → async relay (aiohttp), auto-daemonizes
- **Extension** → MV3 service worker, auto-reconnects via `chrome.alarms`
- **Eval** → dual strategy: MAIN-world injection (fast) with CDP fallback (CSP-safe)

## Requirements

- Python >= 3.11
- Chrome / Chromium with the extension loaded
- macOS, Linux, or Windows

## Privacy

All communication is local (`127.0.0.1`). No analytics, no telemetry, no external servers. See [PRIVACY.md](PRIVACY.md) for the full privacy policy.

## License

[MIT](LICENSE)
