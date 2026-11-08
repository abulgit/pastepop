# PastePop

Clipboard history for GNOME, like Windows' Win+V.

![PastePop opening at the text cursor](.github/demo.gif)

Press your shortcut and a popup opens at the text cursor. Pick an item and it is
pasted into the app you were using.

## Features

- Text, images and files, kept across restarts
- Search, pins, and undo for deletes
- Paste as plain text, or copy without pasting
- Emoji, symbols and kaomoji
- Private mode and excluded apps; copies from password managers are skipped
- No dependencies, no network access

## Install

Requires GNOME 50 or 51. Turn off other clipboard managers first.

Download `pastepop@abulgit.shell-extension.zip` from
[Releases](https://github.com/abulgit/pastepop/releases), then run:

```sh
gnome-extensions install pastepop@abulgit.shell-extension.zip
```

Log out and back in, then run `gnome-extensions enable pastepop@abulgit`.
A notification offers Super+V as the shortcut. While it is set, GNOME's
notification list opens with Super+M.

## Keys

| Key | Action |
|---|---|
| Enter | Paste |
| Shift+Enter | Paste as plain text |
| Ctrl+1 to Ctrl+9 | Paste one of the first nine items |
| Ctrl+P | Pin or unpin |
| Delete | Delete (Ctrl+Z to undo) |
| Type, or Ctrl+F | Search |
| Ctrl+Tab | Next tab |

## Privacy

History is stored only on your computer, in `~/.local/share/pastepop`.

## Development

```sh
npm ci
npm run build   # compile to dist/
npm test
npm run pack    # build the zip
```

To report a bug, include the output of
`journalctl -b -o cat /usr/bin/gnome-shell | grep -i pastepop`.

## License

[GPL-2.0-or-later](LICENSE)
