#!/bin/bash
# One command install of LabelPlus-Nondum on macOS:
#   curl -fsSL https://raw.githubusercontent.com/Dryiceee/LabelPlus-Nondum/main/get.sh | bash
# Downloads the latest release, checks it and starts its installer. Arguments
# go to the installer: ... | bash -s -- --uxp
# Everything is in a function: a download cut short runs nothing.
main() {
  set -euo pipefail
  local release="${TYPER_RELEASE_URL:-https://github.com/Dryiceee/LabelPlus-Nondum/releases/latest/download}"
  # Not local: the trap runs after this function has returned
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT

  curl -fL --retry 2 --progress-bar -o "$work/LabelPlus-Nondum.zip" "$release/LabelPlus-Nondum.zip"
  # Older releases have no checksum file
  if curl -fsSL --retry 2 -o "$work/LabelPlus-Nondum.zip.sha256" "$release/LabelPlus-Nondum.zip.sha256"; then
    (cd "$work" && shasum -a 256 -c LabelPlus-Nondum.zip.sha256 >/dev/null) || { echo 'The download of LabelPlus-Nondum is damaged: run this command again.' >&2; exit 1; }
  fi
  unzip -q "$work/LabelPlus-Nondum.zip" -d "$work/package"

  # Under "curl | bash" the standard input is the script: the menu reads the terminal
  if (exec </dev/tty) 2>/dev/null; then
    bash "$work/package/installer/install_mac.sh" --uxp "$@" </dev/tty
  else
    bash "$work/package/installer/install_mac.sh" --uxp "$@"
  fi
}

main "$@"
