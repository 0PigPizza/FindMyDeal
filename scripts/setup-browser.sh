#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v pacman >/dev/null || { echo 'Firefox/VNC setup requires an Arch-based system with pacman.' >&2; exit 1; }
mkdir -p .data/packages .data/browser-runtime
pacman -Sp --print-format '%l' firefox xorg-server-xvfb x11vnc xdotool geckodriver | while IFS= read -r url; do
  curl -fL --silent --show-error "$url" -o ".data/packages/${url##*/}"
done
for pkg in .data/packages/*.pkg.tar.zst; do tar --zstd -xf "$pkg" -C .data/browser-runtime; done
