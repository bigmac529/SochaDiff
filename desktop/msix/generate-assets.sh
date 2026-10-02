#!/usr/bin/env bash
# Generates the MSIX visual assets (desktop/msix/Assets/*.png) from the app icon, site/favicon.svg
# (the same artwork as the site's favicon/apple-touch-icon; the desktop project has no .ico).
# Needs rsvg-convert (librsvg2-bin) and ImageMagick (convert). Re-run after changing the icon and
# commit the PNGs; the build (build-msix.ps1) only uses the committed files.
#
#   Square44x44Logo   app list / taskbar / Start: scale-100..400, targetsize-16..256 (plated and
#                     altform-unplated, i.e. drawn without the tile plate behind it)
#   Square71x71Logo   small tile        Square150x150Logo  medium tile
#   Wide310x150Logo   wide tile         Square310x310Logo  large tile
#   StoreLogo         package logo (Store/installer)       SplashScreen (shown by UWP; harmless for desktop)
# Scale variants: 100, 125, 150, 200, 400. Tiles use a transparent background with the icon centered
# (BackgroundColor="transparent" in Package.appxmanifest), so Windows draws the accent/plate itself.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
src="${1:-$here/../../site/favicon.svg}"
out="$here/Assets"
command -v rsvg-convert >/dev/null || { echo "rsvg-convert not found (apt-get install librsvg2-bin)" >&2; exit 1; }
command -v convert >/dev/null || { echo "ImageMagick convert not found (apt-get install imagemagick)" >&2; exit 1; }
rm -rf "$out"; mkdir -p "$out"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

# icon <size px> <file>: the artwork rendered edge to edge (its own rounded square) at that size.
icon() { rsvg-convert -w "$1" -h "$1" "$src" -o "$2"; }
# canvas <w> <h> <icon px> <file>: icon centered on a transparent w x h canvas.
canvas() {
  icon "$3" "$tmp/i.png"
  convert -size "${1}x${2}" xc:none "$tmp/i.png" -gravity center -composite \
    -define png:color-type=6 -strip "$4"
}
round() { python3 -c "import math,sys; print(int(math.floor(float(sys.argv[1])+0.5)))" "$1"; }

scales=(100 125 150 200 400)
for s in "${scales[@]}"; do
  f() { round "$(python3 -c "print($1*$s/100)")"; }
  # Square44x44Logo: icon fills ~ 84% (Windows guidance leaves a small margin around app list icons).
  w=$(f 44);   canvas "$w" "$w" "$(round "$(python3 -c "print($w*0.84)")")" "$out/Square44x44Logo.scale-$s.png"
  w=$(f 71);   canvas "$w" "$w" "$(round "$(python3 -c "print($w*0.60)")")" "$out/Square71x71Logo.scale-$s.png"
  w=$(f 150);  canvas "$w" "$w" "$(round "$(python3 -c "print($w*0.50)")")" "$out/Square150x150Logo.scale-$s.png"
  w=$(f 310);  canvas "$w" "$w" "$(round "$(python3 -c "print($w*0.50)")")" "$out/Square310x310Logo.scale-$s.png"
  w=$(f 310); h=$(f 150); canvas "$w" "$h" "$(round "$(python3 -c "print($h*0.60)")")" "$out/Wide310x150Logo.scale-$s.png"
  w=$(f 620); h=$(f 300); canvas "$w" "$h" "$(round "$(python3 -c "print($h*0.50)")")" "$out/SplashScreen.scale-$s.png"
  # StoreLogo: shown on its own (Store, App Installer), so the icon fills the whole square.
  w=$(f 50);   canvas "$w" "$w" "$w" "$out/StoreLogo.scale-$s.png"
done

# targetsize icons (taskbar, Start list, Explorer, Alt+Tab); unplated = no plate behind the icon.
for t in 16 20 24 30 32 36 40 48 60 64 72 80 96 256; do
  canvas "$t" "$t" "$t" "$out/Square44x44Logo.targetsize-$t.png"
  cp "$out/Square44x44Logo.targetsize-$t.png" "$out/Square44x44Logo.targetsize-${t}_altform-unplated.png"
  cp "$out/Square44x44Logo.targetsize-$t.png" "$out/Square44x44Logo.targetsize-${t}_altform-lightunplated.png"
done

count=$(find "$out" -name '*.png' | wc -l)
echo "Generated $count PNGs in $out from $src"
