# ASUS Kiosk Config

These files live on the ASUS display machine (`tod@192.168.1.19`) and control what Chromium shows in kiosk mode.

## Files

**`kiosk.desktop`** — `~/.config/autostart/kiosk.desktop`  
XFCE/GNOME autostart entry. Launches Chromium on login. The `Exec` line's URL is rewritten by the dashboard-manager Display switcher when you change what's on screen.

**`kiosk.service`** — `~/.config/systemd/user/kiosk.service`  
systemd user service used by the dashboard-manager to kill and relaunch Chromium when switching displays. The dashboard-manager calls `systemctl --user restart kiosk.service` over SSH after updating the URL in this file.

## How the Display Switcher Works

1. Admin panel (`http://192.168.1.3:3000/admin`) → Display section → click a project button
2. dashboard-manager POSTs to `/api/display/switch`
3. Server starts the project backend if not running, then SSH to the ASUS:
   - `sed` rewrites the URL in both files
   - `systemctl --user daemon-reload && systemctl --user restart kiosk.service`
4. Chromium relaunches pointing at the new URL

## Rebuilding the ASUS Kiosk

If the ASUS is wiped/rebuilt:

```bash
# From Lenovo
scp asus-config/kiosk.desktop tod@192.168.1.19:~/.config/autostart/
scp asus-config/kiosk.service tod@192.168.1.19:~/.config/systemd/user/
ssh tod@192.168.1.19 "export XDG_RUNTIME_DIR=/run/user/\$(id -u); systemctl --user daemon-reload && systemctl --user enable kiosk.service"
```

Set up passwordless SSH from Lenovo first: `ssh-copy-id tod@192.168.1.19`
