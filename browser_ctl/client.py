"""HTTP client for communicating with the browser-ctl bridge server.

Handles server lifecycle (start/stop/health) and command relay.
Zero external dependencies (stdlib only).
"""

from __future__ import annotations

import json
import os
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


def send_batch(commands: list[dict]) -> dict:
	"""Send multiple commands to /batch endpoint, return parsed response."""
	body = json.dumps({"commands": commands}).encode("utf-8")
	req = urllib.request.Request(
		f"{SERVER_URL}/batch",
		data=body,
		headers={"Content-Type": "application/json"},
	)
	try:
		resp = urllib.request.urlopen(req, timeout=120)
		return json.loads(resp.read().decode("utf-8"))
	except urllib.error.URLError as e:
		return {"success": False, "error": f"Cannot connect to server: {e}"}
	except json.JSONDecodeError:
		return {"success": False, "error": "Invalid response from server"}
