#!/bin/bash
# Builds the bundled Obscura engine (https://github.com/h4ckf0r0day/obscura, Apache-2.0)
# from a source checkout and copies the worker binary and license into vendor/obscura/,
# which electron-builder ships as Resources/obscura. Built with the "render" feature only:
# no "stealth" (no TLS/fingerprint impersonation).
#   scripts/build-obscura.sh /path/to/obscura-source [target-dir]
set -euo pipefail
SRC="${1:?usage: build-obscura.sh <obscura source dir> [cargo target dir]}"
TARGET="${2:-$SRC/target}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# Native Apple Silicon build (an Intel Homebrew cargo would produce an x86_64 binary that runs under Rosetta).
export PATH="$HOME/.cargo/bin:$PATH" # rustup's rustc too, not an Intel Homebrew one
CARGO="${CARGO:-$HOME/.cargo/bin/cargo}"
TRIPLE=aarch64-apple-darwin
(cd "$SRC" && CARGO_TARGET_DIR="$TARGET" CARGO_INCREMENTAL=0 "$CARGO" build --release --locked --target "$TRIPLE" -p obscura-cli --bins --features render)
mkdir -p "$HERE/vendor/obscura"
cp "$TARGET/$TRIPLE/release/obscura-worker" "$HERE/vendor/obscura/obscura-worker"
file "$HERE/vendor/obscura/obscura-worker" | grep -q arm64 || { echo "not an arm64 binary" >&2; exit 1; }
cp "$SRC/LICENSE" "$HERE/vendor/obscura/LICENSE"
strip -x "$HERE/vendor/obscura/obscura-worker" 2>/dev/null || true
echo "vendor/obscura ready: $(du -h "$HERE/vendor/obscura/obscura-worker" | cut -f1)"
