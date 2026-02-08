# browser-ctl

CLI tool for browser automation. Control Chrome from the terminal via `bctl` commands.
All commands communicate through a Chrome extension + WebSocket bridge and return JSON.

## When to Use

Use browser-ctl when you need to:
- Navigate web pages, click elements, type text, press keys
- Query the DOM: get text, HTML, attributes, or count elements
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
```
bctl click <sel> [-i N]   Click element (CSS selector, optional index)
bctl hover <sel> [-i N]   Hover over element
bctl type <sel> <text>    Type text into element
bctl press <key>          Press key — Enter submits forms, Escape closes dialogs
bctl scroll <dir|sel> [n] Scroll page: up/down/top/bottom or element into view
bctl select-option <sel> <val> [--text]  Select <select> dropdown option (alias: sopt)
bctl drag <src> [target]  Drag element to target [--dx N --dy N for offset]
```

### Query
```
bctl text [sel]           Get text content (default: body)
bctl html [sel]           Get innerHTML
bctl attr <sel> [name]    Get attribute(s) [-i N for Nth element]
bctl select <sel> [-l N]  List matching elements (alias: sel, limit default: 20)
bctl count <sel>          Count matching elements
bctl status               Current page URL and title
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

# Click and type
bctl click "button.login"
bctl type "input[name=q]" "search query"
bctl press Enter

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
