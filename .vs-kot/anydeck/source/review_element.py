"""The review, as a picture: a ring that fills as the review goes on, the
number of files left in it, and under it the files under review, those
Claude Code changed and the open requests.

         vs-kot
       ╭───────╮
       │   3   │        a tick when nothing is left
       ╰───────╯
     ▢ 5   ◉ 4   ✎ 1

The robot is grey while Claude Code is quiet, orange while it works and
green when it stopped and its changes wait. Without vs-kot: a power symbol.
"""

from __future__ import annotations

from anydeck_sdk import Checkbox, ConnectorField
from anydeck_sdk.display import (
    GREY,
    TRACK,
    WHITE,
    BuildContext,
    Column,
    DisplayElement,
    Element,
    Icon,
    Layers,
    Options,
    Ring,
    Row,
    Text,
    check,
    ref,
    when,
)

from .colors import CLAUDE, DONE, WORKING

PENDING = ref("vskot.review.pending")
OPEN = ref("vskot.open")
DONE_NOW = ref("vskot.review.done")


class ReviewElement(DisplayElement):
    id = "review"
    options = (ConnectorField("repo", Checkbox(), secret=False, default=True),)
    min_size = (110, 130)
    recommended_size = (220, 240)
    words = {
        "de": {"name": "Review", "repo": "Ordner zeigen"},
        "en": {"name": "Review", "repo": "Show the folder"},
    }

    def build(self, options: Options, context: BuildContext) -> Element:
        side = max(60.0, min(context.size[0], context.size[1] - 60) - 10)
        ring = Layers(
            Ring(ref("vskot.review.progress"), max=100, color=when(DONE_NOW, DONE, WHITE), track_color=TRACK).thickness(side / 12),
            Text(PENDING, size=side * 0.36, align="center").bold().show_if(check(PENDING, "gt", 0)),
            # In a Column: a layer is as large as the ring, a Column keeps the tick at its own size in the middle
            Column(Icon("lucide:check", color=DONE).box(side * 0.4, side * 0.4)).show_if(DONE_NOW),
        ).box(side, side)

        counts = Row(
            _count("lucide:file-diff", ref("vskot.review.files"), GREY),
            _count("lucide:bot", ref("vskot.review.claude"), CLAUDE_COLOR),
            _count("lucide:message-square", ref("vskot.review.requests"), GREY).show_if(check(ref("vskot.review.requests"), "gt", 0)),
            gap=12,
        )

        parts: list[Element] = []
        if options.get("repo", True):
            parts.append(Text(ref("vskot.repo"), size=14, color=GREY, align="center"))
        parts += [ring, counts]

        # The chosen folder that vs-kot does not have open: its name, and a power symbol
        closed = Column(
            Text(ref("vskot.repo"), size=14, color=GREY, align="center"),
            Icon("lucide:power-off", color=GREY).box(side * 0.35, side * 0.35),
            gap=12,
        )
        return Layers(Column(*parts, gap=8).show_if(OPEN), closed.show_if(check(OPEN, "is_false")))


# Grey while Claude Code is quiet, orange while it works, green when it waits for a look.
CLAUDE_COLOR = f"{{{{ vskot.claude.waiting ? '{DONE}' : (vskot.claude.working ? '{WORKING}' : '{CLAUDE}') }}}}"


def _count(icon: str, value: str, color: str) -> Element:
    return Row(Icon(icon, color=color).box(18, 18), Text(value, size=16, color=WHITE).bold(), gap=4)
