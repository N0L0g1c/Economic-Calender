// SPDX-License-Identifier: GPL-2.0-or-later
/* weekly macro calendar in the panel */

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

const URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const CACHE = `${GLib.get_user_cache_dir()}/economic-calender/thisweek.json`;
const RANK = {High: 3, Medium: 2, Low: 1};

const CalButton = GObject.registerClass(
class CalButton extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Economic Calender');

        this.tag = new St.Label({
            text: 'Econ',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.next = new St.Label({
            text: '',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const box = new St.BoxLayout();
        box.add_child(this.tag);
        box.add_child(this.next);
        this.add_child(box);

        this.events = [];
        this.minRank = 3; // high only
        this.session = new Soup.Session({timeout: 20});
        this.cancel = null;
        this.busy = false;
        this.lastOk = 0;
        this.lastNet = 0;
        this.tRefresh = 0;
        this.tTick = 0;

        this.list = new PopupMenu.PopupMenuSection();
        const scroll = new St.ScrollView({
            style_class: 'economic-calender-scroll',
            overlay_scrollbars: true,
            child: this.list.box,
        });
        scroll._delegate = this.list;
        this.list.actor = scroll;
        this.menu.addMenuItem(this.list);
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.filterItem = new PopupMenu.PopupMenuItem('Filter: high only');
        this.filterItem.connect('activate', () => {
            if (this.minRank === 3) {
                this.minRank = 2;
                this.filterItem.label.text = 'Filter: med+high';
            } else if (this.minRank === 2) {
                this.minRank = 0;
                this.filterItem.label.text = 'Filter: all';
            } else {
                this.minRank = 3;
                this.filterItem.label.text = 'Filter: high only';
            }
            this.fill();
            this.updateNext();
        });
        this.menu.addMenuItem(this.filterItem);

        this.footer = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this.footer);
        const ref = new PopupMenu.PopupMenuItem('Refresh');
        ref.connect('activate', () => this.download(true));
        this.menu.addMenuItem(ref);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open && Date.now() - this.lastOk > 30 * 60 * 1000)
                this.download(false);
        });

        this.boot();
    }

    async boot() {
        await this.loadCache();
        this.download(false);
        this.tRefresh = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1800, () => {
            this.download(false);
            return GLib.SOURCE_CONTINUE;
        });
        this.tTick = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
            this.updateNext();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this.tRefresh) {
            GLib.Source.remove(this.tRefresh);
            this.tRefresh = 0;
        }
        if (this.tTick) {
            GLib.Source.remove(this.tTick);
            this.tTick = 0;
        }
        if (this.cancel) {
            this.cancel.cancel();
            this.cancel = null;
        }
        if (this.session) {
            this.session.abort();
            this.session = null;
        }
        super.destroy();
    }

    async loadCache() {
        try {
            const f = Gio.File.new_for_path(CACHE);
            if (!f.query_exists(null))
                return false;
            const [, b] = await f.load_contents_async(null);
            const j = JSON.parse(new TextDecoder().decode(b));
            if (!j.events || !j.events.length)
                return false;
            if (Date.now() - (j.at || 0) > 24 * 3600 * 1000)
                return false;
            this.events = this.normalize(j.events);
            this.lastOk = j.at || 0;
            this.fill();
            this.updateNext();
            this.footer.label.text = 'cached';
            return true;
        } catch (e) {
            return false;
        }
    }

    async saveCache(raw) {
        try {
            const f = Gio.File.new_for_path(CACHE);
            const d = f.get_parent();
            if (!d.query_exists(null))
                d.make_directory_with_parents(null);
            await f.replace_contents_async(
                new TextEncoder().encode(JSON.stringify({at: Date.now(), events: raw})),
                null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) { /* ignore */ }
    }

    normalize(raw) {
        const out = [];
        for (const e of raw) {
            if (!e.date)
                continue;
            const dt = GLib.DateTime.new_from_iso8601(e.date, null);
            if (!dt)
                continue;
            out.push({
                title: e.title || '',
                country: e.country || '',
                impact: e.impact || 'Low',
                forecast: e.forecast || '',
                previous: e.previous || '',
                dt,
            });
        }
        out.sort((a, b) => a.dt.to_unix() - b.dt.to_unix());
        return out;
    }

    fill() {
        this.list.removeAll();
        const now = GLib.DateTime.new_now_local();
        const day0 = GLib.DateTime.new_local(
            now.get_year(), now.get_month(), now.get_day_of_month(), 0, 0, 0);
        const start = day0.to_unix();
        let day = '';

        let n = 0;
        for (const e of this.events) {
            if (e.dt.to_unix() < start)
                continue;
            if ((RANK[e.impact] || 0) < this.minRank)
                continue;

            const key = e.dt.format('%Y-%m-%d');
            if (key !== day) {
                day = key;
                this.list.addMenuItem(new PopupMenu.PopupMenuItem(
                    e.dt.format('%a %b %e'), {reactive: false}));
            }

            let text = `${e.dt.format('%H:%M')} ${e.country} ${e.title}`;
            if (e.previous || e.forecast) {
                text += '  ';
                if (e.previous)
                    text += `P:${e.previous} `;
                if (e.forecast)
                    text += `F:${e.forecast}`;
            }
            const item = new PopupMenu.PopupMenuItem(text, {reactive: false});
            item.label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            if (e.impact === 'High')
                item.label.add_style_class_name('economic-calender-impact-high');
            else if (e.impact === 'Medium')
                item.label.add_style_class_name('economic-calender-impact-medium');
            this.list.addMenuItem(item);
            n++;
        }
        if (!n) {
            this.list.addMenuItem(new PopupMenu.PopupMenuItem(
                this.events.length ? 'nothing matches filter' : 'loading…',
                {reactive: false}));
        }
    }

    updateNext() {
        const now = GLib.DateTime.new_now_local().to_unix();
        let best = null;
        for (const e of this.events) {
            if (e.dt.to_unix() < now - 60)
                continue;
            if ((RANK[e.impact] || 0) < this.minRank)
                continue;
            best = e;
            break;
        }
        if (!best) {
            this.next.text = '';
            return;
        }
        const secs = best.dt.to_unix() - now;
        let rel;
        if (secs < 0)
            rel = 'now';
        else if (secs < 3600)
            rel = `${Math.floor(secs / 60)}m`;
        else if (secs < 86400)
            rel = `${Math.floor(secs / 3600)}h`;
        else
            rel = `${Math.floor(secs / 86400)}d`;
        this.next.text = `${rel} ${best.title.slice(0, 24)}`;
    }

    async download(force) {
        if (this.busy || !this.session)
            return;
        const now = Date.now();
        if (!force && this.events.length && now - this.lastOk < 30 * 60 * 1000)
            return;
        if (!force && now - this.lastNet < 5 * 60 * 1000) {
            if (!this.events.length)
                await this.loadCache();
            return;
        }

        this.busy = true;
        if (this.cancel)
            this.cancel.cancel();
        this.cancel = new Gio.Cancellable();
        this.footer.label.text = '…';

        try {
            const msg = Soup.Message.new('GET', URL);
            msg.request_headers.append('Accept', 'application/json');
            const bytes = await this.session.send_and_read_async(
                msg, GLib.PRIORITY_DEFAULT, this.cancel);
            if (!this.session)
                return;
            if (msg.status_code === 429)
                throw new Error('rate limited');
            if (msg.status_code !== 200)
                throw new Error(`HTTP ${msg.status_code}`);
            const body = new TextDecoder().decode(bytes.get_data());
            if (body[0] === '<')
                throw new Error('html response');
            const data = JSON.parse(body);
            if (!Array.isArray(data) || !data.length)
                throw new Error('empty');
            await this.saveCache(data);
            this.events = this.normalize(data);
            this.lastOk = Date.now();
            this.lastNet = this.lastOk;
            this.fill();
            this.updateNext();
            this.footer.label.text =
                GLib.DateTime.new_now_local().format('%H:%M:%S');
        } catch (e) {
            if (e instanceof GLib.Error &&
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) {
                this.busy = false;
                return;
            }
            this.lastNet = Date.now();
            logError(e);
            if (await this.loadCache())
                this.footer.label.text = 'offline cache';
            else
                this.footer.label.text = String(e.message || e).slice(0, 40);
        }
        this.busy = false;
    }
});

export default class extends Extension {
    enable() {
        this._btn = new CalButton();
        Main.panel.addToStatusArea(this.uuid, this._btn, 0, 'center');
    }

    disable() {
        this._btn.destroy();
        this._btn = null;
    }
}
