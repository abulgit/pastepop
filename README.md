# CtrlV

Clipboard history for GNOME Shell, modelled on Windows' Win+V. Press Super+V
and a small popup opens at the text cursor; pick an item and it is pasted into
the app you were using.

- Keeps text, images and copied files, and remembers them across restarts
- Search by typing, pin items, and delete them one by one or all at once
- Skips passwords marked by password managers, apps you exclude, and
  everything while private mode is on

## Requirements

- GNOME Shell 51 on Wayland
- Node.js 22.18 or newer and npm, to build

## Build and install

```sh
npm ci
npm run deploy
```

`deploy` builds, packs and installs the extension, then enables it. On Wayland
the shell only picks up a newly installed extension after you log out and back
in, so do that after the first install. If you use another clipboard manager,
such as Clipboard Indicator, turn it off first.

`npm run pack` only builds `ctrlv@abulgit.shell-extension.zip`.

## Use

| Key | Action |
|---|---|
| Super+V | Open or close the popup |
| Up, Down | Move the selection |
| Enter or click | Paste |
| Shift+Enter | Paste as plain text (file paths instead of files) |
| Ctrl+1 to Ctrl+9 | Paste the first nine items |
| Ctrl+P | Pin or unpin |
| Delete | Remove |
| Esc | Close |

Drag the popup by its header to move it; it opens at the cursor again next time.

GNOME also uses Super+V for the notification list. While CtrlV is on, the
notification list keeps Super+M only; nothing is written to GNOME's settings,
and turning CtrlV off gives Super+V back. This can be switched off in the
preferences.

Terminals get Ctrl+Shift+V instead of Shift+Insert. The list of terminal apps
is in the preferences.

History is stored in `~/.local/share/ctrlv/`.

## Development

```sh
npm run build   # compile to dist/
npm run lint
npm test        # unit tests for src/core
```

Logs:

```sh
journalctl -f -o cat /usr/bin/gnome-shell
```

To try a build without touching your session, run a nested shell with its own
data and settings. The devkit needs `sudo dnf install mutter-devkit`:

```sh
export XDG_DATA_HOME=$(mktemp -d) XDG_CONFIG_HOME=$(mktemp -d)
mkdir -p "$XDG_DATA_HOME/gnome-shell/extensions"
cp -r dist "$XDG_DATA_HOME/gnome-shell/extensions/ctrlv@abulgit"
dbus-run-session -- sh -c 'gnome-shell --devkit --wayland & sleep 5; gnome-extensions enable ctrlv@abulgit; wait'
```
