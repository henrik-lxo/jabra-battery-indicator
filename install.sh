#!/usr/bin/env bash
# Install the Jabra Battery Indicator GNOME extension + helper + udev rule.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="jabra-battery-indicator@henrik-leisdon"
EXT_SRC="$SCRIPT_DIR/gnome-extension/$UUID"
EXT_DST="$HOME/.local/share/gnome-shell/extensions/$UUID"
UDEV_RULE="$SCRIPT_DIR/udev/61-jabra-battery.rules"
UDEV_DST="/etc/udev/rules.d/61-jabra-battery.rules"

echo "==> Installing extension to $EXT_DST"
mkdir -p "$EXT_DST"
cp "$EXT_SRC"/extension.js "$EXT_SRC"/metadata.json "$EXT_SRC"/stylesheet.css "$EXT_DST/"
cp "$SCRIPT_DIR/jabra-battery.py" "$EXT_DST/"
chmod +x "$EXT_DST/jabra-battery.py"

if [ ! -f "$UDEV_DST" ] || ! cmp -s "$UDEV_RULE" "$UDEV_DST"; then
    echo "==> Installing udev rule (needs sudo) to $UDEV_DST"
    sudo cp "$UDEV_RULE" "$UDEV_DST"
    sudo udevadm control --reload
    sudo udevadm trigger --subsystem-match=hidraw
else
    echo "==> udev rule already installed"
fi

echo "==> Testing the helper script"
python3 "$EXT_DST/jabra-battery.py" || true

if command -v gnome-extensions >/dev/null; then
    echo "==> Enabling extension"
    gnome-extensions enable "$UUID" 2>/dev/null \
        || echo "    (could not enable yet — log out and back in first, then run: gnome-extensions enable $UUID)"
fi

cat <<'EOF'

Done.

On Wayland you must log out and log back in for GNOME Shell to pick up the
new extension (on X11, Alt+F2 then 'r' restarts the shell instead).
Then enable it with:   gnome-extensions enable jabra-battery-indicator@henrik-leisdon

If the helper printed "connected": false even though the headset is on:
re-plug the dongle (so the new udev rule applies) and run with --debug:
  python3 ~/.local/share/gnome-shell/extensions/jabra-battery-indicator@henrik-leisdon/jabra-battery.py --debug
EOF
