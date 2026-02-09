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
import shlex
import shutil
import subprocess
import sys

from browser_ctl.client import (
	BCTL_HOME,
	DEFAULT_PORT,
	ensure_server,
	send_batch,
	send_command,
	send_raw,
	stop_server,
)

SKILL_TARGETS = {
	"cursor": os.path.join(os.path.expanduser("~"), ".cursor", "skills-cursor"),
	"opencode": os.path.join(os.path.expanduser("~"), ".config", "opencode", "skills"),
}


def _parse_command_string(line: str, parser: argparse.ArgumentParser) -> tuple[str, dict] | None:
	"""Parse a single command string into (action, params). Returns None on parse failure."""
	try:
		tokens = shlex.split(line)
	except ValueError as e:
		return None
	if not tokens:
		return None

	try:
		args = parser.parse_args(tokens)
	except SystemExit:
		return None

	if not args.command:
		return None

	cmd = resolve_alias(args.command)
	return args_to_action_params(cmd, args)


# Operations executed inside content scripts — can be batched into a single
# chrome.scripting.executeScript call.  "eval" is excluded because it uses
# MAIN-world script-tag injection + CDP debugger fallback.
CONTENT_SCRIPT_OPS = frozenset({
	"click", "dblclick", "hover", "focus", "type", "input-text",
	"press", "check", "uncheck",
	"text", "html", "attr", "select", "count", "snapshot",
	"is-visible", "get-value",
	"scroll", "select-option", "drag", "wait",
})


def handle_pipe(args):
	"""Read commands from stdin, execute them with smart batching, print JSONL."""
	ensure_server()
	parser = build_parser()

	# Collect all commands first
	pending: list[tuple[str, dict]] = []
	for line in sys.stdin:
		line = line.strip()
		if not line or line.startswith("#"):
			continue
		parsed = _parse_command_string(line, parser)
		if parsed is None:
			print(json.dumps({"success": False, "error": f"Failed to parse command: {line}"}),
				  flush=True)
			sys.exit(1)
		pending.append(parsed)

	if not pending:
		return

	cont = getattr(args, "continue_on_error", False)
	_execute_with_batching(pending, continue_on_error=cont)


def handle_batch(args):
	"""Execute multiple commands given as CLI arguments with smart batching."""
	ensure_server()
	parser = build_parser()

	pending: list[tuple[str, dict]] = []
	for cmd_str in args.commands:
		parsed = _parse_command_string(cmd_str, parser)
		if parsed is None:
			print(json.dumps({"success": False, "error": f"Failed to parse command: {cmd_str}"}),
				  flush=True)
			sys.exit(1)
		pending.append(parsed)

	if not pending:
		return

	cont = getattr(args, "continue_on_error", False)
	_execute_with_batching(pending, continue_on_error=cont)


def _execute_with_batching(commands: list[tuple[str, dict]], continue_on_error: bool):
	"""Execute commands with smart batching — groups consecutive content-script
	ops into single /batch requests for maximum performance."""
	i = 0
	had_error = False
	while i < len(commands):
		action, params = commands[i]

		if action in CONTENT_SCRIPT_OPS:
			# Collect consecutive content-script ops into a batch
			batch: list[dict] = []
			while i < len(commands) and commands[i][0] in CONTENT_SCRIPT_OPS:
				a, p = commands[i]
				batch.append({"action": a, "params": p})
				i += 1

			if len(batch) == 1:
				# Single command — use normal endpoint (no overhead)
				result = send_raw(batch[0]["action"], batch[0]["params"])
				print(json.dumps(result, ensure_ascii=False), flush=True)
				if not result.get("success"):
					had_error = True
					if not continue_on_error:
						sys.exit(1)
			else:
				# Multiple consecutive content-script ops — use /batch
				result = send_batch(batch)
				if result.get("success") and "results" in result.get("data", {}):
					for r in result["data"]["results"]:
						print(json.dumps(r, ensure_ascii=False), flush=True)
						if not r.get("success"):
							had_error = True
							if not continue_on_error:
								sys.exit(1)
				else:
					# Batch-level error
					print(json.dumps(result, ensure_ascii=False), flush=True)
					had_error = True
					if not continue_on_error:
						sys.exit(1)
		else:
			# Non-batchable command — send individually
			result = send_raw(action, params)
			print(json.dumps(result, ensure_ascii=False), flush=True)
			if not result.get("success"):
				had_error = True
				if not continue_on_error:
					sys.exit(1)
			i += 1

	if had_error:
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
	p.add_argument("selector", help="CSS selector or element ref (e.g. e5 from snapshot)")
	p.add_argument("-i", "--index", type=int, default=None, help="Click Nth matching element (0-based, negative from end)")
	p.add_argument("-t", "--text", default=None, help="Filter by visible text content (substring match)")

	p = sub.add_parser("dblclick", help="Double-click an element")
	p.add_argument("selector", help="CSS selector or element ref")
	p.add_argument("-i", "--index", type=int, default=None, help="Nth matching element (0-based)")
	p.add_argument("-t", "--text", default=None, help="Filter by visible text content")

	p = sub.add_parser("hover", help="Hover over an element (trigger mouseover)")
	p.add_argument("selector", help="CSS selector or element ref")
	p.add_argument("-i", "--index", type=int, default=None, help="Hover Nth matching element (0-based)")
	p.add_argument("-t", "--text", default=None, help="Filter by visible text content (substring match)")

	p = sub.add_parser("focus", help="Focus an element")
	p.add_argument("selector", help="CSS selector or element ref")
	p.add_argument("-i", "--index", type=int, default=None, help="Nth matching element (0-based)")
	p.add_argument("-t", "--text", default=None, help="Filter by visible text content")

	p = sub.add_parser("type", help="Type text into an element (replaces existing value)")
	p.add_argument("selector", help="CSS selector or element ref")
	p.add_argument("text", help="Text to type")

	p = sub.add_parser("input-text", help="Type text character-by-character (for rich text editors)")
	p.add_argument("selector", help="CSS selector or element ref")
	p.add_argument("text", help="Text to type")
	p.add_argument("--clear", action="store_true", help="Clear existing content before typing")
	p.add_argument("--delay", type=int, default=10, help="Delay between characters in ms (default: 10)")

	p = sub.add_parser("check", help="Check a checkbox or radio button")
	p.add_argument("selector", help="CSS selector or element ref")
	p.add_argument("-i", "--index", type=int, default=None, help="Nth matching element (0-based)")
	p.add_argument("-t", "--text", default=None, help="Filter by visible text content")

	p = sub.add_parser("uncheck", help="Uncheck a checkbox")
	p.add_argument("selector", help="CSS selector or element ref")
	p.add_argument("-i", "--index", type=int, default=None, help="Nth matching element (0-based)")
	p.add_argument("-t", "--text", default=None, help="Filter by visible text content")

	p = sub.add_parser("press", help="Press a keyboard key")
	p.add_argument("key", help="Key name (Enter, Escape, Tab, etc.)")

	# -- Query --
	p = sub.add_parser("snapshot", aliases=["snap"], help="List all interactive elements with refs (e0, e1, …)")
	p.add_argument("--all", action="store_true", help="Include non-interactive elements")

	p = sub.add_parser("text", help="Get text content of an element")
	p.add_argument("selector", nargs="?", default=None, help="CSS selector or element ref (default: body)")

	p = sub.add_parser("html", help="Get innerHTML of an element")
	p.add_argument("selector", nargs="?", default=None, help="CSS selector or element ref (default: body)")

	p = sub.add_parser("attr", help="Get attribute(s) of an element")
	p.add_argument("selector", help="CSS selector or element ref")
	p.add_argument("name", nargs="?", default=None, help="Attribute name (omit for all)")
	p.add_argument("-i", "--index", type=int, default=None, help="Get Nth matching element (0-based)")

	p = sub.add_parser("select", aliases=["sel"], help="Query all matching elements (returns summary of each)")
	p.add_argument("selector", help="CSS selector")
	p.add_argument("-l", "--limit", type=int, default=20, help="Max items to return (default: 20)")

	p = sub.add_parser("count", help="Count matching elements")
	p.add_argument("selector", help="CSS selector")

	sub.add_parser("status", help="Get current page URL and title")

	p = sub.add_parser("is-visible", help="Check if an element is visible")
	p.add_argument("selector", help="CSS selector or element ref")
	p.add_argument("-i", "--index", type=int, default=None, help="Nth matching element (0-based)")

	p = sub.add_parser("get-value", help="Get value of a form element")
	p.add_argument("selector", help="CSS selector or element ref")
	p.add_argument("-i", "--index", type=int, default=None, help="Nth matching element (0-based)")

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

	# -- Batch / Pipe --
	p = sub.add_parser("pipe", help="Read commands from stdin (one per line, JSONL output)")
	p.add_argument("--continue-on-error", action="store_true", help="Don't stop on first error")

	p = sub.add_parser("batch", help="Execute multiple commands in one call")
	p.add_argument("commands", nargs="+", help="Commands as quoted strings, e.g. 'click \"button\"'")
	p.add_argument("--continue-on-error", action="store_true", help="Don't stop on first error")

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
	"""Locate the extension source directory.

	Looks in two places:
	1. Inside the package (works for pip install)
	2. Project root (works for editable/dev install)
	"""
	pkg_dir = os.path.dirname(os.path.abspath(__file__))
	# 1. Bundled inside the package (pip install browser-ctl)
	ext_dir = os.path.join(pkg_dir, "extension")
	if os.path.isdir(ext_dir) and os.path.exists(os.path.join(ext_dir, "manifest.json")):
		return ext_dir
	# 2. Project root (pip install -e . / dev checkout)
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
# Command parsing helpers (reused by main, pipe, batch)
# ---------------------------------------------------------------------------

_ALIASES = {
	"nav": "navigate", "go": "navigate",
	"fwd": "forward",
	"ss": "screenshot",
	"sel": "select",
	"dl": "download",
	"sopt": "select-option",
	"snap": "snapshot",
}


def resolve_alias(cmd: str) -> str:
	"""Resolve command aliases to canonical names."""
	return _ALIASES.get(cmd, cmd)


def args_to_action_params(cmd: str, args) -> tuple[str, dict]:
	"""Convert parsed argparse namespace to (action, params) tuple."""
	params: dict = {}
	if cmd == "navigate":
		url = args.url
		if url.split(":", 1)[0].lower() not in (
			"http", "https", "file", "about", "data", "chrome", "chrome-extension",
		):
			url = "https://" + url
		params = {"url": url}
	elif cmd == "click":
		params = {"selector": args.selector, "index": args.index, "text": args.text}
	elif cmd == "dblclick":
		params = {"selector": args.selector, "index": args.index, "text": args.text}
	elif cmd == "hover":
		params = {"selector": args.selector, "index": args.index, "text": args.text}
	elif cmd == "focus":
		params = {"selector": args.selector, "index": args.index, "text": args.text}
	elif cmd == "type":
		params = {"selector": args.selector, "text": args.text}
	elif cmd == "input-text":
		params = {"selector": args.selector, "inputText": args.text, "clear": args.clear, "delay": args.delay}
	elif cmd == "check":
		params = {"selector": args.selector, "index": args.index, "text": args.text}
	elif cmd == "uncheck":
		params = {"selector": args.selector, "index": args.index, "text": args.text}
	elif cmd == "press":
		params = {"key": args.key}
	elif cmd == "snapshot":
		params = {"interactive": not getattr(args, "all", False)}
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
	elif cmd == "is-visible":
		params = {"selector": args.selector, "index": args.index}
	elif cmd == "get-value":
		params = {"selector": args.selector, "index": args.index}
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
		try:
			seconds = float(args.target)
			params = {"seconds": seconds}
		except ValueError:
			params = {"selector": args.target, "timeout": args.timeout}
	return cmd, params


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main():
	parser = build_parser()
	args = parser.parse_args()

	if not args.command:
		parser.print_help()
		sys.exit(0)

	cmd = resolve_alias(args.command)

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

	# Pipe mode
	if cmd == "pipe":
		handle_pipe(args)
		return

	# Batch mode
	if cmd == "batch":
		handle_batch(args)
		return

	# Standard command: parse args, send to server
	action, params = args_to_action_params(cmd, args)
	send_command(action, params)


if __name__ == "__main__":
	main()
