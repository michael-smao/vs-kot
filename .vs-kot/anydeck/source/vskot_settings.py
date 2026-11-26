"""The folder the actions go to, chosen with switch-repo - kept as a setting
of the source, so it is still chosen after Anydeck restarts and can be set
by hand under Aktionsquellen → vs-kot. Empty: the vs-kot window used last.
"""

from __future__ import annotations

from anydeck_sdk import ConnectorField, Text, features

REPO = "repo"


class VsKotSettings(features.Settings):
    source_fields = (ConnectorField(REPO, Text(), secret=False, required=False, default=""),)

    def chosen(self) -> str:
        return str(self.get(REPO) or "")

    def choose(self, path: str) -> None:
        self.save({REPO: path})
