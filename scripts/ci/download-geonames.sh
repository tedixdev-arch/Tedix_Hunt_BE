#!/usr/bin/env bash
set -euo pipefail
: "${GEONAMES_DIR:?GEONAMES_DIR required}"
mkdir -p "$GEONAMES_DIR"
printf '| Source URL | Downloaded UTC | Bytes | SHA-256 |\n| --- | --- | ---: | --- |\n' > "$GEONAMES_DIR/provenance.md"
for file in cities500.zip countryInfo.txt admin1CodesASCII.txt admin2Codes.txt; do
  url="https://download.geonames.org/export/dump/$file"
  # Refuse HTTP failures, redirects away from the official origin, partial files and endless downloads.
  status=$(curl --fail --silent --show-error --proto '=https' --retry 3 --connect-timeout 30 --max-time 1200 \
    "$url" --output "$GEONAMES_DIR/$file.part" --write-out '%{http_code}')
  test "$status" = 200
  test -s "$GEONAMES_DIR/$file.part"
  mv "$GEONAMES_DIR/$file.part" "$GEONAMES_DIR/$file"
  printf '| %s | %s | %s | %s |\n' "$url" "$(date -u +%FT%TZ)" \
    "$(stat -c %s "$GEONAMES_DIR/$file")" "$(sha256sum "$GEONAMES_DIR/$file" | cut -d ' ' -f 1)" >> "$GEONAMES_DIR/provenance.md"
done
unzip -t "$GEONAMES_DIR/cities500.zip"
unzip -p "$GEONAMES_DIR/cities500.zip" cities500.txt > "$GEONAMES_DIR/cities500.txt"
test -s "$GEONAMES_DIR/cities500.txt"
printf '\nExtracted importer input cities500.txt: %s bytes, SHA-256 %s\n' \
  "$(stat -c %s "$GEONAMES_DIR/cities500.txt")" "$(sha256sum "$GEONAMES_DIR/cities500.txt" | cut -d ' ' -f 1)" >> "$GEONAMES_DIR/provenance.md"
