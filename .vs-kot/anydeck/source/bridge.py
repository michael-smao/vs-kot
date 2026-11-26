"""The bridge to vs-kot: every open window has a socket of its own under
~/.vs-kot/bridge, and answers one JSON object per line
(extensions/vs-kot-bridge/src/server.ts in the vs-kot repository):

    {"id": 1, "method": "state"}
    {"id": 1, "result": {"folders": [...], "review": {"files": 4, ...}, ...}}

The methods are `state`, `run` with an action, `recent` and `open` with a
path. One connection per request: a window that closes takes nothing along
that is waiting for it.

The window that is spoken to is the one used last - in front, or else the
one that was in front most recently.
"""

from __future__ import annotations

import itertools
import json
import os
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Any

FOLDER = Path.home() / ".vs-kot" / "bridge"
# What this extension was written against. A window with a newer protocol is
# spoken to all the same, and says so when something does not fit.
PROTOCOL = 1

# A window answers `state` in a few milliseconds. One that takes longer is
# busy; the display draws what it had.
QUICK = 1.0
# Formatting the whole project opens every file once.
SLOW = 600.0

_ids = itertools.count(1)


class BridgeError(Exception):
    def __init__(self, message: str, code: str = "failed") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Window:
    socket: Path
    state: dict[str, Any]

    @property
    def folders(self) -> list[str]:
        return list(self.state.get("folders") or [])

    @property
    def name(self) -> str:
        folders = self.folders
        return self.state.get("name") or (Path(folders[0]).name if folders else "")

    @property
    def last_focused(self) -> float:
        return float(self.state.get("lastFocused") or 0)

    def has(self, path: str) -> bool:
        wanted = os.path.realpath(path)
        return any(os.path.realpath(folder) == wanted for folder in self.folders)


def call(path: Path, method: str, params: dict[str, Any] | None = None, timeout: float = QUICK) -> Any:
    """Asks one window and gives its answer; BridgeError when it says no."""
    request = {"id": next(_ids), "method": method}
    if params:
        request["params"] = params
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(str(path))
        connection.sendall((json.dumps(request) + "\n").encode())
        answer = _read_line(connection)
    if "error" in answer:
        error = answer["error"] or {}
        raise BridgeError(str(error.get("message") or "vs-kot said no"), str(error.get("code") or "failed"))
    return answer.get("result")


def _read_line(connection: socket.socket) -> dict[str, Any]:
    received = b""
    while b"\n" not in received:
        chunk = connection.recv(65536)
        if not chunk:
            raise BridgeError("vs-kot closed the connection before it answered")
        received += chunk
    return json.loads(received.split(b"\n", 1)[0])


def windows() -> list[Window]:
    """Every open window, with its state. A socket that refuses is one a
    window left behind when it crashed, and is cleared away."""
    found: list[Window] = []
    try:
        sockets = sorted(FOLDER.glob("*.sock"))
    except OSError:
        return found
    for path in sockets:
        try:
            found.append(Window(path, call(path, "state")))
        except ConnectionRefusedError:
            path.unlink(missing_ok=True)
        except (OSError, ValueError, BridgeError):
            pass  # busy, or closing: there again on the next read
    return found


def last_used(found: list[Window]) -> Window | None:
    return max(found, key=lambda window: window.last_focused, default=None)
