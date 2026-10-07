#!/usr/bin/env bash
# Remove the Jabra Battery Indicator extension, helper and udev rule.
set -euo pipefail

UUID="jabra-battery-indicator@henrik-leisdon"

gnome-extensions disable "$UUID" 2>/dev/null || true
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
echo "Extension removed."

if [ -f /etc/udev/rules.d/61-jabra-battery.rules ]; then
    sudo rm /etc/udev/rules.d/61-jabra-battery.rules
    sudo udevadm control --reload
    echo "udev rule removed."
fi
