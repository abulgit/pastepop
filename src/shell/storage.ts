import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {parseIndex, type Item} from '../core/history.ts';

const SAVE_DELAY = 1000;

Gio._promisify(Gio.File.prototype, 'load_contents_async');
Gio._promisify(Gio.File.prototype, 'load_bytes_async');
Gio._promisify(Gio.File.prototype, 'replace_contents_async');
Gio._promisify(Gio.File.prototype, 'delete_async');
Gio._promisify(Gio.File.prototype, 'enumerate_children_async');
Gio._promisify(Gio.File.prototype, 'set_display_name_async');

function isError(e: unknown, code: number): boolean {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, code);
}

/** A catch handler that logs everything except cancellation. */
export function logError(what: string): (e: unknown) => void {
    return e => {
        if (!isError(e, Gio.IOErrorEnum.CANCELLED))
            console.error(`PastePop: ${what} failed`, e);
    };
}

/** history.json holds the index; images and long text go to blobs/<hash>. */
export class Storage {
    private readonly _dir = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'pastepop']));
    private readonly _index = this._dir.get_child('history.json');
    private readonly _blobs = this._dir.get_child('blobs');
    private readonly _cancellable = new Gio.Cancellable();
    private readonly _items: () => Item[];
    private _boot = '';
    // Nothing is written until the index has loaded, or a failed load would wipe it.
    private _loaded = false;
    private _saveId = 0;
    private _writes = 0;

    constructor(items: () => Item[]) {
        this._items = items;
    }

    /**
     * Falls back to the backup if the index is corrupt; unreadable files are renamed aside.
     * With `untilRestart`, unpinned items from an earlier boot are left out. Items whose blob is gone are dropped.
     */
    async load(untilRestart: boolean): Promise<Item[]> {
        const [boot] = await Gio.File.new_for_path('/proc/sys/kernel/random/boot_id').load_contents_async(this._cancellable);
        this._boot = new TextDecoder().decode(boot).trim();

        // Private, as it holds what was copied.
        GLib.mkdir_with_parents(this._blobs.get_path()!, 0o700);

        let index = null;
        for (const file of [this._index, this._dir.get_child('history.json~')]) {
            try {
                const [contents] = await file.load_contents_async(this._cancellable);
                index = parseIndex(new TextDecoder().decode(contents));
                break;
            } catch (e) {
                if (isError(e, Gio.IOErrorEnum.CANCELLED))
                    throw e;
                if (isError(e, Gio.IOErrorEnum.NOT_FOUND))
                    continue;
                logError(`reading ${file.get_basename()}`)(e);
                // Kept for a look; if even renaming fails, the error stops all saving rather than overwrite it.
                await file.set_display_name_async(`${file.get_basename()}.${Date.now()}.corrupt`,
                    GLib.PRIORITY_DEFAULT, this._cancellable);
            }
        }
        const blobs = new Set(await this._blobNames());
        this._loaded = true;
        if (!index)
            return [];
        const keepUnpinned = !untilRestart || index.boot === this._boot;
        return index.items.filter(i => (keepUnpinned || i.pinned) && (!i.blob || blobs.has(i.hash)));
    }

    /** Deletes blobs that nothing refers to, such as unpinned images from before a reboot. */
    async deleteOrphans(isNeeded: (hash: string) => boolean): Promise<void> {
        for (const name of await this._blobNames()) {
            if (!isNeeded(name))
                this.deleteBlob(name);
        }
    }

    /** Debounced, so a burst of changes is written once. */
    save(): void {
        if (this._saveId || !this._loaded || this._cancellable.is_cancelled())
            return;
        this._saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY, () => {
            this._saveId = 0;
            this._writes++;
            this._index.replace_contents_async(this._serialize(), null, true, Gio.FileCreateFlags.PRIVATE,
                this._cancellable)
                .catch(logError('saving history'))
                .finally(() => this._writes--);
            return GLib.SOURCE_REMOVE;
        });
    }

    blobFile(hash: string): Gio.File {
        return this._blobs.get_child(hash);
    }

    writeBlob(hash: string, data: Uint8Array): void {
        this.blobFile(hash).replace_contents_async(data, null, false, Gio.FileCreateFlags.PRIVATE, null)
            .catch(logError('saving an item'));
    }

    async readBlob(hash: string): Promise<GLib.Bytes> {
        const [bytes] = await this.blobFile(hash).load_bytes_async(this._cancellable);
        return bytes;
    }

    deleteBlob(hash: string): void {
        this.blobFile(hash).delete_async(GLib.PRIORITY_DEFAULT, null).catch(logError('deleting an item'));
    }

    /**
     * Cancels any async write and writes the index synchronously instead, so the last second of
     * changes survives lock and logout.
     */
    destroy(): void {
        const pending = this._saveId !== 0 || this._writes > 0;
        if (this._saveId)
            GLib.source_remove(this._saveId);
        this._cancellable.cancel();
        if (!pending)
            return;
        try {
            this._index.replace_contents(this._serialize(), null, true, Gio.FileCreateFlags.PRIVATE, null);
        } catch (e) {
            logError('saving history')(e);
        }
    }

    private async _blobNames(): Promise<string[]> {
        const names = [];
        const children = await this._blobs.enumerate_children_async('standard::name',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, this._cancellable);
        for await (const info of children)
            names.push(info.get_name());
        // GJS doesn't pass the cancellable on to each step of the iteration.
        this._cancellable.set_error_if_cancelled();
        return names;
    }

    private _serialize(): Uint8Array {
        return new TextEncoder().encode(JSON.stringify({boot: this._boot, items: this._items()}));
    }
}
