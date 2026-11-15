#!/usr/bin/env python3
"""vs-kot: build the macOS .icns of the app icon from its master picture.

Usage:
  .vs-kot/icon/build-icon.py            write vs-kot.icns next to this script
  .vs-kot/icon/build-icon.py --install  also copy the .icns over resources/darwin/code.icns (the file the build uses)

Needs the macOS tools sips and iconutil.
The master is icon-1024.png: a 1024 canvas with the 824 tile in the middle, the 100px margin holds the shadow (the macOS icon grid).
To change the icon, replace icon-1024.png with a picture on that grid and run this script with --install.
"""
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent

# name in the .iconset folder -> pixel size
ICONSET = {
	'icon_16x16.png': 16, 'icon_16x16@2x.png': 32,
	'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
	'icon_128x128.png': 128, 'icon_128x128@2x.png': 256,
	'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
	'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024,
}


def render(master: Path, png: Path, size: int) -> None:
	"""Write the master scaled to size x size pixels."""
	subprocess.run(['sips', '-z', str(size), str(size), str(master), '--out', str(png)], check=True, stdout=subprocess.DEVNULL)


def main() -> None:
	master = HERE / 'icon-1024.png'
	icns = HERE / 'vs-kot.icns'
	with tempfile.TemporaryDirectory() as tmp:
		iconset = Path(tmp) / 'vs-kot.iconset'
		iconset.mkdir()
		for name, size in ICONSET.items():
			render(master, iconset / name, size)
		subprocess.run(['iconutil', '-c', 'icns', '-o', str(icns), str(iconset)], check=True)
	print(f'wrote {icns.name} in {HERE}')

	if '--install' in sys.argv:
		target = REPO / 'resources' / 'darwin' / 'code.icns'
		shutil.copyfile(icns, target)
		print(f'installed to {target}')


if __name__ == '__main__':
	main()
