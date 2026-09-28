#!/usr/bin/env bash
# Encodes record-scenes.js captures ($REC_WORK/raw/<scene>.mkv) into the site's animated demos:
#   home  -> site/assets/home-demo.webp, home-demo.gif, home-demo-poster.webp
#   other -> site/assets/guide-<scene>.webp, guide-<scene>.gif
# Needs ffmpeg with libwebp. Usage: desktop/scripts/encode-demos.sh [scene...]
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
RAW="${REC_WORK:-/tmp/socha-rec}/raw"
OUT="$REPO/site/assets"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# name, width for webp, width/fps/colours for gif
encode() {
  local src="$1" base="$2" ww="$3" gw="$4" gfps="$5" gcol="$6" wfps="$7" q="$8"
  # Animated WebP (lossy; the UI is mostly flat colour so this stays small).
  ffmpeg -loglevel error -y -i "$src" -vf "fps=$wfps,scale=$ww:-2:flags=lanczos" \
    -c:v libwebp_anim -lossless 0 -quality "$q" -compression_level 6 -preset picture -loop 0 -an "$OUT/$base.webp"
  # GIF fallback: one palette for the clip, only changed rectangles re-encoded.
  ffmpeg -loglevel error -y -i "$src" -vf "fps=$gfps,scale=$gw:-2:flags=lanczos,palettegen=max_colors=$gcol:stats_mode=diff" "$TMP/pal.png"
  ffmpeg -loglevel error -y -i "$src" -i "$TMP/pal.png" \
    -lavfi "fps=$gfps,scale=$gw:-2:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
    -loop 0 "$OUT/$base.gif"
  printf '%-28s webp %7s KB   gif %7s KB\n' "$base" "$(( $(stat -c%s "$OUT/$base.webp") / 1024 ))" "$(( $(stat -c%s "$OUT/$base.gif") / 1024 ))"
}

scenes=("$@")
if [ ${#scenes[@]} -eq 0 ]; then
  for f in "$RAW"/*.mkv; do scenes+=("$(basename "$f" .mkv)"); done
fi
for s in "${scenes[@]}"; do
  src="$RAW/$s.mkv"
  [ -f "$src" ] || { echo "missing $src" >&2; exit 1; }
  if [ "$s" = home ]; then
    encode "$src" home-demo 960 720 8 64 12 62
    # Still for prefers-reduced-motion and slow connections: the side-by-side diff after Compare.
    ffmpeg -loglevel error -y -ss "${HOME_POSTER_AT:-4.5}" -i "$src" -frames:v 1 -vf "scale=960:-2:flags=lanczos" -c:v libwebp -quality 80 "$OUT/home-demo-poster.webp"
  else
    encode "$src" "guide-$s" 1024 720 8 64 12 62
  fi
done
