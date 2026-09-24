#!/usr/bin/env bash
# Texturas planetarias para el visor de simulaciones (kind: 'simulation').
# Fuente: solarsystemscope.com — CC BY 4.0 (https://www.solarsystemscope.com/textures/).
# Gitignoreadas: son ~20 MB de binarios que no pertenecen al repo.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/.." && pwd)/frontend/public/textures"
BASE="https://www.solarsystemscope.com/textures/download"
mkdir -p "$DIR"
for f in 2k_sun.jpg 2k_mercury.jpg 2k_venus_surface.jpg 2k_venus_atmosphere.jpg \
         2k_earth_daymap.jpg 2k_earth_nightmap.jpg 2k_earth_clouds.jpg \
         2k_moon.jpg 2k_mars.jpg 2k_jupiter.jpg 2k_saturn.jpg \
         2k_saturn_ring_alpha.png 2k_uranus.jpg 2k_neptune.jpg \
         2k_stars_milky_way.jpg; do
  if [ -s "$DIR/$f" ]; then echo "ok   $f (ya estaba)"; continue; fi
  if curl -sfL --max-time 60 -o "$DIR/$f" "$BASE/$f"; then
    echo "get  $f ($(du -h "$DIR/$f" | cut -f1))"
  else
    echo "FAIL $f" >&2
  fi
done
