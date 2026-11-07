import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

import {logError} from '../shell/storage.ts';
import type {SymbolTab, View} from './popup.ts';
import {DIM} from './row.ts';

/** The files in data/ map each section id to a list of these. */
type Entry = [text: string, name: string, keywords?: string];
type Face = {icon_name: string} | {label: string};

interface Group {
    readonly grid: St.Widget;
    readonly layout: Clutter.GridLayout;
    entries: Entry[];
    /** Indexed like `entries`; only the rows near the view are built. */
    cells: (St.Button | undefined)[];
}

interface Section extends Group {
    readonly heading: St.Label;
    readonly button: St.Button;
}

const MAX_RECENT = 24;
const COLUMNS: Record<SymbolTab, number> = {emoji: 8, symbols: 8, kaomoji: 2};
// A colour emoji takes a couple of milliseconds to draw the first time, and its glyph then stays
// in cairo's cache (about 100 KB each), so only rows near the view are built, a chunk per frame.
const CHUNK_TIME_US = 5000;
const SEPARATORS = /[^\p{L}\p{N}]+/u;

const CELL_STYLE: Record<SymbolTab, string> = {
    emoji: 'button flat pastepop-emoji',
    symbols: 'button flat pastepop-glyph',
    kaomoji: 'button pastepop-kaomoji',
};

function sections(kind: SymbolTab): [id: string, title: string, face: Face][] {
    switch (kind) {
    case 'emoji':
        return [
            ['smileys', _('Smileys & Emotion'), {icon_name: 'emoji-people-symbolic'}],
            ['people', _('People & Body'), {icon_name: 'emoji-body-symbolic'}],
            ['nature', _('Animals & Nature'), {icon_name: 'emoji-nature-symbolic'}],
            ['food', _('Food & Drink'), {icon_name: 'emoji-food-symbolic'}],
            ['travel', _('Travel & Places'), {icon_name: 'emoji-travel-symbolic'}],
            ['activities', _('Activities'), {icon_name: 'emoji-activities-symbolic'}],
            ['objects', _('Objects'), {icon_name: 'emoji-objects-symbolic'}],
            ['symbols', _('Symbols'), {icon_name: 'emoji-symbols-symbolic'}],
            ['flags', _('Flags'), {icon_name: 'emoji-flags-symbolic'}],
        ];
    case 'symbols':
        return [
            ['arrows', _('Arrows'), {label: '→'}],
            ['math', _('Math'), {label: '±'}],
            ['currency', _('Currency'), {label: '€'}],
            ['punctuation', _('Punctuation'), {label: '“'}],
            ['greek', _('Greek'), {label: 'Ω'}],
            ['latin', _('Accented Letters'), {label: 'é'}],
            ['shapes', _('Shapes'), {label: '■'}],
        ];
    case 'kaomoji':
        return [
            ['happy', _('Happy'), {icon_name: 'face-smile-big-symbolic'}],
            ['sad', _('Sad'), {icon_name: 'face-sad-symbolic'}],
            ['love', _('Love'), {icon_name: 'emote-love-symbolic'}],
            ['angry', _('Angry'), {icon_name: 'face-angry-symbolic'}],
            ['surprised', _('Surprised'), {icon_name: 'face-surprise-symbolic'}],
            ['other', _('Other'), {icon_name: 'face-uncertain-symbolic'}],
        ];
    }
}

/** Lower-cased words, each after a space, so `includes(' ' + word)` matches word starts. */
function words(text: string): string {
    return ` ${text.toLowerCase().split(SEPARATORS).join(' ')}`;
}

/** An emoji, symbol or kaomoji picker: a category strip over sections, or a flat list of matches. */
export class SymbolsView implements View {
    readonly actor: St.BoxLayout;
    private readonly _kind: SymbolTab;
    private readonly _columns: number;
    private readonly _settings: Gio.Settings;
    private readonly _insert: (text: string) => void;
    private readonly _cancellable = new Gio.Cancellable();
    private readonly _strip = new St.BoxLayout({style_class: 'pastepop-picker-strip'});
    private readonly _browse = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
    private readonly _results: Group;
    private readonly _scroll: St.ScrollView;
    private readonly _empty: St.BoxLayout;
    private readonly _sections: Section[] = [];
    private readonly _entries = new Map<string, Entry>();
    private readonly _recentId: number;
    private _recent: Section | null = null;
    private _index: [entry: Entry, name: string, keywords: string][] | null = null;
    private _query = '';
    private _selected: St.Button | null = null;
    private _buildId = 0;

    constructor(kind: SymbolTab, dir: Gio.File, settings: Gio.Settings, insert: (text: string) => void) {
        this._kind = kind;
        this._columns = COLUMNS[kind];
        this._settings = settings;
        this._insert = insert;

        this._results = this._group();
        this._results.grid.hide();
        const content = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL});
        content.add_child(this._browse);
        content.add_child(this._results.grid);
        this._scroll = new St.ScrollView({hscrollbar_policy: St.PolicyType.NEVER, y_expand: true, child: content});
        this._scroll.vadjustment.connect('notify::value', () => this._build());
        this._scroll.vadjustment.connect('notify::page-size', () => this._build());

        this._empty = new St.BoxLayout({
            style_class: 'pastepop-empty',
            orientation: Clutter.Orientation.VERTICAL,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            y_expand: true,
            opacity: DIM,
            visible: false,
        });
        this._empty.add_child(new St.Icon({icon_name: 'edit-find-symbolic', x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(new St.Label({text: _('No matches'), x_align: Clutter.ActorAlign.CENTER}));

        this.actor = new St.BoxLayout({
            style_class: 'pastepop-picker',
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.actor.add_child(this._strip);
        this.actor.add_child(this._scroll);
        this.actor.add_child(this._empty);
        // Cells added while hidden would all be laid out and drawn in the first frame back.
        this.actor.connect('notify::mapped', () => this._build());

        this._recentId = settings.connect('changed::recent-symbols', () => this._showRecent());
        this._load(dir.get_child('data').get_child(`${kind}.json`)).catch(logError(`loading ${kind}`));
    }

    filter(query: string): void {
        if (query.trim() === this._query)
            return;
        this._query = query.trim();
        if (this._recent)
            this._apply();
    }

    key(keyval: number): boolean {
        let target: St.Button | undefined;
        switch (keyval) {
        case Clutter.KEY_Left:
            target = this._move(-1, 1);
            break;
        case Clutter.KEY_Right:
            target = this._move(1, 1);
            break;
        case Clutter.KEY_Up:
            target = this._move(-1, this._columns);
            break;
        case Clutter.KEY_Down:
            target = this._move(1, this._columns);
            break;
        case Clutter.KEY_Page_Up:
            target = this._move(-this._pageRows(), this._columns);
            break;
        case Clutter.KEY_Page_Down:
            target = this._move(this._pageRows(), this._columns);
            break;
        case Clutter.KEY_Home:
            target = this._end(false);
            break;
        case Clutter.KEY_End:
            target = this._end(true);
            break;
        case Clutter.KEY_Return:
            if (!this._selected)
                return false;
            this._pick(this._selected.label);
            return true;
        default:
            return false;
        }
        if (target) {
            this._select(target);
            ensureActorVisibleInScrollView(this._scroll, target);
        }
        return true;
    }

    destroy(): void {
        this._cancellable.cancel();
        if (this._buildId)
            global.compositor.get_laters().remove(this._buildId);
        this._settings.disconnect(this._recentId);
    }

    private async _load(file: Gio.File): Promise<void> {
        const [contents] = await file.load_contents_async(this._cancellable);
        const data = JSON.parse(new TextDecoder().decode(contents)) as Record<string, Entry[]>;
        this._recent = this._addSection(_('Recent'), {icon_name: 'emoji-recent-symbolic'}, []);
        for (const [id, title, face] of sections(this._kind)) {
            for (const entry of data[id])
                this._entries.set(entry[0], entry);
            this._addSection(title, face, data[id]);
        }
        this._showRecent();
        this._apply();
    }

    /** Shows the sections, or the matches for the query. */
    private _apply(): void {
        const searching = this._query !== '';
        this._fill(this._results, searching ? this._search(this._query) : []);
        this._results.grid.visible = searching;
        this._browse.visible = !searching;
        this._strip.visible = !searching;
        this._empty.visible = searching && this._results.entries.length === 0;
        this._scroll.visible = !this._empty.visible;
        this._scroll.vadjustment.value = 0;
        this._select(this._end(false) ?? null);
    }

    private _group(): Group {
        const layout = new Clutter.GridLayout({column_homogeneous: true, row_homogeneous: true});
        return {grid: new St.Widget({layout_manager: layout, x_expand: true}), layout, entries: [], cells: []};
    }

    private _addSection(title: string, face: Face, entries: Entry[]): Section {
        const section: Section = {
            ...this._group(),
            heading: new St.Label({style_class: 'pastepop-picker-heading', text: title}),
            button: new St.Button({style_class: 'button flat', accessible_name: title, x_expand: true, ...face}),
        };
        section.button.connect('clicked', () => this._jump(section));
        this._strip.add_child(section.button);
        this._browse.add_child(section.heading);
        this._browse.add_child(section.grid);
        this._sections.push(section);
        this._fill(section, entries);
        return section;
    }

    /** Starts the group over with these entries; the cells follow as they come into view. */
    private _fill(group: Group, entries: Entry[]): void {
        if (this._selected && group.grid.contains(this._selected))
            this._select(null);
        group.grid.destroy_all_children();
        group.cells = [];
        group.entries = entries;
        // GridLayout leaves out empty rows and columns, so two invisible cells size the grid before it
        // is built: one spans all of it, the other gives the rows and columns their size.
        if (entries.length) {
            const rows = Math.ceil(entries.length / this._columns);
            for (const [width, height] of [[this._columns, rows], [1, 1]]) {
                const spacer = new St.Label({style_class: CELL_STYLE[this._kind], text: ' ', opacity: 0});
                group.layout.attach(spacer, 0, 0, width, height);
            }
        }
        this._build();
    }

    private _showRecent(): void {
        const recent = this._recent;
        if (!recent)
            return;
        this._fill(recent, this._settings.get_strv('recent-symbols')
            .map(text => this._entries.get(text))
            .filter(entry => entry !== undefined));
        recent.heading.visible = recent.button.visible = recent.entries.length > 0;
        if (!this._selected)
            this._select(this._end(false) ?? null);
    }

    /** Adds the missing cells near the view while it is shown, a chunk before each frame. */
    private _build(): void {
        if (this._buildId || !this.actor.mapped)
            return;
        this._buildId = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            const end = GLib.get_monotonic_time() + CHUNK_TIME_US;
            for (let next = this._next(); next && this.actor.mapped; next = this._next()) {
                // Measuring lays the glyph out now, within the chunk, rather than in the next frame.
                this._addCell(...next).get_preferred_width(-1);
                if (GLib.get_monotonic_time() > end)
                    return GLib.SOURCE_CONTINUE;
            }
            this._buildId = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    /** A missing cell in the rows from half a page above the view to one and a half below it. */
    private _next(): [Group, number] | null {
        const {value, page_size: page} = this._scroll.vadjustment;
        for (const group of this._groups()) {
            const rows = Math.ceil(group.entries.length / this._columns);
            // The last allocation, as get_allocation_box() forces a relayout. Before the first one,
            // the rows are built from the top.
            const {y1, y2} = group.grid.allocation;
            const rowHeight = (y2 - y1) / rows;
            const first = rowHeight ? Math.max(0, Math.floor((value - page / 2 - y1) / rowHeight)) : 0;
            const last = rowHeight ? Math.min(rows, Math.ceil((value + page * 1.5 - y1) / rowHeight)) : rows;
            for (let i = first * this._columns; i < Math.min(last * this._columns, group.entries.length); i++) {
                if (!group.cells[i])
                    return [group, i];
            }
        }
        return null;
    }

    private _addCell(group: Group, index: number): St.Button {
        const [text, name] = group.entries[index];
        const cell = new St.Button({style_class: CELL_STYLE[this._kind], label: text, accessible_name: name});
        cell.connect('clicked', () => this._pick(text));
        group.layout.attach(cell, index % this._columns, Math.floor(index / this._columns), 1, 1);
        group.cells[index] = cell;
        return cell;
    }

    /** The groups on show that have entries. */
    private _groups(): Group[] {
        return (this._query ? [this._results] : this._sections).filter(g => g.entries.length);
    }

    /** The first or last cell, built if it isn't yet. */
    private _end(last: boolean): St.Button | undefined {
        const groups = this._groups();
        const group = last ? groups.at(-1) : groups[0];
        if (!group)
            return undefined;
        const index = last ? group.entries.length - 1 : 0;
        return group.cells[index] ?? this._addCell(group, index);
    }

    private _jump(section: Section): void {
        this._scroll.vadjustment.value = section.heading.allocation.y1;
        this._select(section.cells[0] ?? this._addCell(section, 0));
    }

    private _select(cell: St.Button | null): void {
        this._selected?.remove_style_pseudo_class('selected');
        this._selected = cell;
        cell?.add_style_pseudo_class('selected');
    }

    /**
     * The cell `count` steps of `unit` cells away (1 for the next cell, a row's worth for the next row),
     * carrying on into the neighbouring sections; built if it isn't yet.
     */
    private _move(count: number, unit: number): St.Button | undefined {
        const selected = this._selected;
        if (!selected)
            return this._end(false);
        const groups = this._groups();
        let g = groups.findIndex(group => group.cells.includes(selected));
        // Slots run on to the end of the last row, so a column is kept across a short row.
        const slots = (group: Group) => Math.ceil(group.entries.length / unit) * unit;
        let index = groups[g].cells.indexOf(selected);
        const step = Math.sign(count);
        for (let n = Math.abs(count); n > 0; n--) {
            const next = index + step * unit;
            if (next >= 0 && next < slots(groups[g])) {
                index = next;
                continue;
            }
            const neighbour = groups[g + step];
            if (!neighbour)
                break;
            index = (step > 0 ? 0 : slots(neighbour) - unit) + index % unit;
            g += step;
        }
        const group = groups[g];
        index = Math.min(index, group.entries.length - 1);
        return group.cells[index] ?? this._addCell(group, index);
    }

    /** Rows of cells in a page, leaving out the headings. */
    private _pageRows(): number {
        const rowHeight = this._selected?.height ?? 0;
        return rowHeight ? Math.max(1, Math.floor(this._scroll.vadjustment.page_size / rowHeight)) : 1;
    }

    private _search(query: string): Entry[] {
        const queryWords = query.toLowerCase().split(SEPARATORS).filter(w => w).map(w => ` ${w}`);
        if (!queryWords.length)
            return [];
        this._index ??= [...this._entries.values()].map(e => [e, words(`${e[0]} ${e[1]}`), words(e[2] ?? '')]);
        const named = [];
        const tagged = [];
        for (const [entry, name, keywords] of this._index) {
            if (queryWords.every(w => name.includes(w)))
                named.push(entry);
            else if (queryWords.every(w => name.includes(w) || keywords.includes(w)))
                tagged.push(entry);
        }
        return [...named, ...tagged];
    }

    private _pick(text: string): void {
        const recent = this._settings.get_strv('recent-symbols').filter(t => t !== text);
        this._settings.set_strv('recent-symbols', [text, ...recent].slice(0, MAX_RECENT));
        this._insert(text);
    }
}
