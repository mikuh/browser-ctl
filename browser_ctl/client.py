"""HTTP client for communicating with the browser-ctl bridge server.

Handles server lifecycle (start/stop/health) and command relay.
Zero external dependencies (stdlib only).
Uses raw sockets for minimal import overhead (~5ms vs ~30ms for urllib).
"""

from __future__ import annotations

import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import time

DEFAULT_PORT = 19876
_HOST = "127.0.0.1"

BCTL_HOME = os.path.join(os.path.expanduser("~"), ".browser-ctl")


def _pid_file() -> str:
	import tempfile
	return os.path.join(tempfile.gettempdir(), f"bctl-{DEFAULT_PORT}.pid")


# ---------------------------------------------------------------------------
# Lightweight HTTP via raw sockets (avoids importing urllib — saves ~25ms)
# ---------------------------------------------------------------------------


def _http_post(path: str, body: bytes, timeout: float = 35) -> dict:
	"""Send HTTP POST to bridge server, return parsed JSON response."""
	try:
		sock = socket.create_connection((_HOST, DEFAULT_PORT), timeout=timeout)
	except (ConnectionRefusedError, OSError):
		return {"success": False, "error": "Cannot connect to server"}
	try:
		req = (
			f"POST {path} HTTP/1.0\r\n"
			f"Host: {_HOST}:{DEFAULT_PORT}\r\n"
			f"Content-Type: application/json\r\n"
			f"Content-Length: {len(body)}\r\n"
			f"\r\n"
		).encode("utf-8") + body
		sock.sendall(req)

		# Read response
		chunks = []
		while True:
			chunk = sock.recv(65536)
			if not chunk:
				break
			chunks.append(chunk)
		data = b"".join(chunks)
	finally:
		sock.close()

	# Parse HTTP response — skip headers, find JSON body
	parts = data.split(b"\r\n\r\n", 1)
	if len(parts) < 2:
		return {"success": False, "error": "Invalid response from server"}
	try:
		return json.loads(parts[1].decode("utf-8"))
	except (json.JSONDecodeError, UnicodeDecodeError):
		return {"success": False, "error": "Invalid response from server"}


def _http_get(path: str, timeout: float = 1) -> int:
	"""Send HTTP GET, return status code (0 on failure)."""
	try:
		sock = socket.create_connection((_HOST, DEFAULT_PORT), timeout=timeout)
	except (ConnectionRefusedError, OSError):
		return 0
	try:
		req = (
			f"GET {path} HTTP/1.0\r\n"
			f"Host: {_HOST}:{DEFAULT_PORT}\r\n"
			f"\r\n"
		).encode("utf-8")
		sock.sendall(req)
		# Only need the status line
		resp = sock.recv(1024)
	finally:
		sock.close()
	try:
		status_line = resp.split(b"\r\n", 1)[0]
		return int(status_line.split(b" ", 2)[1])
	except (IndexError, ValueError):
		return 0


# ---------------------------------------------------------------------------
# Server management
# ---------------------------------------------------------------------------


def is_server_running() -> bool:
	"""Check if bridge server is running (PID exists AND HTTP health check passes)."""
	pid_file = _pid_file()
	if not os.path.exists(pid_file):
		return False
	try:
		with open(pid_file) as f:
			pid = int(f.read().strip())
		os.kill(pid, 0)  # Check process exists
	except (OSError, ValueError):
		return False
	# Process exists — verify it is actually accepting HTTP connections.
	return _http_get("/health") == 200


def start_server() -> bool:
	"""Start bridge server as daemon. Returns True if started."""
	if is_server_running():
		return False

	import subprocess
	cmd = [sys.executable, "-m", "browser_ctl.server", "--port", str(DEFAULT_PORT), "--daemon"]
	subprocess.Popen(
		cmd,
		start_new_session=True,
		stdout=subprocess.DEVNULL,
		stderr=subprocess.DEVNULL,
	)

	# Wait for server to become responsive
	import time
	for _ in range(60):  # 3 seconds max
		time.sleep(0.05)
		if _http_get("/health") == 200:
			return True

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
		import time
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
	return _http_post("/command", body)


def send_command(action: str, params: dict):
	"""Optimistic send: try command first, start server only on failure."""
	result = send_raw(action, params)
	if not result.get("success") and "Cannot connect" in result.get("error", ""):
		# Server not running — start it and retry
		start_server()
		result = send_raw(action, params)
	print(json.dumps(result, ensure_ascii=False))
	if not result.get("success"):
		sys.exit(1)


def send_batch(commands: list[dict]) -> dict:
	"""Send multiple commands to /batch endpoint, return parsed response."""
	body = json.dumps({"commands": commands}).encode("utf-8")
	return _http_post("/batch", body, timeout=120)


def ensure_server_optimistic() -> None:
	"""Start server if not running. Optimistic — only checks on first call."""
	result = send_raw("ping", {})
	if not result.get("success") and "Cannot connect" in result.get("error", ""):
		start_server()


def _launch_chrome() -> tuple[bool, str]:
	"""Try to launch Chrome/Chromium and return (started, method)."""
	system = platform.system()

	if system == "Darwin":
		try:
			subprocess.Popen(
				["open", "-a", "Google Chrome"],
				stdout=subprocess.DEVNULL,
				stderr=subprocess.DEVNULL,
			)
			return True, "open -a Google Chrome"
		except Exception:
			return False, "open -a Google Chrome"

	if system == "Windows":
		candidates = [
			"chrome",
			r"C:\Program Files\Google\Chrome\Application\chrome.exe",
			r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
		]
		for cmd in candidates:
			try:
				subprocess.Popen(
					[cmd],
					stdout=subprocess.DEVNULL,
					stderr=subprocess.DEVNULL,
					creationflags=getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
				)
				return True, cmd
			except Exception:
				continue
		return False, "chrome"

	# Linux / other unix-like: try common Chrome/Chromium binaries
	for cmd in ("google-chrome", "chromium", "chromium-browser"):
		if shutil.which(cmd) is None:
			continue
		try:
			subprocess.Popen(
				[cmd],
				stdout=subprocess.DEVNULL,
				stderr=subprocess.DEVNULL,
			)
			return True, cmd
		except Exception:
			continue
	return False, "google-chrome/chromium"


def ensure_ready(timeout: float = 20.0, launch_browser: bool = True) -> dict:
	"""Ensure bridge server + extension are ready.

	Flow:
	1) Start server if needed
	2) Check ping
	3) If extension disconnected and launch enabled, attempt to launch Chrome
	4) Poll until timeout for extension connection
	"""
	ensure_server_optimistic()
	result = send_raw("ping", {})
	if result.get("success") and result.get("data", {}).get("extension"):
		return {
			"success": True,
			"data": {
				"server": True,
				"extension": True,
				"launchedBrowser": False,
				"waitedSeconds": 0.0,
			},
		}

	if not launch_browser:
		return result

	started, method = _launch_chrome()
	if not started:
		return {
			"success": False,
			"error": (
				"Chrome extension not connected and failed to launch browser. "
				f"Tried: {method}. Run `bctl setup` and ensure extension is loaded."
			),
		}

	deadline = time.time() + max(timeout, 1.0)
	last = result
	while time.time() < deadline:
		time.sleep(0.5)
		last = send_raw("ping", {})
		if last.get("success") and last.get("data", {}).get("extension"):
			return {
				"success": True,
				"data": {
					"server": True,
					"extension": True,
					"launchedBrowser": True,
					"launchMethod": method,
					"waitedSeconds": round(max(0.0, timeout - max(0.0, deadline - time.time())), 1),
				},
			}

	return {
		"success": False,
		"error": (
			"Chrome launched but extension is still not connected. "
			"Open chrome://extensions and ensure Browser-Ctl extension is loaded."
		),
		"data": {
			"launchedBrowser": True,
			"launchMethod": method,
			"lastPing": last,
		},
	}
