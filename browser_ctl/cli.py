#!/usr/bin/env python3
"""browser-ctl CLI — control your browser from the terminal.

Zero external dependencies (stdlib only). Communicates with the bridge server
via HTTP POST to localhost:19876/command.
"""

import argparse
import base64
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

DEFAULT_PORT = 19876
SERVER_URL = f"http://127.0.0.1:{DEFAULT_PORT}"
PID_FILE = os.path.join(tempfile.gettempdir(), f"bctl-{DEFAULT_PORT}.pid")

# ---------------------------------------------------------------------------
# Server management
# ---------------------------------------------------------------------------


def is_server_running() -> bool:
	"""Check if bridge server is running."""
	if not os.path.exists(PID_FILE):
		return False
	try:
		with open(PID_FILE) as f:
			pid = int(f.read().strip())
		os.kill(pid, 0)
		return True
	except (OSError, ValueError):
		return False


def start_server() -> bool:
	"""Start bridge server as daemon. Returns True if started."""
	if is_server_running():
		return False

	cmd = [sys.executable, "-m", "browser_ctl.server", "--port", str(DEFAULT_PORT), "--daemon"]
	subprocess.Popen(
		cmd,
		start_new_session=True,
		stdout=subprocess.DEVNULL,
		stderr=subprocess.DEVNULL,
	)

	# Wait for server to become responsive
	for _ in range(60):  # 3 seconds max
		time.sleep(0.05)
		try:
			req = urllib.request.Request(f"{SERVER_URL}/health")
			resp = urllib.request.urlopen(req, timeout=0.5)
			if resp.status == 200:
				return True
		except Exception:
			pass

	print(json.dumps({"success": False, "error": "Failed to start bridge server"}))
	sys.exit(1)


def stop_server():
	"""Stop bridge server."""
	send_raw("shutdown", {})


def ensure_server():
	"""Make sure server is running, start if needed."""
	if not is_server_running():
		start_server()


# ---------------------------------------------------------------------------
# Command sending
# ---------------------------------------------------------------------------


def send_raw(action: str, params: dict) -> dict:
	"""Send command to bridge server, return parsed response."""
	body = json.dumps({"action": action, "params": params}).encode("utf-8")
	req = urllib.request.Request(
		f"{SERVER_URL}/command",
		data=body,
		headers={"Content-Type": "application/json"},
	)
	try:
		resp = urllib.request.urlopen(req, timeout=35)
		return json.loads(resp.read().decode("utf-8"))
	except urllib.error.URLError as e:
		return {"success": False, "error": f"Cannot connect to server: {e}"}
	except json.JSONDecodeError:
		return {"success": False, "error": "Invalid response from server"}


def send_command(action: str, params: dict):
	"""Ensure server, send command, print JSON result."""
	ensure_server()
	result = send_raw(action, params)
	print(json.dumps(result, ensure_ascii=False))
	if not result.get("success"):
		sys.exit(1)


# ---------------------------------------------------------------------------
# CLI definition
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
	parser = argparse.ArgumentParser(
		prog="bctl",
		description="Control your browser from the command line",
	)
	sub = parser.add_subparsers(dest="command", help="Available commands")

	# -- Navigation --
	p = sub.add_parser("navigate", aliases=["nav", "go"], help="Navigate to URL")
	p.add_argument("url", help="URL to navigate to")

	sub.add_parser("back", help="Go back in history")
	sub.add_parser("forward", aliases=["fwd"], help="Go forward in history")
	sub.add_parser("reload", help="Reload current page")

	# -- Interaction --
	p = sub.add_parser("click", help="Click an element")
	p.add_argument("selector", help="CSS selector")
	p.add_argument("-i", "--index", type=int, default=None, help="Click Nth matching element (0-based, negative from end)")

	p = sub.add_parser("hover", help="Hover over an element (trigger mouseover)")
	p.add_argument("selector", help="CSS selector")
	p.add_argument("-i", "--index", type=int, default=None, help="Hover Nth matching element (0-based)")

	p = sub.add_parser("type", help="Type text into an element")
	p.add_argument("selector", help="CSS selector")
	p.add_argument("text", help="Text to type")

	p = sub.add_parser("press", help="Press a keyboard key")
	p.add_argument("key", help="Key name (Enter, Escape, Tab, etc.)")

	# -- Query --
	p = sub.add_parser("text", help="Get text content of an element")
	p.add_argument("selector", nargs="?", default=None, help="CSS selector (default: body)")

	p = sub.add_parser("html", help="Get innerHTML of an element")
	p.add_argument("selector", nargs="?", default=None, help="CSS selector (default: body)")

	p = sub.add_parser("attr", help="Get attribute(s) of an element")
	p.add_argument("selector", help="CSS selector")
	p.add_argument("name", nargs="?", default=None, help="Attribute name (omit for all)")
	p.add_argument("-i", "--index", type=int, default=None, help="Get Nth matching element (0-based)")

	p = sub.add_parser("select", aliases=["sel"], help="Query all matching elements (returns summary of each)")
	p.add_argument("selector", help="CSS selector")
	p.add_argument("-l", "--limit", type=int, default=20, help="Max items to return (default: 20)")

	p = sub.add_parser("count", help="Count matching elements")
	p.add_argument("selector", help="CSS selector")

	sub.add_parser("status", help="Get current page URL and title")

	# -- JavaScript --
	p = sub.add_parser("eval", help="Execute JavaScript in page context")
	p.add_argument("code", help="JavaScript code to execute")

	# -- Tabs --
	sub.add_parser("tabs", help="List all open tabs")

	p = sub.add_parser("tab", help="Switch to a tab by ID")
	p.add_argument("id", type=int, help="Tab ID")

	p = sub.add_parser("new-tab", help="Open a new tab")
	p.add_argument("url", nargs="?", default=None, help="URL to open")

	p = sub.add_parser("close-tab", help="Close a tab")
	p.add_argument("id", nargs="?", type=int, default=None, help="Tab ID (default: active)")

	# -- Screenshot / Download --
	p = sub.add_parser("screenshot", aliases=["ss"], help="Capture screenshot")
	p.add_argument("path", nargs="?", default=None, help="Save to file path (default: print base64)")

	p = sub.add_parser("download", aliases=["dl"], help="Download a file/image using browser's auth session")
	p.add_argument("target", help="URL or CSS selector of an element (img, a, etc.)")
	p.add_argument("-o", "--output", default=None, help="Output filename (default: auto)")
	p.add_argument("-i", "--index", type=int, default=None, help="Download Nth matching element (0-based, negative from end)")

	# -- Wait --
	p = sub.add_parser("wait", help="Wait for element or sleep")
	p.add_argument("target", help="CSS selector or seconds to wait")
	p.add_argument("timeout", nargs="?", type=float, default=5, help="Timeout in seconds (default: 5)")

	# -- Server management --
	sub.add_parser("serve", help="Start bridge server (foreground)")
	sub.add_parser("ping", help="Check server and extension status")
	sub.add_parser("stop", help="Stop bridge server")

	return parser


# ---------------------------------------------------------------------------
# Command handlers
# ---------------------------------------------------------------------------


def handle_screenshot(args):
	"""Screenshot needs special handling for file save."""
	ensure_server()
	result = send_raw("screenshot", {})
	if not result.get("success"):
		print(json.dumps(result, ensure_ascii=False))
		sys.exit(1)

	if args.path:
		# Save to file
		b64 = result["data"]["base64"]
		img_bytes = base64.b64decode(b64)
		with open(args.path, "wb") as f:
			f.write(img_bytes)
		print(json.dumps({"success": True, "data": {"saved": args.path, "bytes": len(img_bytes)}}))
	else:
		print(json.dumps(result, ensure_ascii=False))


def handle_serve(args):
	"""Run server in foreground."""
	os.execvp(sys.executable, [sys.executable, "-m", "browser_ctl.server", "--port", str(DEFAULT_PORT)])


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
	parser = build_parser()
	args = parser.parse_args()

	if not args.command:
		parser.print_help()
		sys.exit(0)

	cmd = args.command

	# Aliases
	if cmd in ("nav", "go"):
		cmd = "navigate"
	if cmd == "fwd":
		cmd = "forward"
	if cmd in ("ss",):
		cmd = "screenshot"
	if cmd in ("sel",):
		cmd = "select"
	if cmd in ("dl",):
		cmd = "download"

	# Server management
	if cmd == "serve":
		handle_serve(args)
		return
	if cmd == "stop":
		stop_server()
		return

	# Screenshot (special handling)
	if cmd == "screenshot":
		handle_screenshot(args)
		return

	# Map CLI args to command params
	params = {}
	if cmd == "navigate":
		params = {"url": args.url}
	elif cmd == "click":
		params = {"selector": args.selector, "index": args.index}
	elif cmd == "hover":
		params = {"selector": args.selector, "index": args.index}
	elif cmd == "type":
		params = {"selector": args.selector, "text": args.text}
	elif cmd == "press":
		params = {"key": args.key}
	elif cmd == "text":
		params = {"selector": args.selector}
	elif cmd == "html":
		params = {"selector": args.selector}
	elif cmd == "attr":
		params = {"selector": args.selector, "name": args.name, "index": args.index}
	elif cmd == "select":
		params = {"selector": args.selector, "limit": args.limit}
	elif cmd == "count":
		params = {"selector": args.selector}
	elif cmd == "eval":
		params = {"code": args.code}
	elif cmd == "tab":
		params = {"id": args.id}
	elif cmd == "new-tab":
		params = {"url": args.url}
	elif cmd == "close-tab":
		params = {"id": args.id}
	elif cmd == "download":
		target = args.target
		if target.startswith("http://") or target.startswith("https://"):
			params = {"url": target, "filename": args.output}
		else:
			params = {"selector": target, "filename": args.output, "index": args.index}
	elif cmd == "wait":
		# Determine if target is a number (sleep) or selector
		try:
			seconds = float(args.target)
			params = {"seconds": seconds}
		except ValueError:
			params = {"selector": args.target, "timeout": args.timeout}

	send_command(cmd, params)


if __name__ == "__main__":
	main()
