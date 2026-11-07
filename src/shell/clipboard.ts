import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {Item} from '../core/history.ts';
import {TEXT_MIME} from '../core/mime.ts';
import {inputMethod} from './focus.ts';
import type {Storage} from './storage.ts';

// evdev codes rather than keysyms, so pasting works with any keyboard layout.
const KEY_LEFTCTRL = 29;
const KEY_LEFTSHIFT = 42;
const KEY_V = 47;
const KEY_INSERT = 110;

const HELD_MODIFIERS = Clutter.ModifierType.SHIFT_MASK | Clutter.ModifierType.CONTROL_MASK |
    Clutter.ModifierType.MOD1_MASK | Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK;
const PASTE_DELAY = 80;
const PASTE_TRIES = 25;
// Apps with text input enable it again within a few frames of getting focus back.
const COMMIT_DELAY = 20;
const COMMIT_TRIES = 15;

/** Owns the clipboard when PastePop sets it, and types into apps through the input method or one virtual keyboard. */
export class Clipboard {
    private readonly _selection = global.display.get_selection();
    private readonly _keyboard = global.stage.context.get_backend().get_default_seat()
        .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);

    private _source: Meta.SelectionSource | null = null;
    private _pasteId = 0;

    isOwn(source: Meta.SelectionSource): boolean {
        return source === this._source;
    }

    /** Offers one format only: GJS can't implement the async vfuncs a multi-format source needs. */
    async set(item: Item, plain: boolean, storage: Storage): Promise<void> {
        const encode = (text: string) => new TextEncoder().encode(text);
        let mime = TEXT_MIME;
        let data;
        if (item.kind === 'image') {
            mime = 'image/png';
            data = await storage.readBlob(item.hash);
        } else if (item.kind === 'files' && !plain) {
            mime = 'text/uri-list';
            data = encode(item.text.split('\n').map(uri => `${uri}\r\n`).join(''));
        } else if (item.kind === 'files') {
            data = encode(item.text.split('\n').map(uri => Gio.File.new_for_uri(uri).get_path() ?? uri).join('\n'));
        } else {
            data = item.blob ? await storage.readBlob(item.hash) : encode(item.text);
        }
        this._own(mime, data);
    }

    setText(text: string): void {
        this._own(TEXT_MIME, new TextEncoder().encode(text));
    }

    /**
     * Commits text through the input method once the app has focus back, which leaves the clipboard alone.
     * Apps without text input, such as X11 ones, get it pasted instead.
     */
    insert(text: string, terminal: boolean): void {
        let tries = 0;

        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COMMIT_DELAY, () => {
            const im = inputMethod();
            if (!im.currentFocus && ++tries < COMMIT_TRIES)
                return GLib.SOURCE_CONTINUE;
            this._pasteId = 0;
            // The popup, or other shell UI, has the keyboard again.
            if (Main.modalCount > 0)
                return GLib.SOURCE_REMOVE;
            if (im.currentFocus) {
                im.commit(text);
            } else {
                this.setText(text);
                this.paste(terminal);
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    paste(terminal: boolean): void {
        const keys = terminal ? [KEY_LEFTCTRL, KEY_LEFTSHIFT, KEY_V] : [KEY_LEFTSHIFT, KEY_INSERT];
        let tries = 0;

        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        // Give focus time to return to the window, and wait until the user lets go of Ctrl or Shift
        // from Ctrl+1 or Shift+Enter, or the app would see a different shortcut. If they never do,
        // the item is still on the clipboard.
        this._pasteId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PASTE_DELAY, () => {
            const [, , mods] = global.get_pointer();
            if (mods & HELD_MODIFIERS && ++tries < PASTE_TRIES)
                return GLib.SOURCE_CONTINUE;
            this._pasteId = 0;
            if (mods & HELD_MODIFIERS || Main.modalCount > 0)
                return GLib.SOURCE_REMOVE;

            const time = GLib.get_monotonic_time();
            for (const key of keys)
                this._keyboard.notify_key(time, key, Clutter.KeyState.PRESSED);
            for (const key of keys.reverse())
                this._keyboard.notify_key(time, key, Clutter.KeyState.RELEASED);
            return GLib.SOURCE_REMOVE;
        });
    }

    destroy(): void {
        if (this._pasteId)
            GLib.source_remove(this._pasteId);
        // The seat keeps the device until it is disposed; there's no other way to remove it.
        this._keyboard.run_dispose();
    }

    private _own(mime: string, data: Uint8Array | GLib.Bytes): void {
        this._source = Meta.SelectionSourceMemory.new(mime, data);
        this._selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, this._source);
    }
}
