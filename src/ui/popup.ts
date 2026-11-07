import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {History, Item} from '../core/history.ts';
import {focusWindow, type Rect} from '../shell/focus.ts';
import {Row} from './row.ts';

// GNOME lays out every child of a scroll view, so only this many rows exist until you scroll further.
const PAGE = 50;
const GAP = 4;
const MARGIN = 12;
const FADE_TIME = 100;

export class Popup {
    private readonly _history: History;
    private readonly _activate: (item: Item, plain: boolean) => void;
    private readonly _blobFile: (hash: string) => Gio.File;
    private readonly _card: St.BoxLayout;
    private readonly _entry: St.Entry;
    private readonly _scroll: St.ScrollView;
    private readonly _list: St.BoxLayout;
    private readonly _empty: St.BoxLayout;
    private readonly _emptyLabel: St.Label;
    private readonly _rows = new Map<string, Row>();
    private _items: Item[] = [];
    private _more = false;
    private _limit = PAGE;
    private _selected = 0;
    private _selectedRow: Row | null = null;
    private _grab: Clutter.Grab | null = null;
    private _area = new Mtk.Rectangle();
    // Set when the card opened above the caret, so it grows upwards and stays next to it.
    private _bottom: number | null = null;

    constructor(history: History, settings: Gio.Settings, activate: (item: Item, plain: boolean) => void,
        blobFile: (hash: string) => Gio.File) {
        this._history = history;
        this._activate = activate;
        this._blobFile = blobFile;

        this._entry = new St.Entry({
            style_class: 'ctrlv-search',
            hint_text: 'Search',
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic'}),
            x_expand: true,
        });
        this._entry.clutter_text.connect('text-changed', () => this._reset());

        const privateMode = new St.Button({toggle_mode: true, accessible_name: 'Private mode'});
        const syncPrivateMode = () => {
            privateMode.style_class = privateMode.checked ? 'icon-button default' : 'icon-button flat';
            privateMode.icon_name = privateMode.checked ? 'view-conceal-symbolic' : 'view-reveal-symbolic';
        };
        privateMode.connect('notify::checked', syncPrivateMode);
        settings.bind('private-mode', privateMode, 'checked', Gio.SettingsBindFlags.DEFAULT);
        syncPrivateMode();

        const clear = new St.Button({style_class: 'button flat', label: 'Clear all'});
        clear.connect('clicked', () => history.clear());

        const header = new St.BoxLayout({style_class: 'ctrlv-header', reactive: true});
        header.add_child(new St.Label({
            style_class: 'ctrlv-title',
            text: 'Clipboard',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        header.add_child(privateMode);
        header.add_child(clear);

        // The header moves the popup. A drag needs some travel first, so clicks on its buttons still work.
        const drag = new Clutter.PanGesture();
        let dragOffset = {x: 0, y: 0};
        drag.connect('recognize', () => {
            const begin = drag.get_begin_centroid_abs();
            dragOffset = {x: this._card.x - begin.x, y: this._card.y - begin.y};
        });
        drag.connect('pan-update', () => {
            const {x, y} = drag.get_centroid_abs();
            this._area = Main.layoutManager.getWorkAreaForMonitor(global.display.get_current_monitor());
            this._bottom = null;
            this._moveTo(x + dragOffset.x, y + dragOffset.y);
        });
        header.add_action(drag);

        this._list = new St.BoxLayout({style_class: 'ctrlv-list', orientation: Clutter.Orientation.VERTICAL});
        this._scroll = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            y_expand: true,
            child: this._list,
        });
        this._scroll.vadjustment.connect('notify::value', adjustment => {
            if (this._more && adjustment.value + 2 * adjustment.page_size >= adjustment.upper) {
                this._limit += PAGE;
                this.sync();
            }
        });

        this._emptyLabel = new St.Label();
        this._empty = new St.BoxLayout({
            style_class: 'ctrlv-empty',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            opacity: 160,
        });
        this._empty.add_child(new St.Icon({icon_name: 'edit-paste-symbolic', x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(this._emptyLabel);

        this._card = new St.BoxLayout({
            style_class: 'popup-menu-content ctrlv-popup',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
            visible: false,
        });
        this._card.add_child(header);
        this._card.add_child(this._entry);
        this._card.add_child(this._scroll);
        this._card.add_child(this._empty);

        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => this._onKeyPress(keys));
        this._card.add_action_full('ctrlv-keys', Clutter.EventPhase.CAPTURE, keys);

        // Under the grab, presses anywhere on screen reach the card; the same pattern as PopupMenuManager.
        const outside = new Clutter.ClickGesture({recognize_on_press: true});
        outside.connect('may-recognize', () => {
            const target = global.stage.get_event_actor(outside.get_point_event(0));
            return !target || !this._card.contains(target);
        });
        outside.connect('recognize', () => this.close());
        this._card.add_action_full('ctrlv-outside', Clutter.EventPhase.CAPTURE, outside);

        this._card.connect('notify::height', () => {
            this._moveTo(this._card.x, this._bottom === null ? this._card.y : this._bottom - this._card.height);
        });
        Main.layoutManager.uiGroup.add_child(this._card);
    }

    get isOpen(): boolean {
        return this._grab !== null;
    }

    open(caret: Rect | null): void {
        this._entry.text = '';
        this._reset();
        this._card.show();
        this._place(caret);

        // @girs declares an untyped overload first.
        const grab = Main.pushModal(this._card, {actionMode: Shell.ActionMode.POPUP}) as Clutter.Grab;
        // Another grab took over the keyboard; close rather than linger without input.
        // The signal also fires when an older grab (e.g. the closing overview) is released.
        grab.connect('notify::revoked', () => {
            if (grab.revoked)
                this.close();
        });
        this._grab = grab;
        this._entry.grab_key_focus();

        this._card.opacity = 0;
        this._card.ease({opacity: 255, duration: FADE_TIME, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    close(): void {
        const grab = this._grab;
        if (!grab)
            return;
        this._grab = null;
        Main.popModal(grab);
        this._card.remove_all_transitions();
        this._card.hide();
        this._card.min_height_set = false;
    }

    /** Brings the rows in line with the history, reusing the ones that still match. */
    sync(): void {
        const matches = this._history.search(this._entry.text);
        this._items = matches.slice(0, this._limit);
        this._more = matches.length > this._items.length;

        const keep = new Set(this._items.map(i => i.hash));
        for (const [hash, row] of this._rows) {
            if (keep.has(hash))
                continue;
            if (row === this._selectedRow)
                this._selectedRow = null;
            row.actor.destroy();
            this._rows.delete(hash);
        }
        this._items.forEach((item, index) => {
            let row = this._rows.get(item.hash);
            if (!row) {
                row = new Row(item, this._history, i => this._activate(i, false), this._blobFile);
                this._rows.set(item.hash, row);
                this._list.insert_child_at_index(row.actor, index);
            } else {
                row.update(item);
                if (this._list.get_child_at_index(index) !== row.actor)
                    this._list.set_child_at_index(row.actor, index);
            }
        });

        const empty = this._items.length === 0;
        this._scroll.visible = !empty;
        this._empty.visible = empty;
        this._emptyLabel.text = this._entry.text ? 'No matches' : 'Nothing copied yet';
        this._select(this._selected);
    }

    destroy(): void {
        this.close();
        this._card.destroy();
    }

    private _reset(): void {
        this._limit = PAGE;
        this._selected = 0;
        this._scroll.vadjustment.value = 0;
        this.sync();
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

    private _onKeyPress(keys: Clutter.KeyController): boolean {
        const [, keysym, keycode] = keys.get_key();
        const [, pressed, latched, locked] = keys.get_state();
        const mods = pressed | latched | locked;
        const ctrl = (mods & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const shift = (mods & Clutter.ModifierType.SHIFT_MASK) !== 0;
        const selected = this._items.at(this._selected);
        // The digit row by position, as some layouts (AZERTY) need Shift for digits. Keycodes are evdev + 8.
        const digit = keycode - 9;

        if (keysym === Clutter.KEY_Escape)
            this.close();
        else if (keysym === Clutter.KEY_Up)
            this._select(this._selected - 1);
        else if (keysym === Clutter.KEY_Down)
            this._select(this._selected + 1);
        else if ([Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_ISO_Enter].includes(keysym) && selected)
            this._activate(selected, shift);
        else if (keysym === Clutter.KEY_Delete && selected && !this._entry.text)
            this._history.remove(selected);
        else if (ctrl && (keysym === Clutter.KEY_p || keysym === Clutter.KEY_P) && selected)
            this._history.togglePin(selected);
        else if (ctrl && digit >= 1 && digit <= 9 && this._items[digit - 1])
            this._activate(this._items[digit - 1], false);
        else
            return Clutter.EVENT_PROPAGATE;
        return Clutter.EVENT_STOP;
    }

    /**
     * Below and right of the caret or pointer, flipped when there's no room, clamped to the work area.
     * Keyboard users leave the pointer anywhere, so it only counts when it's over the focused window;
     * otherwise the popup is centred on that window's monitor. While open, the card may grow as items
     * arrive but doesn't shrink as you search, so it stays put next to the caret.
     */
    private _place(caret: Rect | null): void {
        const [, , width, height] = this._card.get_preferred_size();
        const [px, py] = global.get_pointer();
        const window = focusWindow();
        const centre = !caret && window !== null && !window.get_frame_rect().contains_point(px, py);
        const anchor = caret ?? {x: px, y: py, width: 0, height: 0};
        const monitor = centre
            ? window.get_monitor()
            : global.display.get_monitor_index_for_rect(new Mtk.Rectangle({x: anchor.x, y: anchor.y, width: 1, height: 1}));
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);

        let x, y;
        this._bottom = null;
        if (centre) {
            x = area.x + (area.width - width) / 2;
            y = area.y + (area.height - height) / 2;
        } else {
            x = anchor.x + width > area.x + area.width - MARGIN ? anchor.x + anchor.width - width : anchor.x;
            if (anchor.y + anchor.height + GAP + height > area.y + area.height - MARGIN)
                this._bottom = anchor.y - GAP;
            y = this._bottom === null ? anchor.y + anchor.height + GAP : this._bottom - height;
        }
        this._area = area;
        this._card.min_height = height;
        this._moveTo(x, y);
    }

    /** Clamped to the work area of the monitor the card was placed or dragged on. */
    private _moveTo(x: number, y: number): void {
        const area = this._area;
        const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
        this._card.set_position(
            Math.round(clamp(x, area.x + MARGIN, area.x + area.width - MARGIN - this._card.width)),
            Math.round(clamp(y, area.y + MARGIN, area.y + area.height - MARGIN - this._card.height)));
    }
}
