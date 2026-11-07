import Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {fileNames, preview, type History, type Item} from '../core/history.ts';

const THUMBNAIL_WIDTH = 260;
const THUMBNAIL_HEIGHT = 96;

function previewLabel(text: string): St.Label {
    const label = new St.Label({text: preview(text), x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    // preview() already shortened the text. Ellipsizing as well would let a scrolled list squeeze
    // the label to one line, since that becomes its minimum height.
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    return label;
}

function content(item: Item, blobFile: (hash: string) => Gio.File): Clutter.Actor {
    switch (item.kind) {
    case 'text':
        return previewLabel(item.text);
    case 'image': {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const thumbnail = St.TextureCache.get_default().load_file_async(blobFile(item.hash),
            -1, THUMBNAIL_HEIGHT, scale, global.stage.get_resource_scale());
        thumbnail.content_gravity = Clutter.ContentGravity.RESIZE_ASPECT;
        // The image is fitted into a fixed box: the layout doesn't follow its size once it has loaded,
        // and a very wide image mustn't widen the tile.
        return new St.Bin({
            child: thumbnail,
            style: `width: ${THUMBNAIL_WIDTH}px; height: ${THUMBNAIL_HEIGHT}px;`,
            x_expand: true,
        });
    }
    case 'files': {
        const box = new St.BoxLayout({style_class: 'ctrlv-files', x_expand: true});
        box.add_child(new St.Icon({icon_name: 'text-x-generic-symbolic', y_align: Clutter.ActorAlign.START}));
        box.add_child(previewLabel(fileNames(item.text).join('\n')));
        return box;
    }
    }
}

/** A tile: click pastes; pin and delete show on hover and selection, and the pin stays while pinned. */
export class Row {
    readonly actor: St.Button;
    private _item: Item;
    private readonly _pin: St.Button;
    private readonly _remove: St.Button;

    constructor(item: Item, history: History, activate: (item: Item) => void, blobFile: (hash: string) => Gio.File) {
        this._item = item;
        this._pin = new St.Button({style_class: 'icon-button ctrlv-action', icon_name: 'view-pin-symbolic'});
        this._pin.connect('clicked', () => history.togglePin(this._item));
        this._remove = new St.Button({style_class: 'icon-button ctrlv-action', icon_name: 'user-trash-symbolic'});
        this._remove.connect('clicked', () => history.remove(this._item));

        const buttons = new St.BoxLayout({style_class: 'ctrlv-actions', y_align: Clutter.ActorAlign.CENTER});
        buttons.add_child(this._pin);
        buttons.add_child(this._remove);

        const box = new St.BoxLayout({x_expand: true});
        box.add_child(content(item, blobFile));
        box.add_child(buttons);

        this.actor = new St.Button({style_class: 'button ctrlv-item', child: box, x_expand: true});
        this.actor.connect('clicked', () => activate(this._item));
        this.actor.connect('notify::hover', () => this._sync());
        this._sync();
    }

    update(item: Item): void {
        this._item = item;
        this._sync();
    }

    setSelected(selected: boolean): void {
        if (selected)
            this.actor.add_style_pseudo_class('selected');
        else
            this.actor.remove_style_pseudo_class('selected');
        this._sync();
    }

    private _sync(): void {
        // Opacity rather than visibility, so the text doesn't reflow on hover.
        const active = this.actor.hover || this.actor.has_style_pseudo_class('selected');
        this._pin.checked = this._item.pinned;
        this._pin.opacity = active || this._item.pinned ? 255 : 0;
        this._remove.opacity = active ? 255 : 0;
    }
}
