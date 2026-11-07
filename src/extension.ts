import type Gio from 'gi://Gio';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {History, type Item} from './core/history.ts';
import {Clipboard} from './shell/clipboard.ts';
import {Caret, pasteTarget} from './shell/focus.ts';
import {Monitor} from './shell/monitor.ts';
import {Shortcut} from './shell/shortcut.ts';
import {Storage, logError} from './shell/storage.ts';
import {Popup} from './ui/popup.ts';

/** Everything that lives between enable() and disable(). */
class Session {
    private readonly _settings: Gio.Settings;
    private readonly _history: History;
    private readonly _storage: Storage;
    private readonly _clipboard = new Clipboard();
    private readonly _caret = new Caret();
    private readonly _monitor: Monitor;
    private readonly _shortcut: Shortcut;
    private readonly _sizeChangedId: number;
    private _popup: Popup | null = null;
    private _target: {terminal: boolean} | null = null;

    constructor(settings: Gio.Settings) {
        this._settings = settings;
        this._history = new History(settings.get_int('history-size'), removed => this._changed(removed));
        this._storage = new Storage(() => this._history.items);
        this._monitor = new Monitor(settings, source => this._clipboard.isOwn(source),
            (item, data) => this._copied(item, data));
        this._shortcut = new Shortcut(settings, () => this._toggle());
        this._sizeChangedId = settings.connect('changed::history-size',
            () => this._history.setLimit(settings.get_int('history-size')));

        this._storage.load(settings.get_boolean('persist-history'))
            .then(items => {
                this._history.restore(items);
                return this._storage.deleteOrphans(hash => this._history.has(hash));
            })
            .catch(logError('loading history'));
    }

    destroy(): void {
        this._settings.disconnect(this._sizeChangedId);
        this._popup?.destroy();
        this._shortcut.destroy();
        this._monitor.destroy();
        this._caret.destroy();
        this._clipboard.destroy();
        this._storage.destroy();
    }

    private _copied(item: Item, data: Uint8Array): void {
        if (item.blob && !this._history.has(item.hash))
            this._storage.writeBlob(item.hash, data);
        this._history.add(item);
    }

    private _changed(removed: Item[]): void {
        for (const item of removed.filter(i => i.blob))
            this._storage.deleteBlob(item.hash);
        this._storage.save();
        if (this._popup?.isOpen)
            this._popup.sync();
    }

    private _toggle(): void {
        if (this._popup?.isOpen) {
            this._popup.close();
            return;
        }
        this._target = pasteTarget(this._settings.get_strv('terminal-apps'));
        this._popup ??= new Popup(this._history, this._settings, (item, plain) => this._activate(item, plain),
            hash => this._storage.blobFile(hash));
        this._popup.open(this._caret.rect);
    }

    private _activate(item: Item, plain: boolean): void {
        const target = this._target;
        this._popup?.close();
        this._clipboard.set(item, plain, this._storage)
            .then(() => {
                if (target)
                    this._clipboard.paste(target.terminal);
            })
            .catch(logError('pasting'));
    }
}

export default class CtrlV extends Extension {
    private _session: Session | null = null;

    enable(): void {
        this._session = new Session(this.getSettings());
    }

    disable(): void {
        this._session?.destroy();
        this._session = null;
    }
}
