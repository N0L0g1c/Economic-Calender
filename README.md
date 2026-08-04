# Economic Calender

GNOME Shell extension: top-panel **economic calendar** for upcoming macro events (FOMC, CPI, NFP, GDP, and more).

## Features

- Panel badge shows time until the next matching event
- Menu groups events by day with country, impact, forecast & previous
- Filter cycles: **High only** → **Medium & high** → **All**
- Auto-refresh every 15 minutes (plus on menu open)
- Data from the public Forex Factory week feed (`nfs.faireconomy.media`)

## Install

```bash
mkdir -p ~/.local/share/gnome-shell/extensions
cp -a economic-calender ~/.local/share/gnome-shell/extensions/
gnome-extensions enable economic-calender
```

Log out/in on Wayland (or restart GNOME Shell) so the extension is discovered.

## Requirements

- GNOME Shell 45–50
- Network access for the calendar feed

## Notes

- Default filter is **high impact only** (click **Filter** in the menu to change).
- Source feed rate-limits aggressive refresh; 15 minutes is intentional.
