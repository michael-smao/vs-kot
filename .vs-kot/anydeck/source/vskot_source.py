"""vs-kot as an action source: its short name and its parts. There is one of
it, with nothing to connect - it speaks to whichever windows are open."""

from __future__ import annotations

from pathlib import Path

from anydeck_sdk import ActionSource

from . import bridge
from .vskot_actions import VsKotActions
from .vskot_display import VsKotDisplay
from .vskot_settings import VsKotSettings
from .vskot_values import VsKotValues

APPS = (Path("/Applications/vs-kot.app"), Path.home() / "Applications" / "vs-kot.app")


class VsKotSource(ActionSource):
    action_source = "vskot"
    tag = "application"
    instantiable = False
    provides = (VsKotSettings, VsKotActions, VsKotValues, VsKotDisplay)

    @classmethod
    def here(cls) -> bool:
        # The app, or a build from source that ran once and made the folder of the sockets
        return any(app.exists() for app in APPS) or bridge.FOLDER.exists()
