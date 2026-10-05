#!/usr/bin/env bash
# Prepares self-hosted OSRM routing data (car + foot) for docker-compose's `osrm` profile.
#
#   scripts/osrm-setup.sh [region]
#
# region is a Geofabrik path under asia/india, default "india" (all of India: ~1.7 GB download and
# roughly 25 GB free disk and 12+ GB Docker memory to process). Smaller zones need far less, e.g.
# "northern-zone", "western-zone", "southern-zone", "eastern-zone", "north-eastern-zone", "central-zone".
set -euo pipefail

REGION="${1:-india}"
IMAGE="ghcr.io/project-osrm/osrm-backend:v6.0.0"
DIR="$(cd "$(dirname "$0")/.." && pwd)/osrm-data"
if [[ "$REGION" == "india" ]]; then
  URL="https://download.geofabrik.de/asia/india-latest.osm.pbf"
else
  URL="https://download.geofabrik.de/asia/india/${REGION}-latest.osm.pbf"
fi

mkdir -p "$DIR"
echo "Downloading $URL …"
curl -fL --retry 3 -o "$DIR/region.osm.pbf" "$URL"

for PROFILE in car foot; do
  mkdir -p "$DIR/$PROFILE"
  ln -f "$DIR/region.osm.pbf" "$DIR/$PROFILE/region.osm.pbf"
  echo "Processing $PROFILE profile …"
  docker run --rm -v "$DIR/$PROFILE:/data" "$IMAGE" osrm-extract -p "/opt/$PROFILE.lua" /data/region.osm.pbf
  docker run --rm -v "$DIR/$PROFILE:/data" "$IMAGE" osrm-partition /data/region.osrm
  docker run --rm -v "$DIR/$PROFILE:/data" "$IMAGE" osrm-customize /data/region.osrm
  rm -f "$DIR/$PROFILE/region.osm.pbf"
done
rm -f "$DIR/region.osm.pbf"

echo "Done. Start with: docker compose --profile osrm up -d"
echo "Then set OSRM_URL=http://localhost:5001 and OSRM_FOOT_URL=http://localhost:5002 in .env"
