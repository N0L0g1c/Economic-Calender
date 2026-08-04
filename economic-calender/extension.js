// Economic Calender — GNOME Shell top-panel macro event calendar
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

const REFRESH_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const PANEL_TICK_MS = 30 * 1000; // update countdown on panel
const CALENDAR_URL =
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

/** @typedef {'High'|'Medium'|'Low'|'Holiday'|'None'|string} Impact */

const IMPACT_RANK = {
    High: 3,
    Medium: 2,
    Low: 1,
    Holiday: 0,
    None: 0,
};

const FILTERS = [
    {id: 'high', label: 'High impact only', minRank: 3},
    {id: 'medium', label: 'Medium & high', minRank: 2},
    {id: 'all', label: 'All events', minRank: 0},
];

/**
 * @param {string} iso
 * @returns {GLib.DateTime|null}
 */
function parseEventDate(iso) {
    if (!iso)
        return null;
    // GLib accepts many ISO-8601 forms including offsets
    const dt = GLib.DateTime.new_from_iso8601(iso, null);
    return dt;
}

/**
 * @param {GLib.DateTime} dt
 */
function dayKey(dt) {
    return dt.format('%Y-%m-%d');
}

/**
 * @param {GLib.DateTime} dt
 */
function dayLabel(dt) {
    const now = GLib.DateTime.new_now_local();
    const today = dayKey(now);
    const tomorrow = dayKey(now.add_days(1));
    const key = dayKey(dt);
    if (key === today)
        return `Today — ${dt.format('%a %b %e')}`;
    if (key === tomorrow)
        return `Tomorrow — ${dt.format('%a %b %e')}`;
    return dt.format('%A, %b %e');
}

/**
 * @param {Impact} impact
 */
function impactStyle(impact) {
    switch (impact) {
    case 'High':
        return 'economic-calender-impact-high';
    case 'Medium':
        return 'economic-calender-impact-medium';
    default:
        return 'economic-calender-impact-low';
    }
}

/**
 * @param {Impact} impact
 */
function impactDot(impact) {
    switch (impact) {
    case 'High':
        return '●';
    case 'Medium':
        return '●';
    default:
        return '○';
    }
}

/**
 * Human countdown / relative label.
 * @param {GLib.DateTime} when
 * @param {GLib.DateTime} now
 */
function relativeLabel(when, now) {
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

/**
 * @param {string} forecast
 * @param {string} previous
 */
function metricsText(forecast, previous) {
    const parts = [];
    if (previous)
        parts.push(`P: ${previous}`);
    if (forecast)
        parts.push(`F: ${forecast}`);
    return parts.join('  ');
}

class EventRow extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    /**
     * @param {{
     *   time: string,
     *   country: string,
     *   title: string,
     *   impact: string,
     *   metrics: string,
     * }} event
     */
    constructor(event) {
        super({
            reactive: false,
            can_focus: false,
            style_class: `economic-calender-event ${impactStyle(event.impact)}`,
        });

        const dot = new St.Label({
            text: impactDot(event.impact),
            y_align: Clutter.ActorAlign.CENTER,
            style_class: `economic-calender-impact-dot ${impactStyle(event.impact)}`,
        });
        this.add_child(dot);

        const time = new St.Label({
            text: event.time,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'economic-calender-time',
        });
        this.add_child(time);

        const country = new St.Label({
            text: event.country || '—',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'economic-calender-country',
        });
        this.add_child(country);

        const titleBox = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const title = new St.Label({
            text: event.title,
            style_class: 'economic-calender-title',
        });
        title.clutter_text.line_wrap = false;
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        titleBox.add_child(title);
        this.add_child(titleBox);

        if (event.metrics) {
            const metrics = new St.Label({
                text: event.metrics,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'economic-calender-metrics',
            });
            this.add_child(metrics);
        }
    }
}

class EconomicCalenderIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(0.5, 'Economic Calender', false);

        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        this._panelIcon = new St.Icon({
            icon_name: 'x-office-calendar-symbolic',
            style_class: 'system-status-icon',
        });
        box.add_child(this._panelIcon);

        this._panelLabel = new St.Label({
            text: 'Econ',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'economic-calender-panel-label',
        });
        box.add_child(this._panelLabel);

        this._panelNext = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'economic-calender-panel-next',
        });
        box.add_child(this._panelNext);

        this.add_child(box);

        /** @type {number} */
        this._filterIndex = 0; // high impact default

        /** @type {object[]} */
        this._events = [];

        /** @type {PopupMenu.PopupMenuSection} */
        this._listSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._listSection);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._filterItem = new PopupMenu.PopupMenuItem(this._filterLabel());
        this._filterItem.label.add_style_class_name('economic-calender-filter');
        this._filterItem.connect('activate', () => {
            this._filterIndex = (this._filterIndex + 1) % FILTERS.length;
            this._filterItem.label.text = this._filterLabel();
            this._rebuildList();
            this._updatePanel();
        });
        this.menu.addMenuItem(this._filterItem);

        this._statusItem = new PopupMenu.PopupMenuItem('Updated: —', {
            reactive: false,
            can_focus: false,
        });
        this._statusItem.label.add_style_class_name('economic-calender-status');
        this.menu.addMenuItem(this._statusItem);

        this._refreshItem = new PopupMenu.PopupMenuItem('Refresh now');
        this._refreshItem.label.add_style_class_name('economic-calender-refresh');
        this._refreshItem.connect('activate', () => {
            this._fetchEvents().catch(e => logError(e));
        });
        this.menu.addMenuItem(this._refreshItem);

        this._session = new Soup.Session({
            timeout: 20,
            user_agent: 'EconomicCalenderGNOME/1.0 (GNOME Shell extension)',
        });
        this._cancellable = null;
        this._refreshSource = 0;
        this._tickSource = 0;
        this._fetching = false;

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open && !this._fetching)
                this._fetchEvents().catch(e => logError(e));
        });
    }

    _filterLabel() {
        return `Filter: ${FILTERS[this._filterIndex].label}`;
    }

    start() {
        this._fetchEvents().catch(e => logError(e));
        this._refreshSource = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            REFRESH_INTERVAL_MS,
            () => {
                this._fetchEvents().catch(e => logError(e));
                return GLib.SOURCE_CONTINUE;
            }
        );
        this._tickSource = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            PANEL_TICK_MS,
            () => {
                this._updatePanel();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    destroy() {
        if (this._refreshSource) {
            GLib.source_remove(this._refreshSource);
            this._refreshSource = 0;
        }
        if (this._tickSource) {
            GLib.source_remove(this._tickSource);
            this._tickSource = 0;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._session = null;
        super.destroy();
    }

    /**
     * @returns {object[]}
     */
    _filteredUpcoming() {
        const now = GLib.DateTime.new_now_local();
        // Keep events from start of today so "today's morning" still listed if recent
        const startOfToday = GLib.DateTime.new_local(
            now.get_year(),
            now.get_month(),
            now.get_day_of_month(),
            0, 0, 0
        );
        const minRank = FILTERS[this._filterIndex].minRank;

        return this._events.filter(ev => {
            if (!ev._dt)
                return false;
            if (ev._dt.to_unix() < startOfToday.to_unix())
                return false;
            const rank = IMPACT_RANK[ev.impact] ?? 0;
            return rank >= minRank;
        });
    }

    /**
     * Next event that is still in the future (for panel countdown).
     */
    _nextFutureEvent() {
        const nowUnix = GLib.DateTime.new_now_local().to_unix();
        const minRank = FILTERS[this._filterIndex].minRank;
        return this._events.find(ev => {
            if (!ev._dt)
                return false;
            if (ev._dt.to_unix() < nowUnix - 60)
                return false;
            const rank = IMPACT_RANK[ev.impact] ?? 0;
            return rank >= minRank;
        }) ?? null;
    }

    _rebuildList() {
        this._listSection.removeAll();

        const upcoming = this._filteredUpcoming();
        if (upcoming.length === 0) {
            const empty = new PopupMenu.PopupMenuItem(
                this._events.length
                    ? 'No events match this filter'
                    : 'Loading calendar…',
                {reactive: false, can_focus: false}
            );
            empty.label.add_style_class_name('economic-calender-empty');
            this._listSection.addMenuItem(empty);
            return;
        }

        let lastDay = '';
        let shown = 0;
        const maxEvents = 40;

        for (const ev of upcoming) {
            if (shown >= maxEvents)
                break;

            const key = dayKey(ev._dt);
            if (key !== lastDay) {
                lastDay = key;
                const header = new PopupMenu.PopupMenuItem(dayLabel(ev._dt), {
                    reactive: false,
                    can_focus: false,
                });
                header.label.add_style_class_name('economic-calender-day-header');
                this._listSection.addMenuItem(header);
            }

            const row = new EventRow({
                time: ev._dt.format('%H:%M'),
                country: ev.country || '',
                title: ev.title || 'Event',
                impact: ev.impact || 'Low',
                metrics: metricsText(ev.forecast || '', ev.previous || ''),
            });
            this._listSection.addMenuItem(row);
            shown++;
        }

        if (upcoming.length > maxEvents) {
            const more = new PopupMenu.PopupMenuItem(
                `…and ${upcoming.length - maxEvents} more this week`,
                {reactive: false, can_focus: false}
            );
            more.label.add_style_class_name('economic-calender-status');
            this._listSection.addMenuItem(more);
        }
    }

    _updatePanel() {
        const next = this._nextFutureEvent();
        if (!next) {
            this._panelNext.text = '';
            this._panelNext.style_class = 'economic-calender-panel-next';
            return;
        }

        const now = GLib.DateTime.new_now_local();
        const rel = relativeLabel(next._dt, now);
        const title = (next.title || 'Event').slice(0, 28);
        this._panelNext.text = `${rel} · ${title}`;
        this._panelNext.style_class =
            `economic-calender-panel-next ${impactStyle(next.impact)}`;
    }

    async _fetchEvents() {
        if (this._fetching)
            return;
        this._fetching = true;

        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();

        this._statusItem.label.text = 'Updating…';

        try {
            const message = Soup.Message.new('GET', CALENDAR_URL);
            if (!message)
                throw new Error('Invalid calendar URL');

            const bytes = await this._session.send_and_read_async(
                message,
                GLib.PRIORITY_DEFAULT,
                this._cancellable
            );

            if (message.get_status() !== Soup.Status.OK)
                throw new Error(`HTTP ${message.get_status()}`);

            const text = new TextDecoder().decode(bytes.get_data());
            const data = JSON.parse(text);
            if (!Array.isArray(data))
                throw new Error('Unexpected calendar payload');

            const events = data.map(raw => {
                const dt = parseEventDate(raw.date);
                return {
                    title: raw.title || '',
                    country: raw.country || '',
                    impact: raw.impact || 'Low',
                    forecast: raw.forecast || '',
                    previous: raw.previous || '',
                    date: raw.date,
                    _dt: dt,
                };
            }).filter(e => e._dt);

            events.sort((a, b) => a._dt.to_unix() - b._dt.to_unix());

            if (!this._session)
                return;

            this._events = events;
            this._rebuildList();
            this._updatePanel();

            const now = GLib.DateTime.new_now_local();
            this._statusItem.label.text =
                `Updated: ${now.format('%H:%M:%S')} · ${events.length} events this week`;
        } catch (e) {
            const cancelled = e instanceof GLib.Error &&
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
            if (!cancelled && this._session) {
                logError(e, 'Economic Calender refresh failed');
                this._statusItem.label.text = 'Update failed — try again';
            }
        } finally {
            this._fetching = false;
        }
    }
}

export default class EconomicCalenderExtension extends Extension {
    enable() {
        this._indicator = new EconomicCalenderIndicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._indicator.start();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
