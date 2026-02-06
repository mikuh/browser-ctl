"""Bridge server: relays commands between CLI (HTTP) and Chrome extension (WebSocket).

Single port serves both protocols:
  - POST /command  — CLI sends commands here
  - GET  /ws       — Chrome extension connects here
  - GET  /health   — Health check

Commands are matched to responses via request IDs using asyncio.Future.
"""

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import time
import uuid

from aiohttp import web, WSMsgType

logging.basicConfig(
	level=logging.INFO,
	format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger("bctl.server")

# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

# Currently connected extension WebSocket (only one at a time)
_ext_ws: web.WebSocketResponse | None = None

# Pending command futures: request_id -> Future[dict]
_pending: dict[str, asyncio.Future] = {}

DEFAULT_PORT = 19876
COMMAND_TIMEOUT = 30  # seconds

# ---------------------------------------------------------------------------
# WebSocket handler (Chrome extension)
# ---------------------------------------------------------------------------

async def ws_handler(request: web.Request) -> web.WebSocketResponse:
	global _ext_ws

	ws = web.WebSocketResponse(heartbeat=20)
	await ws.prepare(request)
	log.info("Extension connected")

	# Replace any stale connection
	if _ext_ws is not None and not _ext_ws.closed:
		await _ext_ws.close()
	_ext_ws = ws

	try:
		async for msg in ws:
			if msg.type == WSMsgType.TEXT:
				try:
					data = json.loads(msg.data)
					req_id = data.get("id", "")
					if req_id in _pending:
						_pending[req_id].set_result(data)
					else:
						log.warning("Response for unknown request id: %s", req_id)
				except json.JSONDecodeError:
					log.warning("Invalid JSON from extension: %s", msg.data[:200])
			elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
				break
	finally:
		log.info("Extension disconnected")
		if _ext_ws is ws:
			_ext_ws = None

	return ws


# ---------------------------------------------------------------------------
# HTTP handler (CLI)
# ---------------------------------------------------------------------------

async def command_handler(request: web.Request) -> web.Response:
	"""Receive a command from CLI, relay to extension, return response."""
	try:
		body = await request.json()
	except json.JSONDecodeError:
		return _json_error("Invalid JSON in request body", status=400)

	action = body.get("action", "")
	params = body.get("params", {})

	# Server-local commands
	if action == "ping":
		return _json_ok({
			"server": True,
			"extension": _ext_ws is not None and not _ext_ws.closed,
		})

	if action == "shutdown":
		log.info("Shutdown requested")
		asyncio.get_event_loop().call_later(0.1, _shutdown)
		return _json_ok({"shutdown": True})

	# Relay to extension
	if _ext_ws is None or _ext_ws.closed:
		return _json_error("Chrome extension not connected. Open Chrome and check the extension is loaded.")

	req_id = f"r-{uuid.uuid4().hex[:12]}"
	future: asyncio.Future = asyncio.get_event_loop().create_future()
	_pending[req_id] = future

	try:
		await _ext_ws.send_json({
			"id": req_id,
			"action": action,
			"params": params,
		})

		# Wait for extension response
		result = await asyncio.wait_for(future, timeout=COMMAND_TIMEOUT)
		return web.json_response(result)
	except asyncio.TimeoutError:
		return _json_error(f"Extension did not respond within {COMMAND_TIMEOUT}s")
	except ConnectionResetError:
		return _json_error("Extension connection lost during command")
	finally:
		_pending.pop(req_id, None)


async def health_handler(request: web.Request) -> web.Response:
	return _json_ok({
		"server": True,
		"extension": _ext_ws is not None and not _ext_ws.closed,
		"pending_commands": len(_pending),
	})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _json_ok(data: dict, status: int = 200) -> web.Response:
	return web.json_response({"success": True, "data": data}, status=status)


def _json_error(error: str, status: int = 200) -> web.Response:
	return web.json_response({"success": False, "error": error}, status=status)


_app_runner: web.AppRunner | None = None

def _shutdown():
	"""Graceful shutdown."""
	loop = asyncio.get_event_loop()
	loop.call_soon(loop.stop)


# ---------------------------------------------------------------------------
# App factory & entry point
# ---------------------------------------------------------------------------

def create_app() -> web.Application:
	app = web.Application()
	app.router.add_get("/ws", ws_handler)
	app.router.add_post("/command", command_handler)
	app.router.add_get("/health", health_handler)
	return app


def write_pid_file(port: int) -> str:
	"""Write PID file so CLI can check if server is running."""
	import tempfile
	pid_path = os.path.join(tempfile.gettempdir(), f"bctl-{port}.pid")
	with open(pid_path, "w") as f:
		f.write(str(os.getpid()))
	return pid_path


def main():
	parser = argparse.ArgumentParser(description="browser-ctl bridge server")
	parser.add_argument("--port", type=int, default=DEFAULT_PORT, help="Port to listen on")
	parser.add_argument("--daemon", action="store_true", help="Run as background daemon")
	args = parser.parse_args()

	if args.daemon:
		_daemonize(args.port)
		return

	pid_path = write_pid_file(args.port)
	log.info("PID file: %s", pid_path)
	log.info("Starting bridge server on http://localhost:%d", args.port)

	def cleanup():
		try:
			os.unlink(pid_path)
		except OSError:
			pass

	import atexit
	atexit.register(cleanup)

	# Handle signals
	def handle_signal(sig, frame):
		log.info("Received signal %s, shutting down", sig)
		cleanup()
		sys.exit(0)

	signal.signal(signal.SIGTERM, handle_signal)
	signal.signal(signal.SIGINT, handle_signal)

	app = create_app()
	web.run_app(app, host="127.0.0.1", port=args.port, print=lambda msg: log.info(msg))


def _daemonize(port: int):
	"""Fork into background daemon (Unix only)."""
	if sys.platform == "win32":
		# Windows: just run directly (no fork)
		main_args = [sys.executable, "-m", "browser_ctl.server", "--port", str(port)]
		import subprocess
		subprocess.Popen(
			main_args,
			creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS,
			stdout=subprocess.DEVNULL,
			stderr=subprocess.DEVNULL,
		)
		return

	# Unix double-fork
	pid = os.fork()
	if pid > 0:
		# Parent: wait briefly then exit
		return

	# Child: new session
	os.setsid()

	pid = os.fork()
	if pid > 0:
		os._exit(0)

	# Grandchild: redirect stdio
	sys.stdin.close()
	devnull = os.open(os.devnull, os.O_RDWR)
	os.dup2(devnull, 0)

	# Redirect stdout/stderr to log file
	import tempfile
	log_path = os.path.join(tempfile.gettempdir(), f"bctl-{port}.log")
	log_fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
	os.dup2(log_fd, 1)
	os.dup2(log_fd, 2)

	# Now run the server
	pid_path = write_pid_file(port)
	log.info("Daemon started (pid=%d), log: %s", os.getpid(), log_path)

	import atexit
	atexit.register(lambda: _cleanup_pid(pid_path))

	app = create_app()
	web.run_app(app, host="127.0.0.1", port=port, print=lambda msg: log.info(msg))


def _cleanup_pid(pid_path: str):
	try:
		os.unlink(pid_path)
	except OSError:
		pass


if __name__ == "__main__":
	main()
