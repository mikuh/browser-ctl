---
name: browser-ctl
description: CLI tool for browser automation. Control Chrome from the terminal via bctl commands. Navigate pages, click elements, type text, snapshot interactive elements, query DOM, take screenshots, download files, manage tabs, and execute JavaScript — all through a Chrome extension + WebSocket bridge returning JSON.
---

# browser-ctl

CLI tool for browser automation. Control Chrome from the terminal via `bctl` commands.
All commands communicate through a Chrome extension + WebSocket bridge and return JSON.

## When to Use

Use browser-ctl when you need to:
- Navigate web pages, click elements, type text, press keys
- Snapshot interactive elements and operate them by ref (e0, e1, …)
- Query the DOM: get text, HTML, attributes, values, or count elements
- Take screenshots or download files (preserves browser auth/cookies)
- Execute arbitrary JavaScript in the page context
- Manage browser tabs (list, switch, open, close)
- Automate browser workflows for testing or data extraction

## Prerequisites

- Chrome with the Browser-Ctl extension loaded
- Bridge server (auto-starts with any `bctl` command)

## Commands

### Navigation
```
bctl navigate <url>       Navigate to URL (aliases: nav, go; auto-prepends https://)
bctl back                 Go back
bctl forward              Go forward (alias: fwd)
bctl reload               Reload page
```

### Interaction
All `<sel>` arguments accept CSS selectors or element refs (e.g. `e5` from `snapshot`).
```
bctl click <sel> [-i N] [-t text]    Click element; -t filters by visible text (substring)
bctl dblclick <sel> [-i N] [-t text] Double-click element
bctl hover <sel> [-i N] [-t text]    Hover over element
bctl focus <sel> [-i N] [-t text]    Focus element
bctl type <sel> <text>               Type text (replaces existing; React-compatible)
bctl input-text <sel> <text> [--clear] [--delay ms]  Char-by-char typing (rich text editors)
bctl press <key>                     Press key — Enter submits forms, Escape closes dialogs
bctl check <sel> [-i N] [-t text]    Check checkbox/radio
bctl uncheck <sel> [-i N] [-t text]  Uncheck checkbox
bctl scroll <dir|sel> [n]            Scroll page: up/down/top/bottom or element into view
bctl select-option <sel> <val> [--text]  Select <select> dropdown option (alias: sopt)
bctl drag <src> [target]             Drag element to target [--dx N --dy N for offset]
```

### Query
```
bctl snapshot [--all]     List interactive elements with refs e0, e1, … (alias: snap)
bctl text [sel]           Get text content (default: body)
bctl html [sel]           Get innerHTML
bctl attr <sel> [name]    Get attribute(s) [-i N for Nth element]
bctl select <sel> [-l N]  List matching elements (alias: sel, limit default: 20)
bctl count <sel>          Count matching elements
bctl status               Current page URL and title
bctl is-visible <sel>     Check if element is visible (returns rect)
bctl get-value <sel>      Get value of form element (input/select/textarea)
```

### JavaScript
```
bctl eval <code>          Execute JS in page context
```

### Tabs
```
bctl tabs                 List all tabs
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

## Tips & Best Practices

### Snapshot-first Workflow (recommended for AI agents)
- **Use `bctl snapshot` to get a numbered list of interactive elements**, then operate
  by ref (e.g. `bctl click e5`). This eliminates guessing CSS selectors.
- Refs are assigned as `data-bctl-ref` attributes and persist until the next snapshot.
- Example:
  ```bash
  bctl snapshot                    # List all interactive elements
  bctl click e3                    # Click the 3rd interactive element
  bctl type e7 "hello world"      # Type into the 7th element
  bctl input-text e7 "hello" --clear --delay 20  # Char-by-char for rich editors
  ```

### Data Extraction
- **Prefer `bctl select` over `bctl eval`** for extracting structured DOM data — it's
  more reliable across all sites, returns text/href/id/class/aria-label automatically,
  and doesn't require complex JS strings.
- Use `bctl text <sel>` for simple text extraction and `bctl attr <sel> [name]` for
  specific attributes. Chain with `-i N` for Nth element.
- Reserve `bctl eval` for cases that truly need complex JS logic (e.g. mapping/filtering,
  accessing page-defined variables, or computing derived values).

### Search & Scrape Workflow
A typical pattern for searching a site and extracting results:
```bash
bctl go "https://site.com/search?q=keyword"      # Navigate
bctl wait ".results" 10                           # Wait for results
bctl select ".result-item a" -l 10                # Extract links
bctl attr ".result-item a" href -i 0              # Get specific attribute
```

### Waiting Strategy
- Always `bctl wait <selector> [timeout]` or `bctl wait <seconds>` after navigation
  before querying — SPAs like YouTube take time to render content.
- Prefer waiting for a specific element over a fixed delay when possible.

### Clicking by Text (SPA-friendly)
- Use `--text` (`-t`) to filter elements by visible text — ideal for SPAs (React,
  Vue, etc.) where CSS class names are dynamically generated and unreliable.
- Example: `bctl click "button" -t "Submit"` clicks the first `<button>` whose
  visible text contains "Submit" (case-insensitive substring match).
- This avoids fragile selectors like `button.css-1a2b3c4` and eliminates the need
  for `bctl eval 'document.querySelector(...).click()'` workarounds.

### Batch / Pipe (prefer for multi-step workflows)
- **Always use `bctl pipe` when performing 2+ consecutive commands** on the same
  page. Consecutive DOM operations (click, type, scroll, wait…) are automatically
  merged into a single browser call, reducing overhead by ~90%.
- Pipe reads from stdin, one command per line (`#` comments and blank lines OK).
  Each line is a normal bctl command without the `bctl` prefix.
- Output is JSONL — one JSON object per command.
- Example (fill a form in one shot):
  ```
  bctl pipe <<'EOF'
  type "#email" "user@example.com"
  type "#password" "secret"
  click "button[type=submit]"
  EOF
  ```

### Shell Quoting
- Wrap CSS selectors in double quotes: `bctl click "button.submit"`
- For `bctl eval`, use double quotes for the outer string and single quotes inside:
  `bctl eval "document.querySelector('h1').textContent"`

## Examples

```bash
# Navigate and inspect
bctl go https://example.com
bctl status
bctl text h1

# Snapshot workflow (recommended)
bctl snapshot                       # See all interactive elements as e0, e1, …
bctl click e3                       # Click element by ref
bctl type e5 "hello"                # Type into element by ref
bctl get-value e5                   # Read form value
bctl is-visible e3                  # Check visibility

# Click by selector or by text
bctl click "button.login"
bctl click "button" -t "Sign in"           # click button containing "Sign in"
bctl dblclick "td.cell"                    # double-click
bctl type "input[name=q]" "search query"
bctl press Enter

# Character-by-character input (rich text editors, contenteditable)
bctl input-text "div[contenteditable]" "hello" --clear --delay 20

# Checkbox / radio
bctl check "input#agree"
bctl uncheck "input#newsletter"

# Scroll a long page
bctl scroll down              # Scroll down ~80% viewport
bctl scroll down 500          # Scroll down 500px
bctl scroll up                # Scroll up
bctl scroll top               # Scroll to top
bctl scroll bottom            # Scroll to bottom
bctl scroll "#section-3"      # Scroll element into view

# Form interaction
bctl select-option "select#country" "US"           # Select by value
bctl select-option "select#lang" "English" --text  # Select by visible text
bctl upload "input[type=file]" ./photo.jpg          # Upload file

# Handle dialogs (call BEFORE triggering action)
bctl dialog accept               # Auto-accept next alert/confirm
bctl dialog dismiss              # Dismiss next confirm
bctl dialog accept --text "yes"  # Answer next prompt with "yes"

# Drag and drop
bctl drag ".card-1" ".column-done"          # Drag to target element
bctl drag ".slider-handle" --dx 100 --dy 0  # Drag by pixel offset

# Wait then screenshot
bctl wait ".loaded" 10
bctl ss page.png

# Download with browser auth
bctl download "https://site.com/file.pdf" -o file.pdf

# Extract structured data (prefer select over eval)
bctl select "a.video-link" -l 10
bctl eval "JSON.stringify(Array.from(document.querySelectorAll('a')).slice(0,5).map(a=>({text:a.textContent.trim(),href:a.href})))"
```
