import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {gettext as _, ngettext} from 'resource:///org/gnome/shell/extensions/extension.js';

import type {History, Item} from '../core/history.ts';

const TIMEOUT_S = 5;

/** "3 deleted · Undo". Deleted items can be restored until it goes, then they are purged. */
export class Toast {
    readonly actor: St.BoxLayout;
    private readonly _history: History;
    private readonly _label: St.Label;
    private _items: Item[] = [];
    private _timeoutId = 0;

    constructor(history: History) {
        this._history = history;
        this._label = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const undo = new St.Button({style_class: 'button', label: _('Undo')});
        undo.connect('clicked', () => this.undo());

        this.actor = new St.BoxLayout({
            style_class: 'osd-window pastepop-toast',
            x_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            y_align: Clutter.ActorAlign.END,
            reactive: true,
            track_hover: true,
            visible: false,
        });
        this.actor.add_child(this._label);
        this.actor.add_child(undo);
        this.actor.connect('notify::hover', () => this._schedule());
    }

    /** Repeats add up to one toast. */
    show(items: Item[]): void {
        this._items.push(...items);
        const n = this._items.length;
        this._label.text = n === 1 ? _('Deleted') : ngettext('%d deleted', '%d deleted', n).format(n);
        this.actor.show();
        this._schedule();
    }

    undo(): void {
        if (this._items.length > 0)
            this._history.restore(this._items);
        this._hide();
    }

    flush(): void {
        this._history.purge(this._items);
        this._hide();
    }

    destroy(): void {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
    }

    /** Counts down while the pointer is away from the toast. */
    private _schedule(): void {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = 0;
        if (this._items.length === 0 || this.actor.hover)
            return;
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, TIMEOUT_S, () => {
            this._timeoutId = 0;
            this.flush();
            return GLib.SOURCE_REMOVE;
        });
    }

    private _hide(): void {
        this._items = [];
        this._schedule();
        this.actor.hide();
    }
}
