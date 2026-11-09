#!/bin/bash
# Updates LabelPlus-Nondum without opening Photoshop: downloads the latest
# release, checks it and installs it (installer/get.sh). Close Photoshop first.
# Your styles and settings are kept. Run from the extracted folder:
#   bash installer/update_mac.sh
exec bash "$(cd "$(dirname "$0")" && pwd)/get.sh" "$@"
