// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');
Gio._promisify(Gio.File.prototype, 'replace_contents_async', 'replace_contents_finish');

const REFRESH_MS = 30 * 60 * 1000;
const MIN_GAP_MS = 5 * 60 * 1000;
const CACHE_MS = 24 * 60 * 60 * 1000;
const TICK_MS = 30 * 1000;
const FEED = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const CACHE = GLib.build_filenamev([
    GLib.get_user_cache_dir(), 'economic-calender', 'thisweek.json',
]);

const RANK = {High: 3, Medium: 2, Low: 1, Holiday: 0, None: 0};
const FILTERS = [
    {label: 'High impact only', min: 3},
    {label: 'Medium & high', min: 2},
    {label: 'All events', min: 0},
];

function impactClass(impact) {
    if (impact === 'High')
        return 'economic-calender-impact-high';
    if (impact === 'Medium')
        return 'economic-calender-impact-medium';
    return 'economic-calender-impact-low';
}

function relative(when, now) {
    const secs = when.to_unix() - now.to_unix();
    if (secs < -3600)
        return 'passed';
    if (secs < 0)
        return 'now';
    if (secs < 60)
        return 'in <1m';
    if (secs < 3600)
        return `in ${Math.floor(secs / 60)}m`;
    if (secs < 86400) {
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        return m ? `in ${h}h ${m}m` : `in ${h}h`;
    }
    const d = Math.floor(secs / 86400);
    return d === 1 ? 'in 1 day' : `in ${d} days`;
}

function normalize(list) {
    const events = [];
    for (const raw of list) {
        if (!raw.date)
            continue;
        const dt = GLib.DateTime.new_from_iso8601(raw.date, null);
        if (!dt)
            continue;
        events.push({
            title: raw.title || '',
            country: raw.country || '',
            impact: raw.impact || 'Low',
            forecast: raw.forecast || '',
            previous: raw.previous || '',
            _dt: dt,
        });
    }
    events.sort((a, b) => a._dt.to_unix() - b._dt.to_unix());
    return events;
}

class EventRow extends PopupMenu.PopupBaseMenuItem {
    static { GObject.registerClass(this); }

    constructor(ev) {
        const cls = impactClass(ev.impact);
        super({
            reactive: false,
            can_focus: false,
            style_class: `economic-calender-event ${cls}`,
        });
        this.add_child(new St.Label({
            text: ev.impact === 'High' || ev.impact === 'Medium' ? '*' : '-',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: `economic-calender-impact-dot ${cls}`,
        }));
        this.add_child(new St.Label({
            text: ev.time,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'economic-calender-time',
        }));
        this.add_child(new St.Label({
            text: ev.country || '—',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'economic-calender-country',
        }));
        const title = new St.Label({
            text: ev.title,
            style_class: 'economic-calender-title',
            x_expand: true,
        });
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(title);
        if (ev.metrics) {
            this.add_child(new St.Label({
                text: ev.metrics,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'economic-calender-metrics',
            }));
        }
    }
}

class Indicator extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    constructor() {
        super(0.5, 'Economic Calender', false);

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        box.add_child(new St.Icon({
            icon_name: 'x-office-calendar-symbolic',
            style_class: 'system-status-icon',
        }));
        this._name = new St.Label({
            text: 'Econ',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'economic-calender-panel-label',
        });
        this._next = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'economic-calender-panel-next',
        });
        box.add_child(this._name);
        box.add_child(this._next);
        this.add_child(box);

        this._filter = 0;
        this._events = [];
        this._list = new PopupMenu.PopupMenuSection();
        const scroll = new St.ScrollView({
            style_class: 'vfade economic-calender-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            child: this._list.box,
        });
        scroll._delegate = this._list;
        this._list.actor = scroll;
        this.menu.addMenuItem(this._list);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._filterItem = new PopupMenu.PopupMenuItem(
            `Filter: ${FILTERS[0].label}`);
        this._filterItem.connect('activate', () => {
            this._filter = (this._filter + 1) % FILTERS.length;
            this._filterItem.label.text = `Filter: ${FILTERS[this._filter].label}`;
            this._rebuild();
            this._tickPanel();
        });
        this.menu.addMenuItem(this._filterItem);

        this._note = new PopupMenu.PopupMenuItem('Updated: —', {
            reactive: false, can_focus: false,
        });
        this._note.label.add_style_class_name('economic-calender-status');
        this.menu.addMenuItem(this._note);

        const refresh = new PopupMenu.PopupMenuItem('Refresh now');
        refresh.connect('activate', () => this._load(true).catch(e => logError(e)));
        this.menu.addMenuItem(refresh);

        this._session = new Soup.Session({
            timeout: 20,
            user_agent: 'economic-calender@n0l0g1c.github.io/1.1',
        });
        this._cancel = null;
        this._refreshTimer = 0;
        this._tickTimer = 0;
        this._openId = 0;
        this._busy = false;
        this._lastNet = 0;
        this._lastOk = 0;

        this._openId = this.menu.connect('open-state-changed', (_m, open) => {
            if (!open || this._busy)
                return;
            if (!this._events.length || Date.now() - this._lastOk > REFRESH_MS)
                this._load(false).catch(e => logError(e));
        });
    }

    async _readCache() {
        try {
            const file = Gio.File.new_for_path(CACHE);
            if (!file.query_exists(null))
                return false;
            const [, bytes] = await file.load_contents_async(null);
            const data = JSON.parse(new TextDecoder().decode(bytes));
            if (!data || !Array.isArray(data.events))
                return false;
            const age = Date.now() - (Number(data.fetchedAt) || 0);
            if (age > CACHE_MS)
                return false;
            this._events = normalize(data.events);
            this._lastOk = Number(data.fetchedAt) || 0;
            this._rebuild();
            this._tickPanel();
            const mins = Math.max(1, Math.round(age / 60000));
            this._note.label.text =
                `Cached · ${mins}m ago · ${this._events.length} events`;
            return true;
        } catch {
            return false;
        }
    }

    async _writeCache(raw) {
        try {
            const file = Gio.File.new_for_path(CACHE);
            const dir = file.get_parent();
            if (dir && !dir.query_exists(null))
                dir.make_directory_with_parents(null);
            await file.replace_contents_async(
                new TextEncoder().encode(JSON.stringify({
                    fetchedAt: Date.now(), events: raw,
                })),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null
            );
        } catch {
            // optional
        }
    }

    async start() {
        await this._readCache();
        this._load(false).catch(e => logError(e));
        this._refreshTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REFRESH_MS, () => {
            this._load(false).catch(e => logError(e));
            return GLib.SOURCE_CONTINUE;
        });
        this._tickTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            this._tickPanel();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._openId) {
            this.menu.disconnect(this._openId);
            this._openId = 0;
        }
        if (this._refreshTimer) {
            GLib.Source.remove(this._refreshTimer);
            this._refreshTimer = 0;
        }
        if (this._tickTimer) {
            GLib.Source.remove(this._tickTimer);
            this._tickTimer = 0;
        }
        if (this._cancel) {
            this._cancel.cancel();
            this._cancel = null;
        }
        this._events = [];
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        super.destroy();
    }

    _upcoming() {
        const now = GLib.DateTime.new_now_local();
        const start = GLib.DateTime.new_local(
            now.get_year(), now.get_month(), now.get_day_of_month(), 0, 0, 0);
        const min = FILTERS[this._filter].min;
        return this._events.filter(ev => {
            if (ev._dt.to_unix() < start.to_unix())
                return false;
            return (RANK[ev.impact] || 0) >= min;
        });
    }

    _rebuild() {
        this._list.removeAll();
        const list = this._upcoming();
        if (!list.length) {
            const empty = new PopupMenu.PopupMenuItem(
                this._events.length ? 'No events match this filter' : 'Loading…',
                {reactive: false, can_focus: false}
            );
            empty.label.add_style_class_name('economic-calender-empty');
            this._list.addMenuItem(empty);
            return;
        }

        let lastDay = '';
        const now = GLib.DateTime.new_now_local();
        const today = now.format('%Y-%m-%d');
        const tomorrow = now.add_days(1).format('%Y-%m-%d');

        for (const ev of list) {
            const key = ev._dt.format('%Y-%m-%d');
            if (key !== lastDay) {
                lastDay = key;
                let text = ev._dt.format('%A, %b %e');
                if (key === today)
                    text = `Today — ${ev._dt.format('%a %b %e')}`;
                else if (key === tomorrow)
                    text = `Tomorrow — ${ev._dt.format('%a %b %e')}`;
                const header = new PopupMenu.PopupMenuItem(text, {
                    reactive: false, can_focus: false,
                });
                header.label.add_style_class_name('economic-calender-day-header');
                this._list.addMenuItem(header);
            }

            const parts = [];
            if (ev.previous)
                parts.push(`P: ${ev.previous}`);
            if (ev.forecast)
                parts.push(`F: ${ev.forecast}`);
            this._list.addMenuItem(new EventRow({
                time: ev._dt.format('%H:%M'),
                country: ev.country,
                title: ev.title || 'Event',
                impact: ev.impact,
                metrics: parts.join('  '),
            }));
        }
    }

    _tickPanel() {
        const min = FILTERS[this._filter].min;
        const now = GLib.DateTime.new_now_local();
        const next = this._events.find(ev => {
            if (ev._dt.to_unix() < now.to_unix() - 60)
                return false;
            return (RANK[ev.impact] || 0) >= min;
        });
        if (!next) {
            this._next.text = '';
            return;
        }
        this._next.text =
            `${relative(next._dt, now)} · ${(next.title || 'Event').slice(0, 28)}`;
        this._next.style_class =
            `economic-calender-panel-next ${impactClass(next.impact)}`;
    }

    async _load(force) {
        if (this._busy)
            return;
        const now = Date.now();
        if (!force && this._events.length && now - this._lastOk < REFRESH_MS)
            return;
        if (!force && now - this._lastNet < MIN_GAP_MS) {
            if (!this._events.length)
                await this._readCache();
            return;
        }

        this._busy = true;
        if (this._cancel)
            this._cancel.cancel();
        this._cancel = new Gio.Cancellable();
        this._note.label.text = 'Updating…';

        try {
            const msg = Soup.Message.new('GET', FEED);
            msg.request_headers.append('Accept', 'application/json');
            const bytes = await this._session.send_and_read_async(
                msg, GLib.PRIORITY_DEFAULT, this._cancel);
            if (!this._session)
                return;
            if (msg.status_code === 429)
                throw new Error('HTTP 429 rate limited');
            if (msg.status_code < 200 || msg.status_code >= 300)
                throw new Error(`HTTP ${msg.status_code}`);
            const text = new TextDecoder().decode(bytes.get_data());
            if (text.trimStart().startsWith('<'))
                throw new Error('non-JSON response');
            const data = JSON.parse(text);
            if (!Array.isArray(data) || !data.length)
                throw new Error('empty calendar');

            await this._writeCache(data);
            this._events = normalize(data);
            this._lastOk = Date.now();
            this._lastNet = this._lastOk;
            this._rebuild();
            this._tickPanel();
            this._note.label.text =
                `Updated: ${GLib.DateTime.new_now_local().format('%H:%M:%S')} · ${this._events.length} events`;
        } catch (e) {
            if (e instanceof GLib.Error &&
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!this._session)
                return;
            this._lastNet = Date.now();
            logError(e, 'Economic Calender refresh failed');
            const msg = String(e.message || e);
            if (await this._readCache()) {
                this._note.label.text = msg.includes('429')
                    ? 'Rate limited — showing cache'
                    : `Offline cache — ${msg.slice(0, 40)}`;
            } else {
                this._note.label.text = msg.includes('429')
                    ? 'Rate limited — try again later'
                    : `Update failed — ${msg.slice(0, 48)}`;
            }
        } finally {
            this._busy = false;
        }
    }
}

export default class EconomicCalenderExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'center');
        this._indicator.start().catch(e => logError(e));
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
