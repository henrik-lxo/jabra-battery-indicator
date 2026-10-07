// Jabra Battery Indicator — top-bar battery level for a Jabra headset
// connected through its USB dongle (Link 370/380, ...).
//
// Polls the bundled jabra-battery.py helper, which speaks the Jabra GNP
// protocol over hidraw, and renders a headset icon with a vertical battery
// level bar in the panel, in the style of the Bluetooth Battery Meter
// extension: green when full, orange at medium, red when low.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const POLL_INTERVAL_SECONDS = 60;
const RETRY_INTERVAL_SECONDS = 15; // faster retry while nothing is connected

// Level bar geometry (logical pixels) and color thresholds, matching the
// Bluetooth Battery Meter look: a solid rounded bar without outline whose
// unfilled top part is muted foreground grey (colors sampled from BBM).
const BAR_WIDTH = 5;
const BAR_HEIGHT = 16;
const BAR_RADIUS = 2;
const TRACK_ALPHA = 0.5; // unfilled part: theme foreground at this alpha
const COLOR_FULL = [0x4e / 255, 0x9a / 255, 0x06 / 255];   // green,  > 50 %
const COLOR_MEDIUM = [0xf5 / 255, 0x79 / 255, 0x3e / 255]; // orange, 21–50 %
const COLOR_LOW = [0xe0 / 255, 0x1b / 255, 0x24 / 255];    // red,    ≤ 20 %
const COLOR_CHARGING = [0x35 / 255, 0x84 / 255, 0xe4 / 255]; // blue while charging

const JabraIndicator = GObject.registerClass(
class JabraIndicator extends PanelMenu.Button {
    _init(extensionPath) {
        super._init(0.5, 'Jabra Battery Indicator');
        this._extensionPath = extensionPath;
        this._percent = null;
        this._charging = false;

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'audio-headset-symbolic',
            style_class: 'system-status-icon',
        });
        this._bar = new St.DrawingArea({
            width: BAR_WIDTH,
            height: BAR_HEIGHT,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'jabra-battery-bar',
        });
        this._bar.connect('repaint', area => this._drawBar(area));
        box.add_child(this._icon);
        box.add_child(this._bar);
        this.add_child(box);

        this._deviceItem = new PopupMenu.PopupMenuItem('No Jabra headset found', {
            reactive: false,
        });
        this.menu.addMenuItem(this._deviceItem);
        this._statusItem = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this._statusItem);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        refreshItem.connect('activate', () => this.refresh());
        this.menu.addMenuItem(refreshItem);

        this._timeoutId = null;
        this._cancellable = null;
        this._destroyed = false;

        this.visible = false;
        this.refresh();
    }

    _drawBar(area) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();

        // Track color follows the shell theme (light/dark panels).
        let fg = {red: 255, green: 255, blue: 255, alpha: 255};
        try {
            fg = area.get_theme_node().get_foreground_color();
        } catch {
            // not mapped yet — keep fallback
        }

        // Full-height muted track (the unfilled part of the bar).
        this._roundedRect(cr, 0, 0, w, h, BAR_RADIUS);
        cr.setSourceRGBA(fg.red / 255, fg.green / 255, fg.blue / 255,
            (fg.alpha / 255) * TRACK_ALPHA);
        cr.fill();

        if (Number.isInteger(this._percent)) {
            let color;
            if (this._charging)
                color = COLOR_CHARGING;
            else if (this._percent > 50)
                color = COLOR_FULL;
            else if (this._percent > 20)
                color = COLOR_MEDIUM;
            else
                color = COLOR_LOW;

            // Fill from the bottom, clipped to the rounded bar shape so the
            // bottom corners stay rounded and the fill edge stays straight.
            const fillH = Math.max(2, Math.round(h * this._percent / 100));
            this._roundedRect(cr, 0, 0, w, h, BAR_RADIUS);
            cr.clip();
            cr.rectangle(0, h - fillH, w, fillH);
            cr.setSourceRGBA(color[0], color[1], color[2], 1.0);
            cr.fill();
        }

        cr.$dispose();
    }

    _roundedRect(cr, x, y, w, h, r) {
        r = Math.min(r, w / 2, h / 2);
        cr.newPath();
        cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
        cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
        cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
        cr.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
        cr.closePath();
    }

    refresh() {
        this._cancelPending();
        this._cancellable = new Gio.Cancellable();

        const helper = GLib.build_filenamev([this._extensionPath, 'jabra-battery.py']);
        let proc;
        try {
            proc = Gio.Subprocess.new(
                ['python3', helper],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            console.error(`jabra-battery-indicator: failed to spawn helper: ${e}`);
            this._update(null);
            this._schedule(RETRY_INTERVAL_SECONDS);
            return;
        }

        proc.communicate_utf8_async(null, this._cancellable, (p, res) => {
            if (this._destroyed)
                return;
            let state = null;
            try {
                const [, stdout, stderr] = p.communicate_utf8_finish(res);
                if (p.get_successful())
                    state = JSON.parse(stdout);
                else if (stderr)
                    console.error(`jabra-battery-indicator helper: ${stderr.trim()}`);
            } catch (e) {
                if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    console.error(`jabra-battery-indicator: ${e}`);
            }
            this._update(state);
            this._schedule(state?.connected
                ? POLL_INTERVAL_SECONDS
                : RETRY_INTERVAL_SECONDS);
        });
    }

    _update(state) {
        if (state?.connected && Number.isInteger(state.percent)) {
            this.visible = true;
            this._percent = state.percent;
            this._charging = !!state.charging;
            this._bar.queue_repaint();
            this._deviceItem.label.text = state.device ?? 'Jabra headset';
            this._statusItem.label.text = state.charging
                ? `Battery: ${state.percent}% (charging)`
                : `Battery: ${state.percent}%`;
        } else {
            // Hide the indicator entirely when no headset is reachable,
            // like Bluetooth Battery Meter does.
            this.visible = false;
            this._percent = null;
            this._charging = false;
            this._deviceItem.label.text = state?.dongle_present
                ? 'Dongle present — headset off or out of range'
                : 'No Jabra dongle found';
            this._statusItem.label.text = '';
        }
    }

    _schedule(seconds) {
        this._clearTimeout();
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeoutId = null;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimeout() {
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
    }

    _cancelPending() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

    destroy() {
        this._destroyed = true;
        this._clearTimeout();
        this._cancelPending();
        super.destroy();
    }
});

export default class JabraBatteryExtension extends Extension {
    enable() {
        this._indicator = new JabraIndicator(this.path);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
