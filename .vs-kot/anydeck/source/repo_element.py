"""The folder of the vs-kot window used last, with the file in its editor
and a dot that is green when nothing in it waits for review. Goes with
"Ordner wechseln" on the knob: turned, the name changes.

    ▣ vs-kot              ●
      changeReview.ts
"""

from __future__ import annotations

from anydeck_sdk.display import ACCENT, GREY, BuildContext, Column, DisplayElement, Element, Ellipse, Icon, Options, Row, Text, ref, when

from .colors import DONE


class RepoElement(DisplayElement):
    id = "repo"
    min_size = (120, 40)
    recommended_size = (220, 64)
    words = {
        "de": {"name": "Ordner"},
        "en": {"name": "Folder"},
    }

    def build(self, options: Options, context: BuildContext) -> Element:
        return Row(
            Icon("lucide:folder-git-2", color=ACCENT).box(28, 28),
            Column(Text(ref("vskot.repo"), size=18).bold(), Text(ref("vskot.review.file"), size=12, color=GREY), gap=0),
            Ellipse(color=when(ref("vskot.review.done"), DONE, ACCENT)).box(12, 12),
            gap=10,
        ).show_if(ref("vskot.open"))
