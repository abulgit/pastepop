import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import St from 'gi://St';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {fileNames, preview, type Item} from '../core/history.ts';

/** The opacity of libadwaita's dim labels. */
export const DIM = 140;

// Narrow enough to leave room for the size beside it.
const THUMBNAIL_WIDTH = 144;
const THUMBNAIL_HEIGHT = 96;
// Tiny or very thin images still get a box worth seeing, with the picture centred in it.
const THUMBNAIL_MIN = 24;
const PREVIEW_LINES = 3;
const FILE_NAMES = 3;
Gio._promisify(Gio.File.prototype, 'query_info_async');
Gio._promisify(GdkPixbuf.Pixbuf, 'get_file_info_async');

const COLOR = /^(#[\da-f]{3}|#[\da-f]{6}|(rgb|hsl)a?\([^()]*\))$/i;
const LINK = /^https?:\/\/\S+$/i;

export function isLink(item: Item): boolean {
    return item.kind === 'text' && !item.blob && LINK.test(item.text.trim());
}

/** Escaped Pango markup with every case-insensitive match of `query` in bold, and no hyphens added at breaks. */
function highlight(text: string, query: string): string {
    const needle = query.trim();
    const parts = needle ? text.split(new RegExp(`(${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'iu')) : [text];
    const markup = parts.map((part, i) => {
        const escaped = GLib.markup_escape_text(part, -1);
        return i % 2 ? `<b>${escaped}</b>` : escaped;
    }).join('');
    return `<span insert_hyphens="false">${markup}</span>`;
}

function textLabel(): St.Label {
    const label = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    // preview() already shortened the text. Ellipsizing as well would let a scrolled list squeeze
    // the label to one line, since that becomes its minimum height.
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    return label;
}

function swatch(text: string): St.Widget | null {
    if (!COLOR.test(text))
        return null;
    const [valid, {red, green, blue, alpha}] = Cogl.Color.from_string(text);
    if (!valid)
        return null;
    const color = `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
    return new St.Widget({
        style_class: 'pastepop-swatch',
        style: `background-color: ${color}; border-color: st-darken(${color}, 15%);`,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

/** Scaled down to fit the tile, and given a fixed size: the layout doesn't follow the texture once it loads. */
function thumbnail(size: [number, number] | undefined, file: Gio.File): St.Bin {
    const [width, height] = size ?? [THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT];
    const scale = Math.min(1, THUMBNAIL_WIDTH / width, THUMBNAIL_HEIGHT / height);
    const [w, h] = [width, height].map(n => Math.max(1, Math.round(n * scale)));
    const texture = St.TextureCache.get_default().load_file_async(file, w, h,
        St.ThemeContext.get_for_stage(global.stage).scale_factor, global.stage.get_resource_scale());
    // Filling the box scales a tiny image up to it, keeping its proportions.
    texture.set({x_expand: true, y_expand: true, content_gravity: Clutter.ContentGravity.RESIZE_ASPECT});
    return new St.Bin({
        child: texture,
        style: `width: ${Math.max(w, THUMBNAIL_MIN)}px; height: ${Math.max(h, THUMBNAIL_MIN)}px;`,
    });
}

function sizeLabel([width, height]: [number, number]): St.Label {
    return new St.Label({text: `${width} × ${height}`, opacity: DIM, y_align: Clutter.ActorAlign.CENTER});
}

/** The size of a local image file, read from its header, or null for any other file. */
async function imageSize(file: Gio.File, cancellable: Gio.Cancellable): Promise<[number, number] | null> {
    const path = file.get_path();
    if (!path)
        return null;
    const info = await file.query_info_async('standard::content-type', Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_DEFAULT, cancellable);
    if (!info.get_content_type()?.startsWith('image/'))
        return null;
    // @girs only declares the callback form.
    const [format, width, height] = await (GdkPixbuf.Pixbuf.get_file_info_async as unknown as
        (path: string, cancellable: Gio.Cancellable) => Promise<[GdkPixbuf.PixbufFormat | null, number, number]>)(path, cancellable);
    return format ? [width, height] : null;
}

/** A tile: click pastes, right-click opens the menu; pin and ⋮ show on hover and selection, the pin also while pinned. */
export class Row {
    readonly actor: St.Button;
    readonly pin: St.Button;
    readonly more: St.Button;
    item: Item;
    private readonly _label: St.Label | null = null;
    private _text = '';
    private _query: string | null = null;
    private _fitId = 0;
    private readonly _cancellable = new Gio.Cancellable();

    constructor(item: Item, blobFile: (hash: string) => Gio.File, query: string) {
        this.item = item;
        const content = new St.BoxLayout({style_class: 'pastepop-content', x_expand: true});
        if (item.kind === 'image') {
            content.add_child(thumbnail(item.size, blobFile(item.hash)));
            if (item.size)
                content.add_child(sizeLabel(item.size));
        } else if (item.kind === 'files') {
            const names = fileNames(item.text);
            const [type] = Gio.content_type_guess(names[0], null);
            const icon = new St.Icon({
                style_class: 'pastepop-file-icon',
                gicon: Gio.content_type_get_symbolic_icon(type),
                y_align: Clutter.ActorAlign.CENTER,
            });
            const rest = names.length - FILE_NAMES;
            this._text = preview(names.slice(0, FILE_NAMES).join(', ') + (rest > 0 ? ` +${rest}` : ''));
            const label = this._label = textLabel();
            const text = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            text.add_child(label);
            content.add_child(icon);
            content.add_child(text);

            // A first file that is a local image shows like a copied image, with its name.
            const file = Gio.File.new_for_uri(item.text.split('\n')[0]);
            imageSize(file, this._cancellable).then(size => {
                if (!size || this._cancellable.is_cancelled())
                    return;
                content.replace_child(icon, thumbnail(size, file));
                text.add_child(sizeLabel(size));
                this._text = preview(names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0]);
                label.clutter_text.set_markup(highlight(this._text, this._query ?? ''));
            }).catch((e: unknown) => {
                // A file that has gone or can't be read keeps the plain tile.
                if (!(e instanceof GLib.Error))
                    console.error('PastePop: previewing a file failed', e);
            });
        } else {
            const color = swatch(item.text.trim());
            if (color)
                content.add_child(color);
            this._text = preview(item.text);
            this._label = textLabel();
            if (isLink(item))
                this._label.add_style_class_name('shell-link');
            content.add_child(this._label);
        }

        this.pin = new St.Button({style_class: 'icon-button pastepop-action', icon_name: 'view-pin-symbolic'});
        this.more = new St.Button({
            style_class: 'icon-button pastepop-action',
            icon_name: 'view-more-symbolic',
            accessible_name: _('More options'),
        });
        const buttons = new St.BoxLayout({style_class: 'pastepop-actions', y_align: Clutter.ActorAlign.CENTER});
        buttons.add_child(this.pin);
        buttons.add_child(this.more);

        const box = new St.BoxLayout({x_expand: true});
        box.add_child(content);
        box.add_child(buttons);

        this.actor = new St.Button({
            style_class: 'button pastepop-item',
            child: box,
            x_expand: true,
            button_mask: St.ButtonMask.PRIMARY | St.ButtonMask.SECONDARY,
        });
        const laters = global.compositor.get_laters();
        if (this._label) {
            const label = this._label;
            this.actor.label_actor = label;
            // Once laid out, but not during the layout, which changing the text would upset.
            label.clutter_text.connect('notify::allocation', () => {
                this._fitId ||= laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
                    this._fitId = 0;
                    this._fit(label);
                    return GLib.SOURCE_REMOVE;
                });
            });
        }
        this.actor.connect('destroy', () => {
            this._cancellable.cancel();
            if (this._fitId)
                laters.remove(this._fitId);
        });
        this.actor.connect('notify::hover', () => this._sync());
        this.update(item, query);
    }

    update(item: Item, query: string): void {
        this.item = item;
        if (this._label && query !== this._query)
            this._label.clutter_text.set_markup(highlight(this._text, query));
        this._query = query;
        this._sync();
    }

    setSelected(selected: boolean): void {
        if (selected)
            this.actor.add_style_pseudo_class('selected');
        else
            this.actor.remove_style_pseudo_class('selected');
        this._sync();
    }

    /** preview() guesses where three lines end; the layout knows, so the text is cut back to it. */
    private _fit(label: St.Label): void {
        // A copy, as the label's own layout follows its preferred width until it is allocated again.
        const layout = label.clutter_text.get_layout().copy();
        const lines = layout.get_lines_readonly();
        if (lines.length <= PREVIEW_LINES)
            return;
        // Line indices are byte offsets into the text on show, which is _text.
        const end = lines[PREVIEW_LINES].start_index;
        let head = Array.from(new TextDecoder().decode(new TextEncoder().encode(this._text).subarray(0, end)));
        let markup;
        do {
            this._text = `${head.join('').trimEnd()}…`;
            markup = highlight(this._text, this._query ?? '');
            layout.set_markup(markup, -1);
            head = head.slice(0, -1);
        } while (layout.get_line_count() > PREVIEW_LINES);
        label.clutter_text.set_markup(markup);
    }

    private _sync(): void {
        // Opacity rather than visibility, so the text doesn't reflow on hover.
        const active = this.actor.hover || this.actor.has_style_pseudo_class('selected');
        this.pin.checked = this.item.pinned;
        this.pin.accessible_name = this.item.pinned ? _('Unpin') : _('Pin');
        this.pin.opacity = active || this.item.pinned ? 255 : 0;
        this.more.opacity = active ? 255 : 0;
    }
}
