import type Gio from 'gi://Gio';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {History, maxAge, type Item} from './core/history.ts';
import {Clipboard} from './shell/clipboard.ts';
import {Caret, pasteTarget} from './shell/focus.ts';
import {Monitor} from './shell/monitor.ts';
import {Shortcut} from './shell/shortcut.ts';
import {Storage, logError} from './shell/storage.ts';
import {Popup} from './ui/popup.ts';

/** Everything that lives between enable() and disable(). */
class Session {
    private readonly _extension: PastePop;
    private readonly _settings: Gio.Settings;
    private readonly _history: History;
    private readonly _storage: Storage;
    private readonly _clipboard = new Clipboard();
    private readonly _caret = new Caret();
    private readonly _monitor: Monitor;
    private readonly _shortcut: Shortcut;
    private readonly _changedIds: number[];
    private _popup: Popup | null = null;
    private _source: MessageTray.Source | null = null;
    private _target: {terminal: boolean} | null = null;

    constructor(extension: PastePop, settings: Gio.Settings) {
        this._extension = extension;
        this._settings = settings;
        this._history = new History(settings.get_int('history-size'), maxAge(settings.get_string('keep-unpinned')),
            () => this._changed(), hash => this._storage.deleteBlob(hash));
        this._storage = new Storage(() => this._history.items);
        this._monitor = new Monitor(settings, source => this._clipboard.isOwn(source),
            (item, data) => this._copied(item, data));
        this._shortcut = new Shortcut(settings, () => this._toggle());
        this._changedIds = [
            settings.connect('changed::history-size',
                () => this._history.setLimit(settings.get_int('history-size'))),
            settings.connect('changed::keep-unpinned',
                () => this._history.setMaxAge(maxAge(settings.get_string('keep-unpinned')))),
        ];

        this._storage.load(settings.get_string('keep-unpinned') === 'restart')
            .then(items => {
                this._history.load(items);
                return this._storage.deleteOrphans(hash => this._history.needsBlob(hash));
            })
            .catch(logError('loading history'));

        if (settings.get_strv('pastepop-shortcut').length === 0 && !settings.get_boolean('onboarded'))
            this._onboard();
    }

    destroy(): void {
        this._changedIds.forEach(id => this._settings.disconnect(id));
        this._source?.destroy(MessageTray.NotificationDestroyedReason.SOURCE_CLOSED);
        this._popup?.destroy();
        this._shortcut.destroy();
        this._monitor.destroy();
        this._caret.destroy();
        this._clipboard.destroy();
        this._storage.destroy();
    }

    private _onboard(): void {
        const source = new MessageTray.Source({title: 'PastePop', iconName: 'edit-paste-symbolic'});
        source.connectObject('destroy', () => {
            this._source = null;
        }, this);
        Main.messageTray.add(source);

        const notification = new MessageTray.Notification({
            source,
            title: _('PastePop is ready'),
            body: _('Pick a shortcut to open it. Super+V works like on Windows.'),
        });
        notification.addAction(_('Use Super+V'), () => this._settings.set_strv('pastepop-shortcut', ['<Super>v']));
        notification.addAction(_('Choose…'), () => this._extension.openPreferences());
        source.addNotification(notification);
        this._source = source;
        this._settings.set_boolean('onboarded', true);
    }

    private _copied(item: Item, data: Uint8Array): void {
        if (item.blob && !this._history.needsBlob(item.hash))
            this._storage.writeBlob(item.hash, data);
        this._history.add(item);
    }

    private _changed(): void {
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
        this._history.prune();
        this._popup ??= new Popup(this._history, this._settings, this._extension.dir, {
            activate: (item, how) => this._activate(item, how),
            insert: text => this._insert(text),
            openPrefs: () => {
                this._popup?.close();
                this._extension.openPreferences();
            },
            blobFile: hash => this._storage.blobFile(hash),
        });
        this._popup.open(this._caret.rect);
    }

    /** Pastes into the window the popup opened over, unless asked to copy or pasting is off. */
    private _activate(item: Item, how: 'paste' | 'plain' | 'copy'): void {
        const target = how !== 'copy' && this._settings.get_boolean('paste-on-select') ? this._target : null;
        this._popup?.close();
        this._clipboard.set(item, how === 'plain', this._storage)
            .then(() => {
                if (target)
                    this._clipboard.paste(target.terminal);
            })
            .catch(logError('pasting'));
    }

    private _insert(text: string): void {
        const target = this._settings.get_boolean('paste-on-select') ? this._target : null;
        this._popup?.close();
        if (target)
            this._clipboard.insert(text, target.terminal);
        else
            this._clipboard.setText(text);
    }
}

export default class PastePop extends Extension {
    private _settings: Gio.Settings | null = null;
    private _session: Session | null = null;

    enable(): void {
        this._settings = this.getSettings();
        this._session = new Session(this, this._settings);
    }

    disable(): void {
        this._session?.destroy();
        this._session = null;
        this._settings = null;
    }
}
