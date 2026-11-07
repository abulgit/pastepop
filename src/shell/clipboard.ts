import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import type {Item} from '../core/history.ts';
import {TEXT_MIME} from '../core/mime.ts';
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

/** Owns the clipboard when CtrlV sets it, and types the paste shortcut through one virtual keyboard. */
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
        this._source = Meta.SelectionSourceMemory.new(mime, data);
        this._selection.set_owner(Meta.SelectionType.SELECTION_CLIPBOARD, this._source);
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
            if (mods & HELD_MODIFIERS)
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
        this._keyboard.run_dispose();
    }
}
