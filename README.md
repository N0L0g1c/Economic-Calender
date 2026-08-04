# Economic Calender

GNOME Shell extension: top-panel **economic calendar** for upcoming macro events (FOMC, CPI, NFP, GDP, and more).

## Features

- Panel badge shows time until the next matching event
- Menu groups events by day with country, impact, forecast & previous
- Filter cycles: **High only** → **Medium & high** → **All**
- Auto-refresh every 30 minutes (plus when stale data needs updating)
- Disk cache under `~/.cache/economic-calender/`
- Data from a public Forex Factory week feed (`nfs.faireconomy.media`)

## Install

```bash
UUID=economic-calender@n0l0g1c.github.io
mkdir -p ~/.local/share/gnome-shell/extensions
cp -a "$UUID" ~/.local/share/gnome-shell/extensions/
gnome-extensions enable "$UUID"
```

Log out/in on Wayland (or restart GNOME Shell) so the extension is discovered.

## Requirements

- GNOME Shell 45–50
- Network access for the calendar feed

## Notes

- Default filter is **high impact only** (click **Filter** in the menu to change).
- Source feed rate-limits aggressive refresh; caching is intentional.

## License

[GPL-2.0-or-later](LICENSE) — GNU General Public License v2.0 or later.

This matches typical GNOME Shell extension licensing (extensions load into the GPL-licensed shell).

## Author

[N0L0g1c](https://github.com/N0L0g1c)
