"""What vs-kot can be told to do from a key, the knob or a flow. Each goes
through the bridge, also while another app is in front - except a change
request, which brings vs-kot to the front because the note is typed there.

Which window: the folder the action names in its field "repo", else the
folder chosen with switch-repo (the setting "repo", {{ vskot.repo }}), else
the window used last.

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
    switch-repo          choose the folder the other actions go to: the next
                         or the previous of the folders opened last, or one
                         of them - and, if asked, bring its window to the front
    show                 the window of the folder to the front, opened if it
                         is not open
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
    Checkbox,
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
from .vskot_settings import REPO, VsKotSettings
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
}
_APPROVE = {"change": "approve-change", "file": "approve-file"}
_GO_TO = {
    "next-change": "next-change",
    "previous-change": "previous-change",
    "next-file": "next-file",
    "previous-file": "previous-file",
}
_ACCEPT = {"all": "accept-suggestion", "word": "accept-word", "line": "accept-line"}


def _repo() -> ActionField:
    """The folder an action goes to. Empty: the one chosen with switch-repo."""
    return ActionField(REPO, ApiList(searchable=False), required=False, default="", allow_reference=False)


def _action(name: str, group: str, *fields: ActionField, returns: tuple[Return, ...] = ()) -> ActionDefinition:
    return ActionDefinition(name=name, group=group, fields=(*fields, _repo()), returns=returns)


class VsKotActions(features.Action):
    definitions = (
        _action("approve", "review",
                ActionField("what", Choice(options=tuple(_APPROVE)), default="change", allow_reference=False)),
        _action("request-change", "review"),
        _action("go-to", "review",
                ActionField("to", Choice(options=tuple(_GO_TO)), default="next-change", allow_reference=False,
                            by_turn=("previous-change", "next-change"))),
        _action("undo-request", "review"),
        _action("copy-requests", "review"),
        _action("toggle-review", "review"),
        _action("accept-suggestion", "completion",
                ActionField("how", Choice(options=tuple(_ACCEPT)), default="all", allow_reference=False)),
        _action("dismiss-suggestion", "completion"),
        _action("suggest", "completion"),
        _action("toggle-tab-completion", "completion"),
        _action("format-project", "project",
                returns=(Return("formatted", "number"), Return("checked", "number"), Return("skipped", "number"))),
        ActionDefinition(
            name="switch-repo",
            group="project",
            fields=(
                ActionField("to", Choice(options=("next", "previous", "repo")), default="next", allow_reference=False,
                            by_turn=("previous", "next")),
                Container(
                    fields=(ActionField(REPO, ApiList(searchable=False), allow_reference=False),),
                    when=When((Condition("to", "eq", "repo"),)),
                ),
                ActionField("front", Checkbox(), required=False, default=False, allow_reference=False),
            ),
            returns=(Return("repo"), Return("path")),
        ),
        _action("show", "project"),
    )

    # --- the folders to choose from -----------------------------------------------

    def get_field_data(self, action, field, *, query=None, context=None, limit=50, cursor=None) -> FieldData:
        if field == REPO:
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
        if action == "show":
            path = self._path(params)
            self._bring_to_front(path) if path else self._ask(params, "run", {"action": "focus"})
            return {}

        if action in _SIMPLE:
            command = _SIMPLE[action]
        elif action == "approve":
            command = _APPROVE[params.get("what") or "change"]
        elif action == "go-to":
            command = _GO_TO[params.get("to") or "next-change"]
        elif action == "accept-suggestion":
            command = _ACCEPT[params.get("how") or "all"]
        elif action == "format-project":
            result = self._ask(params, "run", {"action": "format-project"}, timeout=bridge.SLOW) or {}
            self.tracking.say("vskot.summary.format", {"formatted": result.get("formatted", 0),
                                                       "skipped": result.get("skipped", 0)})
            return {key: result.get(key, 0) for key in ("formatted", "checked", "skipped")}
        else:
            return super().run(action, params, variables, context)

        self._ask(params, "run", {"action": command})
        return {}

    # --- the folder ---------------------------------------------------------------

    def _path(self, params: dict[str, Any]) -> str:
        """The folder the action names, else the one chosen."""
        return str(params.get(REPO) or "") or self.features.of(VsKotSettings).chosen()

    def _switch_repo(self, params: dict[str, Any]) -> dict[str, Any]:
        to = params.get("to") or "next"
        if to == "repo":
            path = str(params.get(REPO) or "")
            if not path:
                raise ActionError(self.tracking, "no folder chosen", i18n="vskot.error.noRepo", status=422)
        else:
            path = self._step(to == "previous")

        self.features.of(VsKotSettings).choose(path)
        if params.get("front"):
            self._bring_to_front(path)

        name = Path(path).name
        self.tracking.say("vskot.summary.switch", {"repo": shown(name)})
        return {"repo": name, "path": path}

    def _step(self, back: bool) -> str:
        """The folder after (or before) the one chosen, in a fixed order - by
        name, so turning the knob always passes them the same way, while the
        order of the folders opened last changes as they are opened."""
        folders = sorted(self._recent(), key=lambda folder: (folder["name"].lower(), folder["path"]))
        if not folders:
            raise ActionError(self.tracking, "vs-kot knows no folders yet", i18n="vskot.error.noRecent", status=409)
        paths = [folder["path"] for folder in folders]
        here = self._path({})
        if not here:
            window = bridge.last_used(bridge.windows())
            here = window.folders[0] if window and window.folders else ""
        at = next((index for index, path in enumerate(paths) if bridge.same(path, here)), None)
        if at is None:
            return paths[-1 if back else 0]
        return paths[(at + (-1 if back else 1)) % len(paths)]

    def _bring_to_front(self, path: str) -> None:
        """The window of the folder to the front - opened where there is none."""
        found = bridge.windows()
        window = bridge.window_of(found, path)
        if window is not None:
            self._call(window, "run", {"action": "focus"})
        elif found:
            self._call(bridge.last_used(found), "open", {"path": path})
        else:
            # No window to ask: the app itself opens the folder
            subprocess.run(["open", "-b", APP_ID, path], check=False)

    # --- the bridge ---------------------------------------------------------------

    def _recent(self) -> list[dict[str, str]]:
        window = bridge.last_used(bridge.windows())
        if window is None:
            raise ActionError(self.tracking, "no window of vs-kot is open", i18n="vskot.error.closed", status=409)
        folders = self._call(window, "recent") or []
        return [folder for folder in folders if isinstance(folder, dict) and folder.get("path")]

    def _ask(self, params: dict[str, Any], method: str, request: dict[str, Any] | None = None,
             timeout: float = bridge.QUICK * 5) -> Any:
        """Asks the window of the action's folder."""
        path = self._path(params)
        found = bridge.windows()
        window = bridge.window_of(found, path) if path else bridge.last_used(found)
        if window is None:
            if path:
                raise ActionError(self.tracking, f"vs-kot has {path} not open",
                                  i18n={"key": "vskot.error.notOpen", "params": {"repo": Path(path).name}}, status=409)
            raise ActionError(self.tracking, "no window of vs-kot is open", i18n="vskot.error.closed", status=409)
        return self._call(window, method, request, timeout)

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
