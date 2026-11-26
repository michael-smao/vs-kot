"""What vs-kot can be told to do from a key, the knob or a flow. Each goes
through the bridge to the window used last, also while another app is in
front - except a change request, which brings vs-kot to the front because
the note is typed there.

    approve              the change at the cursor, or the whole file
    request-change       ask for a change to be done again, with a note
    go-to                the next or the previous change or file - a knob
                         turned left goes back, turned right goes on
    undo-request         take a request back
    copy-requests        every open request to the clipboard, for the agent
    toggle-review        the review on or off
    accept-suggestion    the suggestion of tab completion, whole or a word
                         or a line of it
    dismiss-suggestion   away with it
    suggest              ask for one where the cursor is
    toggle-tab-completion
    format-project       every file with the team's formatter; what changes
                         is staged, files under review stay as they are
    switch-repo          to the next or the previous of the folders opened
                         last, or to one of them: its window comes to the
                         front, or opens
    show                 vs-kot to the front
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any

from anydeck_sdk import (
    ActionDefinition,
    ActionError,
    ActionField,
    ApiList,
    Choice,
    Condition,
    Container,
    FieldData,
    FieldDataItem,
    Return,
    RunContext,
    Variables,
    When,
    features,
    shown,
)

from . import bridge
from .vskot_values import VsKotValues

APP_ID = "com.vs-kot.app"

# The action of this extension, and what it asks the bridge to do.
_SIMPLE = {
    "request-change": "request-change",
    "undo-request": "undo-request",
    "copy-requests": "copy-requests",
    "toggle-review": "toggle-review",
    "dismiss-suggestion": "dismiss-suggestion",
    "suggest": "suggest",
    "toggle-tab-completion": "toggle-tab-completion",
    "show": "focus",
}
_APPROVE = {"change": "approve-change", "file": "approve-file"}
_GO_TO = {
    "next-change": "next-change",
    "previous-change": "previous-change",
    "next-file": "next-file",
    "previous-file": "previous-file",
}
_ACCEPT = {"all": "accept-suggestion", "word": "accept-word", "line": "accept-line"}


def _simple(name: str) -> ActionDefinition:
    return ActionDefinition(name=name, group=_GROUPS[name])


_GROUPS = {
    "approve": "review", "request-change": "review", "go-to": "review", "undo-request": "review",
    "copy-requests": "review", "toggle-review": "review",
    "accept-suggestion": "completion", "dismiss-suggestion": "completion", "suggest": "completion",
    "toggle-tab-completion": "completion",
    "format-project": "project", "switch-repo": "project", "show": "project",
}


class VsKotActions(features.Action):
    definitions = (
        ActionDefinition(
            name="approve",
            group="review",
            fields=(ActionField("what", Choice(options=tuple(_APPROVE)), default="change", allow_reference=False),),
        ),
        _simple("request-change"),
        ActionDefinition(
            name="go-to",
            group="review",
            fields=(ActionField("to", Choice(options=tuple(_GO_TO)), default="next-change", allow_reference=False,
                                by_turn=("previous-change", "next-change")),),
        ),
        _simple("undo-request"),
        _simple("copy-requests"),
        _simple("toggle-review"),
        ActionDefinition(
            name="accept-suggestion",
            group="completion",
            fields=(ActionField("how", Choice(options=tuple(_ACCEPT)), default="all", allow_reference=False),),
        ),
        _simple("dismiss-suggestion"),
        _simple("suggest"),
        _simple("toggle-tab-completion"),
        ActionDefinition(
            name="format-project",
            group="project",
            returns=(Return("formatted", "number"), Return("checked", "number"), Return("skipped", "number")),
        ),
        ActionDefinition(
            name="switch-repo",
            group="project",
            fields=(
                ActionField("to", Choice(options=("next", "previous", "repo")), default="next", allow_reference=False,
                            by_turn=("previous", "next")),
                Container(
                    fields=(ActionField("repo", ApiList(searchable=False)),),
                    when=When((Condition("to", "eq", "repo"),)),
                ),
            ),
            returns=(Return("repo"), Return("path")),
        ),
        _simple("show"),
    )

    # --- the folders to choose from -----------------------------------------------

    def get_field_data(self, action, field, *, query=None, context=None, limit=50, cursor=None) -> FieldData:
        if action == "switch-repo" and field == "repo":
            items = tuple(FieldDataItem(value=folder["path"], label=folder["name"], hint=_short(folder["path"]))
                          for folder in self._recent())
            return FieldData(items=items, total=len(items))
        return super().get_field_data(action, field, query=query, context=context, limit=limit, cursor=cursor)

    # --- running ------------------------------------------------------------------

    def run(self, action: str, params: dict[str, Any], variables: Variables, context: RunContext) -> Any:
        try:
            return self._run(action, params, variables, context)
        finally:
            VsKotValues.refresh()

    def _run(self, action: str, params: dict[str, Any], variables: Variables, context: RunContext) -> Any:
        if action == "switch-repo":
            return self._switch_repo(params)

        if action in _SIMPLE:
            command = _SIMPLE[action]
        elif action == "approve":
            command = _APPROVE[params.get("what") or "change"]
        elif action == "go-to":
            command = _GO_TO[params.get("to") or "next-change"]
        elif action == "accept-suggestion":
            command = _ACCEPT[params.get("how") or "all"]
        elif action == "format-project":
            result = self._ask("run", {"action": "format-project"}, timeout=bridge.SLOW) or {}
            self.tracking.say("vskot.summary.format", {"formatted": result.get("formatted", 0),
                                                       "skipped": result.get("skipped", 0)})
            return {key: result.get(key, 0) for key in ("formatted", "checked", "skipped")}
        else:
            return super().run(action, params, variables, context)

        self._ask("run", {"action": command})
        return {}

    def _switch_repo(self, params: dict[str, Any]) -> dict[str, Any]:
        to = params.get("to") or "next"
        if to == "repo":
            path = str(params.get("repo") or "")
            if not path:
                raise ActionError(self.tracking, "no folder chosen", i18n="vskot.error.noRepo", status=422)
        else:
            path = self._step(to == "previous")

        found = bridge.windows()
        window = next((one for one in found if one.has(path)), None)
        if window is not None:
            self._call(window, "run", {"action": "focus"})
        elif found:
            self._call(bridge.last_used(found), "open", {"path": path})
        else:
            # No window to ask: the app itself opens the folder
            subprocess.run(["open", "-b", APP_ID, path], check=False)

        name = Path(path).name
        self.tracking.say("vskot.summary.switch", {"repo": shown(name)})
        return {"repo": name, "path": path}

    def _step(self, back: bool) -> str:
        """The folder after (or before) the one in front, in a fixed order -
        by name, so turning the knob always passes them the same way, while
        the order of the folders opened last changes with every switch."""
        folders = sorted(self._recent(), key=lambda folder: (folder["name"].lower(), folder["path"]))
        if not folders:
            raise ActionError(self.tracking, "vs-kot knows no folders yet", i18n="vskot.error.noRecent", status=409)
        window = bridge.last_used(bridge.windows())
        paths = [folder["path"] for folder in folders]
        here = next((index for index, path in enumerate(paths) if window and window.has(path)), None)
        if here is None:
            return paths[-1 if back else 0]
        return paths[(here + (-1 if back else 1)) % len(paths)]

    # --- the bridge ---------------------------------------------------------------

    def _recent(self) -> list[dict[str, str]]:
        folders = self._ask("recent") or []
        return [folder for folder in folders if isinstance(folder, dict) and folder.get("path")]

    def _ask(self, method: str, params: dict[str, Any] | None = None, timeout: float = bridge.QUICK * 5) -> Any:
        """Asks the window used last."""
        window = bridge.last_used(bridge.windows())
        if window is None:
            raise ActionError(self.tracking, "no window of vs-kot is open", i18n="vskot.error.closed", status=409)
        return self._call(window, method, params, timeout)

    def _call(self, window: bridge.Window, method: str, params: dict[str, Any] | None = None,
              timeout: float = bridge.QUICK * 5) -> Any:
        self.tracking.note(f"vs-kot ({window.name}): {method} {params or ''}".rstrip())
        try:
            return bridge.call(window.socket, method, params, timeout=timeout)
        except bridge.BridgeError as error:
            raise ActionError(self.tracking, f"vs-kot said no: {error}", i18n={"key": "vskot.error.refused",
                              "params": {"reason": str(error)}}, status=422) from error
        except (OSError, ValueError) as error:
            raise ActionError(self.tracking, f"vs-kot did not answer: {error}", i18n="vskot.error.noAnswer",
                              inner_error=error, status=504) from error


def _short(path: str) -> str:
    home = str(Path.home())
    return "~" + path[len(home):] if path.startswith(home + "/") else path
