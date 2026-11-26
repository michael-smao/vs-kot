# vs-kot for Anydeck

The extension that puts the review and tab completion of vs-kot on the keys, the knob and the display of an [Anydeck](https://crljnlabs.com/en/anydeck/) keypad. It talks to every open vs-kot window through the bridge, a socket per window under `~/.vs-kot/bridge` (`extensions/vs-kot-bridge` and `src/vs/workbench/contrib/vsKotBridge` in this repository).

## Trying a change

With an Anydeck checkout next to you and its backend's Python:

```bash
PY=~/Coding/keyboard/anydeck/backend/.venv/bin/python
```

```bash
$PY -m anydeck_sdk check .vs-kot/anydeck
```

```bash
$PY -m anydeck_sdk test .vs-kot/anydeck --run go-to to=next-change
```

`test` speaks to the vs-kot window used last, for real. To see it in Anydeck itself, pack it and open the file, or install it into Anydeck's test instance (`scripts/dev.py --test-instance` there):

```bash
$PY -m anydeck_sdk pack .vs-kot/anydeck
```

A running Anydeck loads a new version of an extension at its next start. A display element on a template is built again when one of its options changes.

## A new version

Raise `version` in `manifest.json`. `.vs-kot/package.sh` zips it into the app, and vs-kot offers each new version once on a Mac with Anydeck.
