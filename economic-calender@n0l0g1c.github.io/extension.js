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

const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes (feed rate-limits aggressively)
const MIN_NETWORK_GAP_MS = 5 * 60 * 1000; // never hit network more often than this
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // serve disk cache up to 24h when offline/rate-limited
const PANEL_TICK_MS = 30 * 1000; // update countdown on panel
const CALENDAR_URLS = [
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
];
// Identify this extension honestly (do not spoof a browser User-Agent)
const USER_AGENT = 'economic-calender@n0l0g1c.github.io/1.1';

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

function cacheFilePath() {
    return GLib.build_filenamev([
        GLib.get_user_cache_dir(),
        'economic-calender',
        'thisweek.json',
    ]);
}

/**
 * @returns {{events: object[], fetchedAt: number}|null}
 */
function loadCache() {
    const path = cacheFilePath();
    const file = Gio.File.new_for_path(path);
    try {
        if (!file.query_exists(null))
            return null;
        const [, contents] = file.load_contents(null);
        const text = new TextDecoder().decode(contents);
        const data = JSON.parse(text);
        if (!Array.isArray(data?.events))
            return null;
        return {
            events: data.events,
            fetchedAt: Number(data.fetchedAt) || 0,
        };
    } catch (e) {
        return null;
    }
}

/**
 * @param {object[]} rawEvents
 */
function saveCache(rawEvents) {
    const path = cacheFilePath();
    const file = Gio.File.new_for_path(path);
    try {
        const dir = file.get_parent();
        if (dir && !dir.query_exists(null))
            dir.make_directory_with_parents(null);
        const payload = JSON.stringify({
            fetchedAt: Date.now(),
            events: rawEvents,
        });
        file.replace_contents(
            new TextEncoder().encode(payload),
            null,
            false,
            Gio.FileCreateFlags.REPLACE_DESTINATION,
            null
        );
    } catch (e) {
        // Cache is best-effort; failures are non-fatal
    }
}

/**
 * Soup.Status enum does not include 429; use numeric status_code.
 * @param {Soup.Message} message
 * @returns {number}
 */
function httpStatus(message) {
    try {
        return message.status_code;
    } catch {
        try {
            return message.get_status();
        } catch {
            return 0;
        }
    }
}

/**
 * @param {object[]} rawList
 * @returns {object[]}
 */
function normalizeEvents(rawList) {
    const events = rawList.map(raw => {
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
    return events;
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

        // Keep the event list bounded and scrollable when there are many entries
        const scrollView = new St.ScrollView({
            style_class: 'vfade economic-calender-scroll',
            overlay_scrollbars: true,
            x_expand: true,
            child: this._listSection.box,
        });
        scrollView._delegate = this._listSection;
        this._listSection.actor = scrollView;

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
            this._fetchEvents({force: true}).catch(e => logError(e));
        });
        this.menu.addMenuItem(this._refreshItem);

        this._session = new Soup.Session({
            timeout: 20,
            user_agent: USER_AGENT,
        });
        this._cancellable = null;
        this._refreshSource = 0;
        this._tickSource = 0;
        this._fetching = false;
        this._lastNetworkAt = 0;
        this._lastSuccessAt = 0;

        // Load disk cache immediately so the menu is never empty on first open
        this._applyCacheIfAny();

        this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open || this._fetching)
                return;
            // Only refresh from network when opening if data is stale
            const age = Date.now() - this._lastSuccessAt;
            if (!this._events.length || age > REFRESH_INTERVAL_MS)
                this._fetchEvents({force: false}).catch(e => logError(e));
        });
    }

    _applyCacheIfAny() {
        const cached = loadCache();
        if (!cached)
            return false;
        const age = Date.now() - cached.fetchedAt;
        if (age > CACHE_MAX_AGE_MS)
            return false;

        this._events = normalizeEvents(cached.events);
        this._lastSuccessAt = cached.fetchedAt;
        this._rebuildList();
        this._updatePanel();
        const mins = Math.max(1, Math.round(age / 60000));
        this._statusItem.label.text =
            `Cached · ${mins}m ago · ${this._events.length} events this week`;
        return true;
    }

    _filterLabel() {
        return `Filter: ${FILTERS[this._filterIndex].label}`;
    }

    start() {
        this._fetchEvents({force: false}).catch(e => logError(e));
        this._refreshSource = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            REFRESH_INTERVAL_MS,
            () => {
                this._fetchEvents({force: false}).catch(e => logError(e));
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
            GLib.Source.remove(this._refreshSource);
            this._refreshSource = 0;
        }
        if (this._tickSource) {
            GLib.Source.remove(this._tickSource);
            this._tickSource = 0;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        this._events = [];
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

        for (const ev of upcoming) {
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

    /**
     * @param {{force?: boolean}} [opts]
     */
    async _fetchEvents(opts = {}) {
        const force = !!opts.force;
        if (this._fetching)
            return;

        const nowMs = Date.now();
        if (!force && this._events.length &&
            nowMs - this._lastSuccessAt < REFRESH_INTERVAL_MS) {
            return;
        }
        if (!force && nowMs - this._lastNetworkAt < MIN_NETWORK_GAP_MS) {
            if (!this._events.length)
                this._applyCacheIfAny();
            return;
        }

        this._fetching = true;

        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();

        this._statusItem.label.text = 'Updating…';

        try {
            const rawList = await this._downloadCalendar(this._cancellable);
            if (!this._session)
                return;

            saveCache(rawList);
            this._events = normalizeEvents(rawList);
            this._lastSuccessAt = Date.now();
            this._lastNetworkAt = this._lastSuccessAt;
            this._rebuildList();
            this._updatePanel();

            const now = GLib.DateTime.new_now_local();
            this._statusItem.label.text =
                `Updated: ${now.format('%H:%M:%S')} · ${this._events.length} events this week`;
        } catch (e) {
            const cancelled = e instanceof GLib.Error &&
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
            if (cancelled || !this._session)
                return;

            this._lastNetworkAt = Date.now();
            logError(e, 'Economic Calender refresh failed');

            // Prefer stale cache over empty UI
            if (this._applyCacheIfAny()) {
                const msg = String(e.message || e);
                if (msg.includes('429') || msg.toLowerCase().includes('rate'))
                    this._statusItem.label.text =
                        'Rate limited — showing cached calendar';
                else
                    this._statusItem.label.text =
                        `Offline cache — ${msg.slice(0, 40)}`;
            } else {
                const msg = String(e.message || e);
                if (msg.includes('429'))
                    this._statusItem.label.text =
                        'Rate limited — wait a few minutes, then Refresh';
                else
                    this._statusItem.label.text =
                        `Update failed — ${msg.slice(0, 48)}`;
            }
        } finally {
            this._fetching = false;
        }
    }

    /**
     * @param {Gio.Cancellable|null} cancellable
     * @returns {Promise<object[]>}
     */
    async _downloadCalendar(cancellable) {
        let lastError = null;

        for (const url of CALENDAR_URLS) {
            try {
                const message = Soup.Message.new('GET', url);
                if (!message)
                    throw new Error('Invalid calendar URL');

                message.request_headers.append('Accept', 'application/json');

                const bytes = await this._session.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    cancellable
                );

                const status = httpStatus(message);
                if (status === 429)
                    throw new Error('HTTP 429 rate limited');
                if (status < 200 || status >= 300)
                    throw new Error(`HTTP ${status}`);

                const text = new TextDecoder().decode(bytes.get_data());
                // Feed sometimes returns HTML error pages with 200 in edge cases
                if (text.trimStart().startsWith('<'))
                    throw new Error('Non-JSON response from calendar feed');

                const data = JSON.parse(text);
                if (!Array.isArray(data))
                    throw new Error('Unexpected calendar payload');
                if (data.length === 0)
                    throw new Error('Empty calendar');

                return data;
            } catch (e) {
                lastError = e;
            }
        }

        throw lastError || new Error('All calendar sources failed');
    }
}

export default class EconomicCalenderExtension extends Extension {
    /**
     * @param {string} role
     * @param {import('resource:///org/gnome/shell/ui/panelMenu.js').Button} indicator
     * @param {number} [position]
     * @param {'left'|'center'|'right'} [box]
     */
    _addToPanel(role, indicator, position = 0, box = 'center') {
        const existing = Main.panel.statusArea[role];
        if (existing) {
            try {
                existing.destroy();
            } catch {
                // ignore
            }
            if (Main.panel.statusArea[role])
                delete Main.panel.statusArea[role];
        }
        // position 0 in center places the indicator to the left of the clock
        Main.panel.addToStatusArea(role, indicator, position, box);
    }

    enable() {
        this._indicator = new EconomicCalenderIndicator();
        this._addToPanel(this.uuid, this._indicator, 0, 'center');
        this._indicator.start();
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
