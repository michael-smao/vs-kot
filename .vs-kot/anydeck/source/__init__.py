"""vs-kot for Anydeck: the review and tab completion of vs-kot on keys, the
knob and the display, through the bridge of every open window.

    vskot_source.py         VsKotSource - what it is, and its parts
    bridge.py               the sockets under ~/.vs-kot/bridge
    vskot_actions.py        VsKotActions - approve, go to, accept, format, ...
    vskot_values.py         VsKotValues - {{ vskot.review.pending }}, ...
    vskot_display.py        VsKotDisplay - what it offers for displays
    review_element.py       the review, as a ring
    repo_element.py         the folder in front
    completion_element.py   tab completion
    colors.py               their colours

`manifest.json` names `VsKotSource` as the entry: it is imported from here.
"""

from .vskot_source import VsKotSource

__all__ = ["VsKotSource"]
