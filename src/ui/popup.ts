import Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {History, Item} from '../core/history.ts';
import {focusWindow, type Rect} from '../shell/focus.ts';
import {ListView} from './list.ts';
import {SymbolsView} from './symbols.ts';

const GAP = 4;
const MARGIN = 12;
const FADE_TIME_MS = 100;
// One keyval per key for the views.
const ALIASES = new Map([[Clutter.KEY_KP_Enter, Clutter.KEY_Return], [Clutter.KEY_ISO_Enter, Clutter.KEY_Return],
    [Clutter.KEY_KP_Delete, Clutter.KEY_Delete]]);
// Keys that act on the list or grid even while the search field has focus; Ctrl combos go there too.
const VIEW_KEYS = [Clutter.KEY_Up, Clutter.KEY_Down, Clutter.KEY_Page_Up, Clutter.KEY_Page_Down,
    Clutter.KEY_Return, Clutter.KEY_Menu, Clutter.KEY_F10];
const EDIT_KEYS = [Clutter.KEY_a, Clutter.KEY_c, Clutter.KEY_v, Clutter.KEY_x,
    Clutter.KEY_Left, Clutter.KEY_Right, Clutter.KEY_BackSpace, Clutter.KEY_Delete];
const COMMAND_MASK = Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
    Clutter.ModifierType.SUPER_MASK | Clutter.ModifierType.MOD4_MASK;

export interface Actions {
    activate(item: Item, how: 'paste' | 'plain' | 'copy'): void;
    insert(text: string): void;
    openPrefs(): void;
    blobFile(hash: string): Gio.File;
}

/** A tab's content: the clipboard list or a symbol grid. */
export interface View {
    readonly actor: St.Widget;
    filter(query: string): void;
    /** Returns true if the view handled the key (arrows, Enter, PgUp/PgDn, Home/End…). */
    key(keyval: number, state: Clutter.ModifierType): boolean;
    destroy(): void;
}

export type SymbolTab = 'emoji' | 'symbols' | 'kaomoji';
type Tab = 'clipboard' | SymbolTab;

export class Popup {
    private readonly _history: History;
    private readonly _settings: Gio.Settings;
    private readonly _dir: Gio.File;
    private readonly _actions: Actions;
    // Holds the card and its menus, and takes the grab.
    private readonly _root: St.Widget;
    private readonly _card: St.BoxLayout;
    private readonly _tabBar: St.BoxLayout;
    private readonly _tabs: {tab: Tab; button: St.Button}[];
    private readonly _title: St.Label;
    private readonly _searchButton: St.Button;
    private readonly _privateButton: St.Button;
    private readonly _clearButton: St.Button;
    private readonly _entry: St.Entry;
    private readonly _stack: St.Widget;
    private readonly _list: ListView;
    private readonly _symbols = new Map<SymbolTab, View>();
    private readonly _privateId: number;
    private _tab: Tab = 'clipboard';
    private _grab: Clutter.Grab | null = null;
    private _area = new Mtk.Rectangle();
    // Set when the card opened above the caret, so it grows upwards and stays next to it.
    private _bottom: number | null = null;

    constructor(history: History, settings: Gio.Settings, dir: Gio.File, actions: Actions) {
        this._history = history;
        this._settings = settings;
        this._dir = dir;
        this._actions = actions;

        const iconButton = (icon: string, name: string, clicked: () => void) => {
            const button = new St.Button({style_class: 'icon-button flat', icon_name: icon, accessible_name: name});
            button.connect('clicked', clicked);
            return button;
        };

        this._tabBar = new St.BoxLayout({style_class: 'pastepop-tabs', x_expand: true});
        this._tabs = ([
            ['clipboard', {icon_name: 'edit-paste-symbolic'}, _('Clipboard')],
            ['emoji', {icon_name: 'face-smile-symbolic'}, _('Emoji')],
            ['symbols', {icon_name: 'emoji-symbols-symbolic'}, _('Symbols')],
            ['kaomoji', {label: ';-)'}, _('Kaomoji')],
        ] as const).map(([tab, face, name]) => {
            const button = new St.Button({style_class: 'icon-button flat', accessible_name: name, ...face});
            button.connect('clicked', () => this._show(tab));
            this._tabBar.add_child(button);
            return {tab, button};
        });
        this._title = new St.Label({
            style_class: 'pastepop-title',
            text: _('Clipboard'),
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._searchButton = iconButton('edit-find-symbolic', _('Search'), () => this._setSearch(!this._entry.visible));
        this._privateButton = iconButton('view-conceal-symbolic', _('Private mode'),
            () => settings.set_boolean('private-mode', !settings.get_boolean('private-mode')));
        this._clearButton = iconButton('user-trash-symbolic', _('Clear all'), () => this._list.clear());
        const prefs = iconButton('emblem-system-symbolic', _('Settings'), () => actions.openPrefs());
        for (const button of [this._searchButton, this._privateButton])
            button.add_style_class_name('pastepop-toggle');

        const header = new St.BoxLayout({style_class: 'pastepop-header', reactive: true});
        for (const child of [this._tabBar, this._title, this._searchButton, this._privateButton, this._clearButton, prefs])
            header.add_child(child);

        // A drag needs some travel first, so clicks on the header's buttons still work.
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

        this._entry = new St.Entry({
            style_class: 'pastepop-search',
            hint_text: _('Search'),
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic'}),
            secondary_icon: new St.Icon({icon_name: 'edit-clear-symbolic'}),
            x_expand: true,
            visible: false,
        });
        this._entry.connect('secondary-icon-clicked', () => this._setSearch(false));
        this._entry.clutter_text.connect('text-changed', () => this._view(this._tab).filter(this._entry.text));

        this._root = new St.Widget({reactive: true, visible: false});
        this._list = new ListView(history, settings, actions, this._root, () => this.close());
        this._stack = new St.Widget({layout_manager: new Clutter.BinLayout(), y_expand: true});
        this._stack.add_child(this._list.actor);

        this._card = new St.BoxLayout({
            style_class: 'popup-menu-content pastepop-popup',
            orientation: Clutter.Orientation.VERTICAL,
            reactive: true,
        });
        this._card.add_child(header);
        this._card.add_child(this._entry);
        this._card.add_child(this._stack);
        this._root.add_child(this._card);

        const keys = new Clutter.KeyController();
        keys.connect('key-press', () => this._onKeyPress(keys));
        this._root.add_action_full('pastepop-keys', Clutter.EventPhase.CAPTURE, keys);

        // Under the grab, presses anywhere on screen reach the root; the same pattern as PopupMenuManager.
        const outside = new Clutter.ClickGesture({recognize_on_press: true});
        outside.connect('may-recognize', () => {
            const target = global.stage.get_event_actor(outside.get_point_event(0));
            return !target || !this._card.contains(target);
        });
        outside.connect('recognize', () => this.close());
        this._root.add_action_full('pastepop-outside', Clutter.EventPhase.CAPTURE, outside);

        this._card.connect('notify::height', () => {
            this._moveTo(this._card.x, this._bottom === null ? this._card.y : this._bottom - this._card.height);
        });
        this._privateId = settings.connect('changed::private-mode', () => this._syncPrivate());
        this._syncPrivate();
        Main.layoutManager.uiGroup.add_child(this._root);
    }

    get isOpen(): boolean {
        return this._grab !== null;
    }

    open(caret: Rect | null): void {
        const symbols = this._settings.get_boolean('show-symbols');
        this._tabBar.visible = symbols;
        this._title.visible = !symbols;
        this._show('clipboard');
        this.sync();
        this._root.show();
        this._place(caret);

        // @girs declares an untyped overload first.
        const grab = Main.pushModal(this._root, {actionMode: Shell.ActionMode.POPUP}) as Clutter.Grab;
        grab.connect('notify::revoked', () => {
            // The item menu grabs on top of this one. Any other grab took the keyboard away, so close
            // rather than linger without input. This also fires when an older grab (e.g. the closing
            // overview) is released.
            const top = global.stage.get_grab_actor();
            if (grab.revoked && !(top && this._root.contains(top)))
                this.close();
        });
        this._grab = grab;

        this._card.opacity = 0;
        this._card.ease({opacity: 255, duration: FADE_TIME_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    close(): void {
        const grab = this._grab;
        if (!grab)
            return;
        this._grab = null;
        this._list.close();
        Main.popModal(grab);
        this._card.remove_all_transitions();
        this._root.hide();
        this._card.style = null;
        this._setSearch(false);
    }

    sync(): void {
        this._list.sync();
        this._clearButton.reactive = this._history.items.some(i => !i.pinned);
    }

    destroy(): void {
        this.close();
        this._settings.disconnect(this._privateId);
        this._list.destroy();
        for (const view of this._symbols.values())
            view.destroy();
        this._root.destroy();
    }

    /** Symbol tabs are built the first time they are shown. */
    private _view(tab: Tab): View {
        if (tab === 'clipboard')
            return this._list;
        let view = this._symbols.get(tab);
        if (!view) {
            view = new SymbolsView(tab, this._dir, this._settings, text => this._actions.insert(text));
            this._symbols.set(tab, view);
            this._stack.add_child(view.actor);
        }
        return view;
    }

    private _show(tab: Tab): void {
        const view = this._view(tab);
        if (this.isOpen)
            this._holdHeight(this._card.height);
        this._tab = tab;
        for (const child of this._stack.get_children())
            child.visible = child === view.actor;
        for (const {tab: name, button} of this._tabs)
            button.checked = name === tab;
        this._clearButton.visible = tab === 'clipboard';
        view.filter(this._entry.text);
    }

    private _setSearch(visible: boolean): void {
        this._searchButton.checked = visible;
        if (visible) {
            this._entry.show();
            this._entry.grab_key_focus();
            return;
        }
        // Only from the field: on close, the focus belongs to the app or to whatever grabbed it.
        if (this._entry.clutter_text.has_key_focus())
            this._root.grab_key_focus();
        this._entry.hide();
        this._entry.text = '';
    }

    private _syncPrivate(): void {
        const on = this._settings.get_boolean('private-mode');
        this._privateButton.checked = on;
        this._privateButton.icon_name = on ? 'view-conceal-symbolic' : 'view-reveal-symbolic';
        if (this.isOpen)
            this._list.sync();
    }

    private _onKeyPress(keys: Clutter.KeyController): boolean {
        const [, keysym, keycode] = keys.get_key();
        const [, pressed, latched, locked] = keys.get_state();
        const state = pressed | latched | locked;
        const ctrl = (state & Clutter.ModifierType.CONTROL_MASK) !== 0;
        const searching = this._entry.visible;
        // The digit row by position, as some layouts (AZERTY) need Shift for digits. Keycodes are evdev + 8.
        const digit = keycode - 9;
        const [lower] = Clutter.keyval_convert_case(keysym);
        const keyval = ctrl && digit >= 1 && digit <= 9 ? Clutter.KEY_0 + digit : ALIASES.get(lower) ?? lower;

        if (keyval === Clutter.KEY_Escape) {
            if (searching)
                this._setSearch(false);
            else
                this.close();
            return Clutter.EVENT_STOP;
        }
        // With Shift, Tab arrives as ISO_Left_Tab.
        if (ctrl && (keyval === Clutter.KEY_Tab || keyval === Clutter.KEY_ISO_Left_Tab)) {
            const tabs = this._tabBar.visible ? this._tabs : this._tabs.slice(0, 1);
            const index = tabs.findIndex(t => t.tab === this._tab) + (keyval === Clutter.KEY_Tab ? 1 : -1);
            this._show(tabs[(index + tabs.length) % tabs.length].tab);
            return Clutter.EVENT_STOP;
        }
        if (ctrl && keyval === Clutter.KEY_f) {
            this._setSearch(true);
            return Clutter.EVENT_STOP;
        }

        const editing = searching && (ctrl ? EDIT_KEYS.includes(keyval) : !VIEW_KEYS.includes(keyval));
        if (!editing && this._view(this._tab).key(keyval, state))
            return Clutter.EVENT_STOP;

        const char = String.fromCodePoint(Clutter.keysym_to_unicode(keysym));
        if (!searching && (state & COMMAND_MASK) === 0 && GLib.unichar_isgraph(char)) {
            this._setSearch(true);
            this._entry.text = char;
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /**
     * Below and right of the caret or pointer, as `open-at` says, flipped when there's no room and clamped
     * to the work area. Without a caret, keyboard users leave the pointer anywhere, so it only counts when
     * it's over the focused window. Otherwise, or for `center`, the popup is centred on that window's monitor.
     */
    private _place(caret: Rect | null): void {
        const [, , width, height] = this._card.get_preferred_size();
        const [px, py] = global.get_pointer();
        const pointer = {x: px, y: py, width: 0, height: 0};
        const window = focusWindow();
        const openAt = this._settings.get_string('open-at');
        let anchor: Rect | null = null;
        if (openAt === 'pointer')
            anchor = pointer;
        else if (openAt === 'caret')
            anchor = caret ?? (window && !window.get_frame_rect().contains_point(px, py) ? null : pointer);
        const monitor = anchor
            ? global.display.get_monitor_index_for_rect(new Mtk.Rectangle({x: anchor.x, y: anchor.y, width: 1, height: 1}))
            : window?.get_monitor() ?? global.display.get_current_monitor();
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor);

        let x, y;
        this._bottom = null;
        if (!anchor) {
            x = area.x + (area.width - width) / 2;
            y = area.y + (area.height - height) / 2;
        } else {
            x = anchor.x + width > area.x + area.width - MARGIN ? anchor.x + anchor.width - width : anchor.x;
            if (anchor.y + anchor.height + GAP + height > area.y + area.height - MARGIN)
                this._bottom = anchor.y - GAP;
            y = this._bottom === null ? anchor.y + anchor.height + GAP : this._bottom - height;
        }
        this._area = area;
        this._holdHeight(height);
        this._moveTo(x, y);
    }

    /**
     * The card may grow, as items arrive or another tab needs room, but doesn't shrink while open, so it
     * stays put next to the caret. CSS rather than min_height, which wouldn't raise the natural height.
     */
    private _holdHeight(height: number): void {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const content = this._card.get_theme_node().adjust_for_height(height);
        this._card.style = `min-height: ${content / scale}px;`;
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
