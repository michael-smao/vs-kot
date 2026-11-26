"""What the extension offers for displays - each element in a file of its own."""

from __future__ import annotations

from anydeck_sdk import features

from .completion_element import CompletionElement
from .repo_element import RepoElement
from .review_element import ReviewElement


class VsKotDisplay(features.Display):
    elements = (ReviewElement, RepoElement, CompletionElement)
