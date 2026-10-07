# Jabra Battery Indicator

A GNOME Shell top-bar indicator showing the battery level of a **Jabra headset
connected through its USB dongle** (Jabra Link 370 / 380 / 390, …) — in the
spirit of the [Bluetooth Battery Meter](https://extensions.gnome.org/extension/6670/bluetooth-battery-meter/)
extension, which cannot see dongle-connected headsets because they are not
paired with the PC's own Bluetooth adapter.

The panel shows a headset icon with a small vertical battery bar next to it
(like Bluetooth Battery Meter): **green** above 50 %, **orange** at 21–50 %,
**red** at 20 % and below, **blue** while charging. The exact percentage is
shown in the click-menu.

## How it works

The dongle exposes a vendor HID interface speaking Jabra's proprietary **GNP
protocol**. The bundled `jabra-battery.py` helper (pure Python, stdlib only):

1. Finds hidraw nodes belonging to Jabra devices (USB vendor ID `0b0e`).
2. Sends a GNP *battery status* read request (report ID `0x05`, command
   `0x12`, subcommand `0x02`) addressed to the headset.
3. Parses the response: payload byte 1 = percentage, byte 0 bit 0 = charging.
4. Falls back to `/sys/class/power_supply` in case the kernel already exposes
   a standard HID battery for the device.
5. Prints JSON, e.g. `{"connected": true, "percent": 80, "charging": false, "device": "Jabra Link 380"}`.

The GNOME extension runs the helper every 60 s (every 15 s while nothing is
connected) and shows an icon + percentage in the panel. The indicator hides
itself when no headset is reachable. Clicking it shows the device name,
battery details, and a "Refresh now" item.

The protocol details come from the reverse-engineering work in
[michidold/jabraw](https://github.com/michidold/jabraw) (GPL-3.0-or-later).

## Requirements

- GNOME Shell **45–49** (uses the modern ESM extension API)
- Python 3 (any recent version; no pip packages needed)
- A udev rule granting your user access to the dongle's hidraw node
  (installed by `install.sh`)

## Install

```bash
./install.sh
```

This:
- copies the extension to `~/.local/share/gnome-shell/extensions/jabra-battery-indicator@henrik-leisdon/`
  (with the helper script inside it),
- installs `/etc/udev/rules.d/61-jabra-battery.rules` (asks for sudo) and
  reloads udev,
- runs the helper once as a smoke test,
- tries to enable the extension.

**On Wayland, log out and back in** so GNOME Shell loads the new extension
(on X11: Alt+F2, `r`, Enter). Then, if needed:

```bash
gnome-extensions enable jabra-battery-indicator@henrik-leisdon
```

## Testing the helper on its own

```bash
python3 jabra-battery.py            # JSON result
python3 jabra-battery.py --debug    # raw HID traffic on stderr
```

Expected output with the headset powered on:

```json
{"connected": true, "percent": 80, "charging": false, "device": "Jabra Link 380", "source": "gnp"}
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `"connected": false, "dongle_present": false` | Dongle not detected — check `lsusb \| grep -i 0b0e` and that the headset dongle is plugged in. |
| `"connected": false, "dongle_present": true` | Headset is off/out of range, **or** permissions: re-plug the dongle after installing the udev rule so the `uaccess` tag applies. Run with `--debug` — "Permission denied" on open means udev. |
| Write errors in `--debug` output | Normal for the dongle's non-vendor HID interfaces; the helper tries each node until one answers. |
| Indicator never appears | It hides when disconnected by design. Check `journalctl --user -f /usr/bin/gnome-shell` for `jabra-battery-indicator` errors. |
| GNOME < 45 | The extension uses the ESM API introduced in GNOME 45. For 42–44 the `extension.js` would need the legacy `imports.*` style — open an issue/ask and it can be back-ported. |

## Files

```
jabra-battery.py                       # standalone CLI helper (GNP over hidraw)
gnome-extension/
  jabra-battery-indicator@henrik-leisdon/
    extension.js                       # panel indicator, polls the helper
    metadata.json
    stylesheet.css
udev/61-jabra-battery.rules            # user access to Jabra hidraw nodes
install.sh / uninstall.sh
```

## Credits

- Protocol: [michidold/jabraw](https://github.com/michidold/jabraw) — Jabra
  GNP over raw HID, developed against an Evolve2 65 + Link 380.
- UI inspiration: [Bluetooth Battery Meter](https://extensions.gnome.org/extension/6670/bluetooth-battery-meter/).
