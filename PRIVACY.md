# Privacy Policy — Browser-Ctl

**Last updated:** February 6, 2026

## Overview

Browser-Ctl is a developer tool that allows users to control their Chrome browser via command-line interface (CLI). This privacy policy explains what data the extension accesses and how it is handled.

## Data Collection

**Browser-Ctl does not collect, store, transmit, or share any personal data.**

Specifically:

- **No analytics or telemetry** — The extension does not include any tracking, analytics, or telemetry code.
- **No remote servers** — The extension only communicates with a local WebSocket server running on `localhost:19876` on the user's own machine. No data is sent to any external server.
- **No user accounts** — The extension does not require or support user accounts, sign-in, or registration.
- **No cookies or storage** — The extension does not read, write, or track browser cookies or local storage for its own purposes.

## Permissions Justification

The extension requests the following permissions, all of which are required for its core functionality as a browser automation tool:

| Permission | Why it is needed |
|------------|-----------------|
| `tabs` | To query, navigate, create, and close browser tabs via CLI commands |
| `scripting` | To execute DOM queries (click, type, select, text extraction) on the active page |
| `downloads` | To download files/images from web pages using the browser's authenticated session |
| `alarms` | To maintain the WebSocket connection to the local bridge server with automatic reconnection |
| `<all_urls>` (host permission) | To enable browser automation on any website the user visits — this is essential for a general-purpose browser automation tool |

## How It Works

1. The extension connects to a local WebSocket server (`ws://127.0.0.1:19876/ws`) running on the user's machine.
2. The user sends commands via the `bctl` CLI tool on their local terminal.
3. The CLI sends commands to the local server, which relays them to the extension.
4. The extension executes the commands (navigate, click, query, etc.) and returns results.

**All communication stays on the user's local machine.** No data leaves the device.

## Third-Party Services

Browser-Ctl does not integrate with or send data to any third-party services.

## Changes to This Policy

If this privacy policy is updated, the changes will be reflected in the extension's repository with an updated date.

## Contact

If you have questions about this privacy policy, please open an issue in the project's GitHub repository.
