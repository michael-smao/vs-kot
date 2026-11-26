"""{{ vskot.… }}: how the review stands in the folder chosen with
switch-repo - or, while none is chosen, in the vs-kot window used last.

    {{ vskot.repo }}                 the folder, by its name
    {{ vskot.path }}                 and its path
    {{ vskot.open }}                 whether vs-kot has it open
    {{ vskot.front }}                whether vs-kot is the app in front
    {{ vskot.review.files }}         files under review
    {{ vskot.review.pending }}       of those, files with something left to look at
    {{ vskot.review.claude }}        files under review with changes Claude Code made
    {{ vskot.review.requests }}      changes asked to be done again
    {{ vskot.review.done }}          nothing left to look at
    {{ vskot.review.progress }}      how much of what came in is reviewed, 0 to 100
    {{ vskot.review.file }}          the file in the editor
    {{ vskot.claude.working }}       Claude Code changed something in the last half minute
    {{ vskot.claude.waiting }}       Claude Code stopped, and its changes wait for a look
    {{ vskot.completion.on }}        tab completion is switched on
    {{ vskot.completion.ok }}        and its model answers
    {{ vskot.completion.accepted }}  suggestions taken today
    {{ vskot.completion.lines }}     lines they wrote today
    {{ vskot.formatting }}           the project is being formatted

Read from the windows once a second while something shows them
(BackgroundValue): a display reads ten times a second, and that would be
ten requests to every window.
"""

from __future__ import annotations

import time
from pathlib import Path
from typing import Any, ClassVar

from anydeck_sdk import BackgroundValue, features
from anydeck_sdk.features.values import DescribedValue

from . import bridge
from .vskot_settings import VsKotSettings

ROOT = "vskot"
EVERY = 1.0
# The hook of Claude Code runs on every change it makes. Silent this long, it
# is done - or thinking, which looks the same from here.
WORKING_FOR = 30.0
# How often the chosen folder is looked up in the setting.
ASK_SETTING_EVERY = 0.5

_PATHS: tuple[tuple[str, str], ...] = (
    ("repo", "text"),
    ("path", "text"),
    ("open", "bool"),
    ("front", "bool"),
    ("review", "object"),
    ("review.files", "number"),
    ("review.pending", "number"),
    ("review.claude", "number"),
    ("review.requests", "number"),
    ("review.done", "bool"),
    ("review.progress", "number"),
    ("review.file", "text"),
    ("claude", "object"),
    ("claude.working", "bool"),
    ("claude.waiting", "bool"),
    ("completion", "object"),
    ("completion.on", "bool"),
    ("completion.ok", "bool"),
    ("completion.accepted", "number"),
    ("completion.lines", "number"),
    ("formatting", "bool"),
)


class _Progress:
    """How much of the review is done, against the most there was to review
    since there was nothing - per folder, so switching windows keeps each."""

    def __init__(self) -> None:
        self._peaks: dict[str, int] = {}

    def of(self, key: str, pending: int) -> int:
        peak = 0 if pending == 0 else max(self._peaks.get(key, 0), pending)
        self._peaks[key] = peak
        return 100 if peak == 0 else round((peak - pending) * 100 / peak)


_progress = _Progress()

# The folder chosen with switch-repo, as the setting has it - told by
# VsKotValues.read, which can ask the setting, to the thread that reads.
_chosen = ""


def read_all() -> dict[str, Any]:
    """Everything under {{ vskot }}, from the window of the chosen folder."""
    chosen = _chosen
    found = bridge.windows()
    window = bridge.window_of(found, chosen) if chosen else bridge.last_used(found)
    if window is None:
        closed = _closed()
        closed.update(repo=Path(chosen).name if chosen else "", path=chosen,
                      front=any(other.state.get("focused") for other in found))
        return closed

    state = window.state
    review = state.get("review") or {}
    claude = state.get("claude") or {}
    completion = state.get("tabCompletion") or {}
    today = completion.get("today") or {}
    pending = int(review.get("pending") or 0)
    claude_files = int(review.get("claude") or 0)
    last_heard = claude.get("lastHeard")
    working = bool(last_heard) and time.time() - float(last_heard) / 1000 < WORKING_FOR

    return {
        "repo": Path(chosen).name if chosen else window.name,
        "path": chosen or (window.folders[0] if window.folders else ""),
        "open": True,
        "front": any(other.state.get("focused") for other in found),
        "review": {
            "files": int(review.get("files") or 0),
            "pending": pending,
            "claude": claude_files,
            "requests": int(review.get("requests") or 0),
            "done": pending == 0,
            "progress": _progress.of(window.folders[0] if window.folders else str(window.socket), pending),
            "file": Path(review["file"]).name if review.get("file") else "",
        },
        "claude": {
            "working": working,
            "waiting": bool(claude.get("connected")) and not working and claude_files > 0 and pending > 0,
        },
        "completion": {
            "on": bool(completion.get("enabled")),
            "ok": bool(completion.get("enabled")) and bool(completion.get("healthy")),
            "accepted": int(today.get("accepted") or 0),
            "lines": int(today.get("lines") or 0),
        },
        "formatting": bool((state.get("formatting") or {}).get("running")),
    }


def _closed() -> dict[str, Any]:
    return {
        "repo": "", "path": "", "open": False, "front": False,
        "review": {"files": 0, "pending": 0, "claude": 0, "requests": 0, "done": True, "progress": 100, "file": ""},
        "claude": {"working": False, "waiting": False},
        "completion": {"on": False, "ok": False, "accepted": 0, "lines": 0},
        "formatting": False,
    }


class VsKotValues(features.Values):
    _value: ClassVar[BackgroundValue] = BackgroundValue(read_all, every=EVERY)

    @classmethod
    def refresh(cls) -> None:
        """Read again now: after an action the display shows what it did,
        not what was there a second before - the chosen folder too."""
        cls._asked = 0.0
        cls._value.renew()

    # The setting is in Anydeck's database, and a display reads ten times a second
    _asked: ClassVar[float] = 0.0
    _asked_chosen: ClassVar[str] = ""

    def _chosen_now(self) -> str:
        now = time.monotonic()
        if now - VsKotValues._asked > ASK_SETTING_EVERY:
            VsKotValues._asked = now
            VsKotValues._asked_chosen = self.features.of(VsKotSettings).chosen()
        return VsKotValues._asked_chosen

    def read(self, name: str) -> Any:
        global _chosen
        chosen = self._chosen_now()
        if chosen != _chosen:
            _chosen = chosen
            self._value.renew()
        value = self._value.get() or _closed()
        if chosen and not bridge.same(value.get("path", ""), chosen):
            # Read before the switch: the folder is the chosen one already, the rest follows in a moment
            value = {**_closed(), "repo": Path(chosen).name, "path": chosen}
        return value

    def describe(self) -> list[DescribedValue]:
        described: list[DescribedValue] = [{"path": ROOT, "type": "object", "i18n": {"key": "references.vskot.root"}}]
        for path, kind in _PATHS:
            described.append({"path": f"{ROOT}.{path}", "type": kind, "i18n": {"key": f"references.vskot.{path}"}})
        return described
