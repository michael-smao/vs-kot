"""Tab completion, as a picture: a flash, green while the model answers, red
when it does not and crossed out while it is off - and how many suggestions
were taken today.

    ⚡ 42
       heute
"""

from __future__ import annotations

from anydeck_sdk.display import GREY, BuildContext, Column, DisplayElement, Element, Icon, Options, Row, Text, ref

from .colors import DONE, PROBLEM

ICON = "{{ vskot.completion.on ? 'lucide:zap' : 'lucide:zap-off' }}"
COLOR = f"{{{{ vskot.completion.ok ? '{DONE}' : (vskot.completion.on ? '{PROBLEM}' : '{GREY}') }}}}"


class CompletionElement(DisplayElement):
    id = "tab-completion"
    min_size = (80, 40)
    recommended_size = (200, 70)
    words = {
        "de": {"name": "Tab Completion", "today": "heute"},
        "en": {"name": "Tab completion", "today": "today"},
    }

    def build(self, options: Options, context: BuildContext) -> Element:
        icon = min(context.size[1], 48)
        return Row(
            Icon(ICON, color=COLOR).box(icon, icon),
            Column(Text(ref("vskot.completion.accepted"), size=24).bold(), Text(context.t("today"), size=12, color=GREY), gap=0),
            gap=10,
        )
