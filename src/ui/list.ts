import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import type {History, Item} from '../core/history.ts';
import type {Actions, View} from './popup.ts';
import {DIM, isLink, Row} from './row.ts';
import {Toast} from './toast.ts';

// GNOME lays out every child of a scroll view, so only this many rows exist until you scroll further.
const PAGE = 50;

/** The history as a list of tiles, with an item menu and an undo toast. */
export class ListView implements View {
    readonly actor: St.Widget;
    private readonly _history: History;
    private readonly _settings: Gio.Settings;
    private readonly _actions: Actions;
    private readonly _close: () => void;
    // The popup's root: there the popup tells a menu's grab from another one, and the card would lay
    // menus out like any other child.
    private readonly _layer: St.Widget;
    private readonly _menus: PopupMenu.PopupMenuManager;
    private readonly _scroll: St.ScrollView;
    private readonly _list: St.BoxLayout;
    private readonly _empty: St.BoxLayout;
    private readonly _emptyIcon: St.Icon;
    private readonly _emptyLabel: St.Label;
    private readonly _turnOff: St.Button;
    private readonly _toast: Toast;
    private readonly _rows = new Map<string, Row>();
    private _menu: PopupMenu.PopupMenu | null = null;
    private _query = '';
    private _items: Item[] = [];
    private _more = false;
    private _limit = PAGE;
    private _selected = 0;
    private _selectedRow: Row | null = null;

    constructor(history: History, settings: Gio.Settings, actions: Actions, layer: St.Widget, close: () => void) {
        this._history = history;
        this._settings = settings;
        this._actions = actions;
        this._layer = layer;
        this._close = close;

        this._list = new St.BoxLayout({style_class: 'pastepop-list', orientation: Clutter.Orientation.VERTICAL});
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
            y_expand: true,
            child: this._list,
        });
        this._scroll.vadjustment.connect('notify::value', adjustment => {
            if (this._more && adjustment.value + 2 * adjustment.page_size >= adjustment.upper) {
                this._limit += PAGE;
                this.sync();
            }
        });

        this._emptyIcon = new St.Icon({opacity: DIM, x_align: Clutter.ActorAlign.CENTER});
        this._emptyLabel = new St.Label({opacity: DIM, x_align: Clutter.ActorAlign.CENTER});
        this._turnOff = new St.Button({style_class: 'button', label: _('Turn off'), x_align: Clutter.ActorAlign.CENTER});
        this._turnOff.connect('clicked', () => settings.set_boolean('private-mode', false));
        this._empty = new St.BoxLayout({
            style_class: 'pastepop-empty',
            orientation: Clutter.Orientation.VERTICAL,
        });
        this._empty.add_child(this._emptyIcon);
        this._empty.add_child(this._emptyLabel);
        this._empty.add_child(this._turnOff);

        this._toast = new Toast(history);
        this._menus = new PopupMenu.PopupMenuManager(layer);

        this.actor = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this.actor.add_child(this._scroll);
        this.actor.add_child(this._empty);
        this.actor.add_child(this._toast.actor);
    }

    filter(query: string): void {
        this._query = query;
        this._limit = PAGE;
        this._selected = 0;
        this._scroll.vadjustment.value = 0;
        this.sync();
    }

    /** Brings the rows in line with the history, reusing the ones that still match. */
    sync(): void {
        const matches = this._history.search(this._query);
        this._items = matches.slice(0, this._limit);
        this._more = matches.length > this._items.length;

        const keep = new Set(this._items.map(i => i.hash));
        for (const [hash, row] of this._rows) {
            if (keep.has(hash))
                continue;
            if (row === this._selectedRow)
                this._selectedRow = null;
            // Its menu would otherwise stay up, pointing at nothing.
            if (this._menu?.sourceActor === row.more)
                this._menu.close();
            row.actor.destroy();
            this._rows.delete(hash);
        }
        this._items.forEach((item, index) => {
            let row = this._rows.get(item.hash);
            if (!row) {
                row = this._createRow(item);
                this._rows.set(item.hash, row);
                this._list.insert_child_at_index(row.actor, index);
            } else {
                row.update(item, this._query);
                if (this._list.get_child_at_index(index) !== row.actor)
                    this._list.set_child_at_index(row.actor, index);
            }
        });

        const empty = this._items.length === 0;
        const searching = this._query.trim() !== '';
        const privateMode = !searching && this._settings.get_boolean('private-mode');
        this._scroll.visible = !empty;
        this._empty.visible = empty;
        this._emptyIcon.icon_name = searching ? 'edit-find-symbolic'
            : privateMode ? 'view-conceal-symbolic' : 'edit-paste-symbolic';
        this._emptyLabel.text = searching ? _('No matches')
            : privateMode ? _('Private mode is on') : _('Nothing copied yet');
        this._turnOff.visible = privateMode;
        this._select(this._selected);
    }

    key(keyval: number, state: Clutter.ModifierType): boolean {
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (state & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const item = this._items.at(this._selected);

        if (keyval === Clutter.KEY_Up || keyval === Clutter.KEY_Down)
            this._select(this._selected + (keyval === Clutter.KEY_Up ? -1 : 1));
        else if ((keyval === Clutter.KEY_Page_Up || keyval === Clutter.KEY_Page_Down) && item)
            this._select(this._pageFrom(keyval === Clutter.KEY_Page_Up ? -1 : 1));
        else if (keyval === Clutter.KEY_Home)
            this._select(0);
        else if (keyval === Clutter.KEY_End)
            this._selectLast();
        else if (keyval === Clutter.KEY_Return && item)
            this._actions.activate(item, ctrl ? 'copy' : shift ? 'plain' : 'paste');
        else if (keyval === Clutter.KEY_Delete && item)
            this._delete(item);
        else if (ctrl && keyval === Clutter.KEY_p && item)
            this._history.togglePin(item);
        else if (ctrl && keyval === Clutter.KEY_z)
            this._toast.undo();
        else if (ctrl && keyval >= Clutter.KEY_1 && keyval <= Clutter.KEY_9 && this._items[keyval - Clutter.KEY_1])
            this._actions.activate(this._items[keyval - Clutter.KEY_1], 'paste');
        else if ((keyval === Clutter.KEY_Menu || shift && keyval === Clutter.KEY_F10) && this._selectedRow)
            this._openMenu(this._selectedRow);
        else
            return false;
        return true;
    }

    clear(): void {
        this._toast.show(this._history.clear());
    }

    /** Called as the popup closes: deletions become final. */
    close(): void {
        // Closed rather than destroyed: the menu item being clicked may be what closes the popup.
        this._menu?.close();
        this._toast.flush();
        // End and scrolling can build many rows, including image textures. Keep only the first page while hidden.
        this._limit = PAGE;
        if (this._rows.size > PAGE)
            this.filter(this._query);
    }

    destroy(): void {
        this._menu?.destroy();
        this._toast.destroy();
    }

    private _createRow(item: Item): Row {
        const row = new Row(item, hash => this._actions.blobFile(hash), this._query);
        row.actor.connect('clicked', (_actor, button) => {
            if (button === Clutter.BUTTON_SECONDARY)
                this._openMenu(row);
            else
                this._actions.activate(row.item, 'paste');
        });
        row.pin.connect('clicked', () => this._history.togglePin(row.item));
        row.more.connect('clicked', () => this._openMenu(row));
        return row;
    }

    private _delete(item: Item): void {
        this._history.remove(item);
        this._toast.show([item]);
    }

    /** Scrolls only when the selection moves, so loading more rows doesn't pull the view back. */
    private _select(index: number): void {
        this._selected = Math.max(0, Math.min(index, this._items.length - 1));
        const item = this._items.at(this._selected);
        const row = item ? this._rows.get(item.hash) ?? null : null;
        if (row === this._selectedRow)
            return;
        this._selectedRow?.setSelected(false);
        this._selectedRow = row;
        if (!row)
            return;
        row.setSelected(true);
        ensureActorVisibleInScrollView(this._scroll, row.actor);
    }

    private _selectLast(): void {
        this._limit = Infinity;
        this.sync();
        this._select(this._items.length - 1);
    }

    /** The last row that starts within a page of the selected one. */
    private _pageFrom(direction: number): number {
        const rows = this._list.get_children();
        const target = rows[this._selected].y + direction * this._scroll.vadjustment.page_size;
        let index = this._selected;
        while (rows[index + direction] && direction * (rows[index + direction].y - target) <= 0)
            index += direction;
        return index;
    }

    /** The menu takes its own grab inside the popup's. It lives until the next one opens. */
    private _openMenu(row: Row): void {
        this._menu?.destroy();
        this._select(this._items.indexOf(row.item));
        const {item} = row;
        const menu = new PopupMenu.PopupMenu(row.more, 0.5, St.Side.TOP);
        const add = (label: string, accel: string, action: () => void) => {
            const entry = new PopupMenu.PopupMenuItem(label);
            entry.add_child(new St.Label({
                style_class: 'pastepop-accel',
                text: accel,
                opacity: DIM,
                x_expand: true,
                x_align: Clutter.ActorAlign.END,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            entry.connect('activate', action);
            menu.addMenuItem(entry);
        };
        add(_('Paste'), _('Enter'), () => this._actions.activate(item, 'paste'));
        if (item.kind !== 'image')
            add(_('Paste as plain text'), _('Shift+Enter'), () => this._actions.activate(item, 'plain'));
        add(_('Copy only'), _('Ctrl+Enter'), () => this._actions.activate(item, 'copy'));
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        add(item.pinned ? _('Unpin') : _('Pin'), _('Ctrl+P'), () => this._history.togglePin(item));
        if (isLink(item)) {
            menu.addAction(_('Open link'), () => {
                this._close();
                Gio.AppInfo.launch_default_for_uri(item.text.trim(), global.create_app_launch_context(0, -1));
            });
        }
        add(_('Delete'), _('Del'), () => this._delete(item));

        this._layer.add_child(menu.actor);
        this._menus.addMenu(menu);
        this._menu = menu;
        menu.open();
    }
}
