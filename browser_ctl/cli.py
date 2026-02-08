#!/usr/bin/env python3
"""browser-ctl CLI — control your browser from the terminal.

Zero external dependencies (stdlib only). Communicates with the bridge server
via HTTP POST to localhost:19876/command.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import platform
import shutil
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

BCTL_HOME = os.path.join(os.path.expanduser("~"), ".browser-ctl")

SKILL_TARGETS = {
	"cursor": os.path.join(os.path.expanduser("~"), ".cursor", "skills-cursor"),
	"opencode": os.path.join(os.path.expanduser("~"), ".config", "opencode", "skills"),
}

# ---------------------------------------------------------------------------
# Server management
# ---------------------------------------------------------------------------


def is_server_running() -> bool:
	"""Check if bridge server is running (PID exists AND HTTP health check passes)."""
	if not os.path.exists(PID_FILE):
		return False
	try:
		with open(PID_FILE) as f:
			pid = int(f.read().strip())
		os.kill(pid, 0)  # Check process exists
	except (OSError, ValueError):
		return False
	# Process exists — verify it is actually accepting HTTP connections.
	# This avoids a race where the PID is still alive but the server is
	# shutting down (port already closed).
	try:
		req = urllib.request.Request(f"{SERVER_URL}/health")
		resp = urllib.request.urlopen(req, timeout=1)
		return resp.status == 200
	except Exception:
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
	"""Stop bridge server and print JSON result."""
	if not is_server_running():
		print(json.dumps({"success": True, "data": {"stopped": False, "message": "Server is not running"}}))
		return
	result = send_raw("shutdown", {})
	if result.get("success"):
		# Wait briefly for server to fully stop and clean up PID file
		for _ in range(20):
			time.sleep(0.05)
			if not is_server_running():
				break
		print(json.dumps({"success": True, "data": {"stopped": True}}))
	else:
		print(json.dumps(result, ensure_ascii=False))


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

	# -- Scroll --
	p = sub.add_parser("scroll", help="Scroll the page")
	p.add_argument("target", help="Direction (up/down/top/bottom) or CSS selector to scroll into view")
	p.add_argument("amount", nargs="?", type=int, default=None, help="Pixels to scroll (for up/down)")

	# -- Form interaction --
	p = sub.add_parser("select-option", aliases=["sopt"], help="Select option in <select> dropdown")
	p.add_argument("selector", help="CSS selector for <select> element")
	p.add_argument("value", help="Option value or text to select")
	p.add_argument("--text", action="store_true", help="Match by visible text instead of value")

	# -- File upload --
	p = sub.add_parser("upload", help="Upload file(s) to file input")
	p.add_argument("selector", help="CSS selector for file input")
	p.add_argument("files", nargs="+", help="File path(s) to upload")

	# -- Dialog --
	p = sub.add_parser("dialog", help="Set handler for next browser dialog (alert/confirm/prompt)")
	p.add_argument("action", nargs="?", default="accept", choices=["accept", "dismiss"], help="Accept or dismiss (default: accept)")
	p.add_argument("--text", default=None, help="Response text for prompt dialog")

	# -- Drag --
	p = sub.add_parser("drag", help="Drag element to another element or offset")
	p.add_argument("source", help="CSS selector of element to drag")
	p.add_argument("target", nargs="?", default=None, help="CSS selector of drop target")
	p.add_argument("--dx", type=int, default=None, help="Horizontal pixel offset (when no target)")
	p.add_argument("--dy", type=int, default=None, help="Vertical pixel offset (when no target)")

	# -- Wait --
	p = sub.add_parser("wait", help="Wait for element or sleep")
	p.add_argument("target", help="CSS selector or seconds to wait")
	p.add_argument("timeout", nargs="?", type=float, default=5, help="Timeout in seconds (default: 5)")

	# -- Server management --
	sub.add_parser("serve", help="Start bridge server (foreground)")
	sub.add_parser("ping", help="Check server and extension status")
	sub.add_parser("stop", help="Stop bridge server")

	# -- Setup --
	p = sub.add_parser("setup", help="Install Chrome extension and AI coding skill")
	p.add_argument(
		"target",
		nargs="?",
		default=None,
		help="Skill target: cursor, opencode, or a custom directory path",
	)

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


def handle_download(args):
	"""Download needs special handling for absolute output paths.

	chrome.downloads API only accepts relative filenames (within the browser's
	download directory).  When the user passes an absolute path via ``-o``,
	we send only the basename to the extension and then move the downloaded
	file to the requested location.
	"""
	ensure_server()

	target = args.target
	output = args.output
	move_to = None

	if target.startswith("http://") or target.startswith("https://"):
		params: dict = {"url": target}
	else:
		params = {"selector": target, "index": args.index}

	if output and os.path.isabs(output):
		move_to = output
		params["filename"] = os.path.basename(output)
	else:
		params["filename"] = output

	result = send_raw("download", params)
	if not result.get("success"):
		print(json.dumps(result, ensure_ascii=False))
		sys.exit(1)

	# Move downloaded file to the requested absolute path
	if move_to and result.get("data", {}).get("filename"):
		src_path = result["data"]["filename"]
		try:
			shutil.move(src_path, move_to)
			result["data"]["filename"] = move_to
		except OSError as e:
			result = {"success": False, "error": f"Download succeeded but failed to move to {move_to}: {e}"}
			print(json.dumps(result, ensure_ascii=False))
			sys.exit(1)

	print(json.dumps(result, ensure_ascii=False))
	if not result.get("success"):
		sys.exit(1)


def handle_serve(args):
	"""Run server in foreground."""
	os.execvp(sys.executable, [sys.executable, "-m", "browser_ctl.server", "--port", str(DEFAULT_PORT)])


def _get_extension_source_dir() -> str | None:
	"""Locate the extension source directory (from project root)."""
	pkg_dir = os.path.dirname(os.path.abspath(__file__))
	project_root = os.path.dirname(pkg_dir)
	ext_dir = os.path.join(project_root, "extension")
	if os.path.isdir(ext_dir) and os.path.exists(os.path.join(ext_dir, "manifest.json")):
		return ext_dir
	return None


def _install_extension() -> str | None:
	"""Copy extension to ~/.browser-ctl/extension/ and try to open Chrome extensions page."""
	src = _get_extension_source_dir()
	if not src:
		return None

	dest = os.path.join(BCTL_HOME, "extension")
	if os.path.exists(dest):
		shutil.rmtree(dest)
	shutil.copytree(src, dest)

	# Try to open Chrome extensions page
	system = platform.system()
	try:
		if system == "Darwin":
			subprocess.Popen(
				["open", "-a", "Google Chrome", "chrome://extensions"],
				stdout=subprocess.DEVNULL,
				stderr=subprocess.DEVNULL,
			)
		elif system == "Linux":
			for cmd in ["google-chrome", "chromium", "chromium-browser"]:
				try:
					subprocess.Popen(
						[cmd, "chrome://extensions"],
						stdout=subprocess.DEVNULL,
						stderr=subprocess.DEVNULL,
					)
					break
				except FileNotFoundError:
					continue
	except Exception:
		pass

	return dest


def _install_skill(target_dir: str) -> str:
	"""Copy SKILL.md into <target_dir>/browser-ctl/."""
	src = os.path.join(os.path.dirname(os.path.abspath(__file__)), "SKILL.md")
	if not os.path.isfile(src):
		raise FileNotFoundError("SKILL.md not found in browser_ctl package.")

	skill_dir = os.path.join(target_dir, "browser-ctl")
	os.makedirs(skill_dir, exist_ok=True)
	skill_path = os.path.join(skill_dir, "SKILL.md")
	# Remove existing file/symlink before copying
	if os.path.lexists(skill_path):
		os.remove(skill_path)
	shutil.copy2(src, skill_path)
	return skill_path


def handle_setup(args):
	"""Install Chrome extension and/or AI coding skill."""
	print("browser-ctl setup")
	print("=" * 40)

	# --- Extension ---
	ext_dir = _install_extension()
	if ext_dir:
		print(f"\n[extension] installed -> {ext_dir}")
		print()
		print("  Load in Chrome:")
		print("    1. Open chrome://extensions")
		print("    2. Enable 'Developer mode' (top right)")
		print("    3. Click 'Load unpacked'")
		print(f"    4. Select: {ext_dir}")
	else:
		print("\n[extension] source not found")
		print("  Make sure you are running from a source checkout or dev install.")

	# --- Skill ---
	if args.target:
		target = args.target
		if target in SKILL_TARGETS:
			target_dir = SKILL_TARGETS[target]
			label = target
		else:
			target_dir = os.path.expanduser(target)
			label = target_dir

		try:
			skill_path = _install_skill(target_dir)
			print(f"\n[skill] installed ({label}) -> {skill_path}")
		except FileNotFoundError as e:
			print(f"\n[skill] error: {e}")
	else:
		print("\n[skill] skipped (no target specified)")
		print()
		print("  Available targets:")
		for name, path in SKILL_TARGETS.items():
			print(f"    bctl setup {name:10s}  ->  {path}/browser-ctl/SKILL.md")
		print(f"    bctl setup <path>       ->  <path>/browser-ctl/SKILL.md")

	print()


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
	if cmd in ("sopt",):
		cmd = "select-option"

	# Local-only commands (no server needed)
	if cmd == "setup":
		handle_setup(args)
		return
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

	# Download (special handling for absolute output paths)
	if cmd == "download":
		handle_download(args)
		return

	# Map CLI args to command params
	params = {}
	if cmd == "navigate":
		url = args.url
		# Auto-prepend https:// for bare domains
		if not url.split(":", 1)[0].lower() in ("http", "https", "file", "about", "data", "chrome", "chrome-extension"):
			url = "https://" + url
		params = {"url": url}
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
	elif cmd == "scroll":
		params = {"target": args.target, "amount": args.amount}
	elif cmd == "select-option":
		params = {"selector": args.selector, "value": args.value, "byText": args.text}
	elif cmd == "upload":
		files = [os.path.abspath(f) for f in args.files]
		params = {"selector": args.selector, "files": files}
	elif cmd == "dialog":
		params = {"accept": args.action == "accept", "text": args.text}
	elif cmd == "drag":
		params = {"source": args.source, "target": args.target, "dx": args.dx, "dy": args.dy}
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
