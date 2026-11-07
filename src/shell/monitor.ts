import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import {createItem, type Item} from '../core/history.ts';
import {PASSWORD_HINT, pickFormat} from '../core/mime.ts';
import {focusedAppId} from './focus.ts';
import {logError} from './storage.ts';

const TEXT_LIMIT = 4 * 1024 * 1024;
const IMAGE_LIMIT = 20 * 1024 * 1024;

function sha256(data: Uint8Array): string {
    // Only null for an unknown checksum type.
    return GLib.compute_checksum_for_data(GLib.ChecksumType.SHA256, data)!;
}

/** Reads each new CLIPBOARD owner (never PRIMARY) unless it's ours, a password, private or from an excluded app. */
export class Monitor {
    private readonly _selection = global.display.get_selection();
    private readonly _ownerChangedId: number;
    private _cancellable: Gio.Cancellable | null = null;
    private _rejected = false;
    private _ownerLost = false;

    constructor(settings: Gio.Settings, isOwn: (source: Meta.SelectionSource) => boolean,
        onCopy: (item: Item, data: Uint8Array) => void) {
        Gio._promisify(Meta.Selection.prototype, 'transfer_async');
        this._ownerChangedId = this._selection.connect('owner-changed',
            (_selection, type: Meta.SelectionType, source: Meta.SelectionSource | null) => {
                if (type !== Meta.SelectionType.SELECTION_CLIPBOARD)
                    return;
                // A slow read of an earlier copy must not land after a newer one.
                this._cancellable?.cancel();
                this._cancellable = null;
                // When the owning app quits, mutter reports no owner and then keeps the clipboard as a
                // memory source, losing the password hint on the way; that copy keeps the earlier verdict.
                const inherited = this._ownerLost && this._rejected && source instanceof Meta.SelectionSourceMemory;
                this._ownerLost = !source;
                if (!source || isOwn(source))
                    return;

                const mimes = this._selection.get_mimetypes(Meta.SelectionType.SELECTION_CLIPBOARD);
                this._rejected = inherited || mimes.includes(PASSWORD_HINT) ||
                    settings.get_boolean('private-mode') ||
                    settings.get_strv('excluded-apps').includes(focusedAppId() ?? '');
                if (!this._rejected)
                    this._read(mimes, onCopy).catch(logError('reading the clipboard'));
            });
    }

    private async _read(mimes: string[], onCopy: (item: Item, data: Uint8Array) => void): Promise<void> {
        const format = pickFormat(mimes);
        if (!format)
            return;
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        const limit = format.kind === 'image' ? IMAGE_LIMIT : TEXT_LIMIT;
        const stream = Gio.MemoryOutputStream.new_resizable();
        // Mutter silently truncates at the requested size, so ask for one byte more to spot oversized data.
        await this._selection.transfer_async(Meta.SelectionType.SELECTION_CLIPBOARD, format.mime, limit + 1,
            stream, cancellable);
        stream.close(null);
        const data = stream.steal_as_bytes().toArray();
        if (cancellable.is_cancelled() || data.length > limit)
            return;

        const item = createItem(format.kind, data, sha256);
        if (item)
            onCopy(item, data);
    }

    destroy(): void {
        this._selection.disconnect(this._ownerChangedId);
        this._cancellable?.cancel();
    }
}
