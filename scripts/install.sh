#!/bin/sh
# Sunlight CLI installer.
#
#   curl -fsSL https://meteorcli.yavqo.com/install.sh | sh
#
# Installs into your home folder. No sudo, nothing outside ~/.sunlight and ~/.local/bin.
# Run it again at any time to update. Needs Node.js 20 or newer.
#
# Overrides: SUNLIGHT_BASE_URL (where releases are hosted), SUNLIGHT_HOME, SUNLIGHT_BIN_DIR.

set -eu

BASE_URL="${SUNLIGHT_BASE_URL:-https://meteorcli.yavqo.com}"
BASE_URL="${BASE_URL%/}"
INSTALL_ROOT="${SUNLIGHT_HOME:-$HOME/.sunlight}/cli"
BIN_DIR="${SUNLIGHT_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail "$1 is required but was not found. Install it and run this again."; }

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d ' ' -f 1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d ' ' -f 1
  else fail "sha256sum or shasum is required to verify the download."
  fi
}

field() { sed -n "s/^$1=//p" "$2" | head -n 1; }

# Everything runs inside main, which is only called on the last line.
# If the download is cut off halfway, the shell never reaches that line and nothing is installed.
main() {
  case "$BASE_URL" in
    https://*|http://localhost*|http://127.0.0.1*) ;;
    *) fail "SUNLIGHT_BASE_URL must use https://" ;;
  esac

  need curl
  need tar
  need node
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 20 ] 2>/dev/null || fail "Sunlight needs Node.js 20 or newer (found $(node -v)). Get it from https://nodejs.org and run this again."

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT INT TERM

  say "Looking up the latest Sunlight CLI..."
  curl -fsSL "$BASE_URL/latest" -o "$tmp/latest" || fail "Could not reach $BASE_URL/latest. Check your connection."
  version="$(field version "$tmp/latest")"
  file="$(field file "$tmp/latest")"
  want_sha="$(field sha256 "$tmp/latest")"

  # The release manifest is data from the network: only accept plain names, never paths.
  case "$version" in ""|*[!0-9A-Za-z.+-]*) fail "The release manifest has an invalid version." ;; esac
  case "$file" in sunlight-cli-*.tgz) ;; *) fail "The release manifest has an invalid file name." ;; esac
  case "$file" in */*|*..*) fail "The release manifest has an invalid file name." ;; esac
  [ "${#want_sha}" -eq 64 ] || fail "The release manifest has no checksum."

  say "Downloading Sunlight CLI $version..."
  curl -fsSL "$BASE_URL/$file" -o "$tmp/$file" || fail "Download failed."
  got_sha="$(sha256_of "$tmp/$file")"
  [ "$got_sha" = "$want_sha" ] || fail "Checksum mismatch. The download is corrupt or was changed, so nothing was installed."

  mkdir -p "$INSTALL_ROOT" "$BIN_DIR"
  staging="$INSTALL_ROOT/.staging-$$"
  rm -rf "$staging"
  mkdir -p "$staging"
  tar -xzf "$tmp/$file" -C "$staging" --strip-components=1 || fail "Could not unpack the download."
  [ -f "$staging/dist/cli.js" ] || fail "The download does not look like Sunlight CLI."
  chmod +x "$staging/dist/cli.js"

  rm -rf "${INSTALL_ROOT:?}/$version"
  mv "$staging" "$INSTALL_ROOT/$version"
  ln -sfn "$INSTALL_ROOT/$version" "$INSTALL_ROOT/current"
  ln -sf "$INSTALL_ROOT/current/dist/cli.js" "$BIN_DIR/sunlight"

  # Remove older versions. Never touch the `current` symlink: removing it with a trailing
  # slash would follow it and delete the version we just installed.
  for dir in "$INSTALL_ROOT"/*; do
    [ -d "$dir" ] && [ ! -L "$dir" ] || continue
    [ "$(basename "$dir")" = "$version" ] || rm -rf "$dir"
  done

  installed="$("$BIN_DIR/sunlight" --version 2>/dev/null || true)"
  [ "$installed" = "$version" ] || fail "Installed, but 'sunlight --version' printed '$installed' instead of '$version'."

  say ""
  say "Sunlight CLI $version is installed."

  found="$(command -v sunlight 2>/dev/null || true)"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      case "${SHELL:-}" in
        */zsh) rc="~/.zshrc" ;;
        */bash) rc="~/.bashrc" ;;
        *) rc="your shell profile" ;;
      esac
      say ""
      say "Add this to $rc, then open a new terminal:"
      say "  export PATH=\"$BIN_DIR:\$PATH\""
      ;;
  esac
  if [ -n "$found" ] && [ "$found" != "$BIN_DIR/sunlight" ]; then
    say ""
    say "Note: another 'sunlight' at $found comes first on your PATH and will run instead."
  fi

  say ""
  say "Next: sunlight login"
}

main "$@"
