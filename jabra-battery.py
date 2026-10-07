#!/usr/bin/env python3
"""Query the battery level of a Jabra headset through its USB dongle.

Speaks the (reverse-engineered) Jabra GNP protocol over hidraw, as documented
by the jabraw project (https://github.com/michidold/jabraw, GPL-3.0-or-later).

Packet layout (vendor report, HID report ID 0x05, 63-byte body):
  byte 0: destination (0x01 dongle, 0x04 headset)
  byte 1: source      (0x00 PC)
  byte 2: sequence number
  byte 3: type << 6 | total length (header + payload)
  byte 4: command
  byte 5: subcommand
  6..  : payload

Battery status: command 0x12, subcommand 0x02. In the response payload,
byte 1 is the percentage and bit 0 of byte 0 is the charging flag.

Outputs JSON on stdout, e.g.:
  {"connected": true, "percent": 80, "charging": false, "device": "Jabra Link 380"}

Requires read/write access to /dev/hidraw* (see udev/61-jabra-battery.rules).
Only the Python standard library is used.
"""

import glob
import json
import os
import select
import sys
import time

JABRA_VENDOR = 0x0B0E  # GN Audio / GN Netcom (USB)

REPORT_ID = 0x05
REPORT_SIZE = 63
HEADER_LEN = 6

TYPE_READ = 1
TYPE_WRITE = 2
TYPE_RESPONSE = 3

CMD_STATUS = 0x12
SUB_HS_BATTERY = 0x02

DST_DONGLE = 0x01
DST_HEADSET = 0x04
SRC_PC = 0x00

READ_TIMEOUT = 1.5  # seconds to wait for a response per device/destination

DEBUG = "--debug" in sys.argv


def debug(msg):
    if DEBUG:
        print(msg, file=sys.stderr)


def find_jabra_hidraw():
    """Yield (dev_path, name) for every hidraw node owned by a Jabra device."""
    for uevent in sorted(glob.glob("/sys/class/hidraw/hidraw*/device/uevent")):
        try:
            with open(uevent) as f:
                fields = dict(
                    line.strip().split("=", 1) for line in f if "=" in line
                )
        except OSError:
            continue
        hid_id = fields.get("HID_ID", "")  # e.g. 0003:00000B0E:000024C7
        parts = hid_id.split(":")
        if len(parts) != 3:
            continue
        try:
            vendor = int(parts[1], 16)
        except ValueError:
            continue
        if vendor != JABRA_VENDOR:
            continue
        node = uevent.split("/")[4]  # hidrawN
        name = fields.get("HID_NAME", "Jabra device")
        yield f"/dev/{node}", name


def build_request(dst, seq):
    body = bytes([dst, SRC_PC, seq, (TYPE_READ << 6) | HEADER_LEN,
                  CMD_STATUS, SUB_HS_BATTERY])
    return bytes([REPORT_ID]) + body + b"\x00" * (REPORT_SIZE - len(body))


def parse_battery(buf):
    """Return (percent, charging) if buf is a valid GNP battery status report.

    Reports must originate from the headset itself (source 0x04) and carry a
    plausible percentage: when the headset is powered off, the dongle answers
    in its place with 0 %, which we must not display as a real reading.
    """
    if not buf or buf[0] != REPORT_ID:
        return None
    body = buf[1:]
    if len(body) < HEADER_LEN + 2:
        return None
    src = body[1]
    msg_type = body[3] >> 6
    length = body[3] & 0x3F
    if msg_type not in (TYPE_WRITE, TYPE_RESPONSE):
        return None
    if length < HEADER_LEN + 2 or length > len(body):
        return None
    if body[4] != CMD_STATUS or body[5] != SUB_HS_BATTERY:
        return None
    if src != DST_HEADSET:
        return None
    data = body[HEADER_LEN:length]
    percent = data[1]
    if percent == 0 or percent > 100:
        return None
    charging = bool(data[0] & 1)
    return percent, charging


def query_device(path):
    """Ask one hidraw node for the headset battery. Returns (percent, charging) or None."""
    try:
        fd = os.open(path, os.O_RDWR | os.O_NONBLOCK)
    except OSError as e:
        debug(f"{path}: open failed: {e}")
        return None
    try:
        seq = int(time.time()) & 0x7F
        # Only query the headset itself; the dongle answers for an
        # unreachable headset with a bogus 0 % which parse_battery rejects.
        for dst in (DST_HEADSET,):
            seq = (seq + 1) & 0x7F
            try:
                os.write(fd, build_request(dst, seq))
            except OSError as e:
                debug(f"{path}: write (dst={dst:#x}) failed: {e}")
                continue
            deadline = time.monotonic() + READ_TIMEOUT
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                ready, _, _ = select.select([fd], [], [], remaining)
                if not ready:
                    break
                try:
                    buf = os.read(fd, 65)
                except OSError as e:
                    debug(f"{path}: read failed: {e}")
                    break
                if DEBUG:
                    debug(f"{path}: <- {buf.hex()}")
                result = parse_battery(buf)
                if result:
                    return result
        return None
    finally:
        os.close(fd)


def query_power_supply():
    """Fallback: some devices expose a standard HID battery via the kernel."""
    for base in glob.glob("/sys/class/power_supply/*"):
        try:
            with open(os.path.join(base, "uevent")) as f:
                fields = dict(
                    line.strip().split("=", 1) for line in f if "=" in line
                )
        except OSError:
            continue
        model = fields.get("POWER_SUPPLY_MODEL_NAME", "")
        if "jabra" not in model.lower():
            continue
        try:
            percent = int(fields.get("POWER_SUPPLY_CAPACITY", ""))
        except ValueError:
            continue
        charging = fields.get("POWER_SUPPLY_STATUS", "") == "Charging"
        return percent, charging, model
    return None


def main():
    devices = list(find_jabra_hidraw())
    debug(f"Jabra hidraw nodes: {devices}")

    for path, name in devices:
        result = query_device(path)
        if result:
            percent, charging = result
            print(json.dumps({
                "connected": True,
                "percent": percent,
                "charging": charging,
                "device": name,
                "source": "gnp",
            }))
            return 0

    ps = query_power_supply()
    if ps:
        percent, charging, model = ps
        print(json.dumps({
            "connected": True,
            "percent": percent,
            "charging": charging,
            "device": model,
            "source": "power_supply",
        }))
        return 0

    print(json.dumps({
        "connected": False,
        "dongle_present": bool(devices),
        "device": devices[0][1] if devices else None,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
