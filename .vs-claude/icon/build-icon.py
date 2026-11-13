#!/usr/bin/env python3
"""vs-claude: draw the app icon and build the macOS .icns from it.

Usage:
  .vs-claude/icon/build-icon.py            write icon.svg, icon-small.svg, icon-1024.png and vs-claude.icns next to this script
  .vs-claude/icon/build-icon.py --install  also copy the .icns over resources/darwin/code.icns (the file the build uses)

Needs rsvg-convert (brew install librsvg) and the macOS tool iconutil.
The picture: a dark tile with a slice of a reviewed diff (one removed line, two added lines) and an approve check.
"""
import math
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent


def squircle(cx: float, cy: float, a: float, n: float = 5.0, steps: int = 360) -> str:
	"""Superellipse outline: a close match for the continuous corners of macOS app icons."""
	pts = []
	for i in range(steps):
		t = 2 * math.pi * i / steps
		c, s = math.cos(t), math.sin(t)
		x = cx + a * math.copysign(abs(c) ** (2 / n), c)
		y = cy + a * math.copysign(abs(s) ** (2 / n), s)
		pts.append(f'{x:.1f},{y:.1f}')
	return 'M' + ' L'.join(pts) + 'Z'


# macOS icon grid: 1024 canvas, 824 tile in the middle, the 100px margin holds the shadow.
TILE = squircle(512, 512, 412)

# The diff slice: rows inside the glass panel.
ROW_X, ROW_W, ROW_H = 248, 528, 86
ROWS = [
	# (y, kind, bar width)
	(280, 'context', 250),
	(406, 'removed', 360),
	(532, 'added', 410),
	(658, 'added', 210),
]


def row(y: int, kind: str, width: int) -> str:
	mid = y + ROW_H / 2
	bar = f'<rect x="{ROW_X + 76}" y="{mid - 16}" width="{width}" height="32" rx="16" fill="url(#bar-{kind})"/>'
	if kind == 'context':
		return bar
	band = f'<rect x="{ROW_X}" y="{y}" width="{ROW_W}" height="{ROW_H}" rx="26" fill="url(#band-{kind})"/>'
	sign_x = ROW_X + 38
	sign = f'<rect x="{sign_x - 17}" y="{mid - 5}" width="34" height="10" rx="5" fill="url(#bar-{kind})"/>'
	if kind == 'added':
		sign += f'<rect x="{sign_x - 5}" y="{mid - 17}" width="10" height="34" rx="5" fill="url(#bar-{kind})"/>'
	return band + sign + bar


def full_detail() -> str:
	"""Glass panel with four diff rows and the approve badge: used from 64px up."""
	return f'''		<!-- glass panel holding the diff -->
		<rect x="204" y="252" width="616" height="552" rx="72" fill="#000" opacity="0.45" filter="url(#soft)"/>
		<rect x="204" y="236" width="616" height="552" rx="72" fill="#17142b" opacity="0.55"/>
		<rect x="204" y="236" width="616" height="552" rx="72" fill="url(#panel)"/>
		<rect x="205.5" y="237.5" width="613" height="549" rx="70.5" fill="none" stroke="url(#panel-rim)" stroke-width="3"/>

		{''.join(row(*r) for r in ROWS)}

		<!-- approve badge -->
		<circle cx="748" cy="752" r="130" fill="#19e392" opacity="0.6" filter="url(#badge-glow)"/>
		<circle cx="748" cy="762" r="122" fill="#000" opacity="0.4" filter="url(#soft)"/>
		<circle cx="748" cy="748" r="122" fill="url(#badge)"/>
		<circle cx="748" cy="748" r="120" fill="none" stroke="url(#badge-rim)" stroke-width="4"/>
		<path d="M693 752 L732 791 L806 708" fill="none" stroke="#063d26" stroke-opacity="0.28" stroke-width="34" stroke-linecap="round" stroke-linejoin="round" transform="translate(0 6)"/>
		<path d="M693 752 L732 791 L806 708" fill="none" stroke="#fff" stroke-width="34" stroke-linecap="round" stroke-linejoin="round"/>
'''


def small_detail() -> str:
	"""For 16px and 32px: no panel, three fat lines and a bigger badge, so it does not turn to mud."""
	return '''		<rect x="212" y="236" width="430" height="116" rx="58" fill="url(#bar-removed)"/>
		<rect x="212" y="420" width="600" height="116" rx="58" fill="url(#bar-added)"/>
		<rect x="212" y="604" width="300" height="116" rx="58" fill="url(#bar-added)"/>
		<circle cx="712" cy="716" r="196" fill="#0e0c1b" opacity="0.9"/>
		<circle cx="712" cy="716" r="166" fill="url(#badge)"/>
		<path d="M636 722 L690 776 L792 662" fill="none" stroke="#fff" stroke-width="52" stroke-linecap="round" stroke-linejoin="round"/>
'''


def svg(small: bool = False) -> str:
	detail = small_detail() if small else full_detail()
	return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
	<defs>
		<clipPath id="tile"><path d="{TILE}"/></clipPath>

		<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#2e2752"/>
			<stop offset="1" stop-color="#0e0c1b"/>
		</linearGradient>
		<radialGradient id="glow-coral" gradientUnits="userSpaceOnUse" cx="210" cy="180" r="600">
			<stop offset="0" stop-color="#ff7a4d" stop-opacity="0.78"/>
			<stop offset="0.55" stop-color="#ff5a6a" stop-opacity="0.22"/>
			<stop offset="1" stop-color="#ff5a6a" stop-opacity="0"/>
		</radialGradient>
		<radialGradient id="glow-violet" gradientUnits="userSpaceOnUse" cx="880" cy="210" r="520">
			<stop offset="0" stop-color="#7d5cff" stop-opacity="0.62"/>
			<stop offset="1" stop-color="#7d5cff" stop-opacity="0"/>
		</radialGradient>
		<radialGradient id="glow-green" gradientUnits="userSpaceOnUse" cx="790" cy="900" r="560">
			<stop offset="0" stop-color="#12d68c" stop-opacity="0.55"/>
			<stop offset="1" stop-color="#12d68c" stop-opacity="0"/>
		</radialGradient>
		<linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#fff" stop-opacity="0.16"/>
			<stop offset="0.5" stop-color="#fff" stop-opacity="0"/>
		</linearGradient>
		<linearGradient id="rim" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#fff" stop-opacity="0.55"/>
			<stop offset="0.35" stop-color="#fff" stop-opacity="0.08"/>
			<stop offset="1" stop-color="#fff" stop-opacity="0.14"/>
		</linearGradient>

		<linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#fff" stop-opacity="0.17"/>
			<stop offset="1" stop-color="#fff" stop-opacity="0.05"/>
		</linearGradient>
		<linearGradient id="panel-rim" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#fff" stop-opacity="0.6"/>
			<stop offset="0.4" stop-color="#fff" stop-opacity="0.12"/>
			<stop offset="1" stop-color="#fff" stop-opacity="0.08"/>
		</linearGradient>

		<linearGradient id="bar-context" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0" stop-color="#fff" stop-opacity="0.5"/>
			<stop offset="1" stop-color="#fff" stop-opacity="0.28"/>
		</linearGradient>
		<linearGradient id="bar-removed" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0" stop-color="#ffb0a6"/>
			<stop offset="1" stop-color="#ff6f86"/>
		</linearGradient>
		<linearGradient id="bar-added" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0" stop-color="#b5ffd6"/>
			<stop offset="1" stop-color="#4fefa4"/>
		</linearGradient>
		<linearGradient id="band-removed" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0" stop-color="#ff4d67" stop-opacity="0.46"/>
			<stop offset="1" stop-color="#ff4d67" stop-opacity="0.2"/>
		</linearGradient>
		<linearGradient id="band-added" x1="0" y1="0" x2="1" y2="0">
			<stop offset="0" stop-color="#1fe08e" stop-opacity="0.42"/>
			<stop offset="1" stop-color="#1fe08e" stop-opacity="0.18"/>
		</linearGradient>

		<linearGradient id="badge" x1="0.2" y1="0" x2="0.8" y2="1">
			<stop offset="0" stop-color="#8dfcc4"/>
			<stop offset="0.55" stop-color="#27d98a"/>
			<stop offset="1" stop-color="#0a9d5e"/>
		</linearGradient>
		<linearGradient id="badge-rim" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#fff" stop-opacity="0.85"/>
			<stop offset="0.5" stop-color="#fff" stop-opacity="0.1"/>
			<stop offset="1" stop-color="#fff" stop-opacity="0"/>
		</linearGradient>

		<filter id="tile-shadow" x="-20%" y="-20%" width="140%" height="140%">
			<feGaussianBlur stdDeviation="16"/>
		</filter>
		<filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
			<feGaussianBlur stdDeviation="22"/>
		</filter>
		<filter id="badge-glow" x="-60%" y="-60%" width="220%" height="220%">
			<feGaussianBlur stdDeviation="34"/>
		</filter>
	</defs>

	<!-- shadow under the tile -->
	<path d="{TILE}" transform="translate(0 16)" fill="#000" opacity="0.38" filter="url(#tile-shadow)"/>

	<!-- tile: dark base with three coloured lights -->
	<g clip-path="url(#tile)">
		<rect width="1024" height="1024" fill="url(#bg)"/>
		<rect width="1024" height="1024" fill="url(#glow-coral)"/>
		<rect width="1024" height="1024" fill="url(#glow-violet)"/>
		<rect width="1024" height="1024" fill="url(#glow-green)"/>
		<rect width="1024" height="1024" fill="url(#sheen)"/>

{detail}
	</g>

	<!-- light catching the tile's edge -->
	<path d="{TILE}" fill="none" stroke="url(#rim)" stroke-width="3" clip-path="url(#tile)"/>
</svg>
'''


# name in the .iconset folder -> pixel size
ICONSET = {
	'icon_16x16.png': 16, 'icon_16x16@2x.png': 32,
	'icon_32x32.png': 32, 'icon_32x32@2x.png': 64,
	'icon_128x128.png': 128, 'icon_128x128@2x.png': 256,
	'icon_256x256.png': 256, 'icon_256x256@2x.png': 512,
	'icon_512x512.png': 512, 'icon_512x512@2x.png': 1024,
}


def render(svg: Path, png: Path, size: int) -> None:
	subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), '-o', str(png), str(svg)], check=True)


def main() -> None:
	svg_file = HERE / 'icon.svg'
	svg_file.write_text(svg())
	small_file = HERE / 'icon-small.svg'
	small_file.write_text(svg(small=True))
	render(svg_file, HERE / 'icon-1024.png', 1024)

	icns = HERE / 'vs-claude.icns'
	with tempfile.TemporaryDirectory() as tmp:
		iconset = Path(tmp) / 'vs-claude.iconset'
		iconset.mkdir()
		for name, size in ICONSET.items():
			render(small_file if size <= 32 else svg_file, iconset / name, size)
		subprocess.run(['iconutil', '-c', 'icns', '-o', str(icns), str(iconset)], check=True)
	print(f'wrote {svg_file.name}, {small_file.name}, icon-1024.png, {icns.name} in {HERE}')

	if '--install' in sys.argv:
		target = REPO / 'resources' / 'darwin' / 'code.icns'
		shutil.copyfile(icns, target)
		print(f'installed to {target}')


if __name__ == '__main__':
	main()
