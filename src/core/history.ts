import {pngSize} from './mime.ts';

export type Kind = 'text' | 'image' | 'files';

export interface Item {
    hash: string;
    kind: Kind;
    /** Plain text, newline-separated URIs for files, empty for images. A prefix only, when `blob` is set. */
    text: string;
    /** The full content lives in blobs/<hash>: always for images, and for text over INLINE_LIMIT bytes. */
    blob: boolean;
    pinned: boolean;
    /** When it was last copied, in milliseconds since the epoch. */
    time: number;
    size?: [number, number];
}

interface Index {
    boot: string;
    items: Item[];
}

type Sha256 = (data: Uint8Array) => string;

// Enough for the preview and search; more would make the index slow to write.
const INLINE_LIMIT = 4096;
const EDGE = 64 * 1024;
const PREVIEW_LINES = 3;
// Roughly what fits on one line of a tile; wide (CJK, emoji) characters take two columns.
const LINE_COLUMNS = 32;
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
const KINDS: unknown[] = ['text', 'image', 'files'];
const HOUR = 60 * 60 * 1000;
// `restart` has no age limit; unpinned items are dropped when the index of an earlier boot loads.
const MAX_AGE: Partial<Record<string, number>> = {hour: HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR};

/** How long unpinned items are kept, in milliseconds, for a `keep-unpinned` value. */
export function maxAge(keep: string): number {
    return MAX_AGE[keep] ?? Infinity;
}

/** Images are hashed by size and edges, because hashing up to 20 MB would stall the compositor. */
function fingerprint(kind: Kind, data: Uint8Array, sha256: Sha256): string {
    if (kind !== 'image' || data.length <= 2 * EDGE)
        return sha256(data);
    return `${data.length}-${sha256(data.subarray(0, EDGE))}-${sha256(data.subarray(-EDGE))}`;
}

/** Returns null for content not worth keeping, such as the empty text the lock screen sets. */
export function createItem(kind: Kind, data: Uint8Array, sha256: Sha256): Item | null {
    if (data.length === 0)
        return null;
    const hash = fingerprint(kind, data, sha256);
    const time = Date.now();
    if (kind === 'image')
        return {hash, kind, text: '', blob: true, pinned: false, time, size: pngSize(data)};

    const blob = kind === 'text' && data.length > INLINE_LIMIT;
    let text = new TextDecoder().decode(blob ? data.subarray(0, INLINE_LIMIT) : data);
    if (kind === 'files')
        text = text.split(/[\r\n\0]+/).slice(1).filter(Boolean).join('\n');
    // A blank prefix doesn't mean the full text is blank.
    if (!text.trim() && (!blob || !new TextDecoder().decode(data).trim()))
        return null;
    return {hash, kind, text, blob, pinned: false, time};
}

function decode(text: string): string {
    try {
        return decodeURIComponent(text);
    } catch {
        return text;
    }
}

export function fileNames(uris: string): string[] {
    return uris.split('\n').map(uri => decode(uri.replace(/\/+$/, '').split('/').pop() ?? uri));
}

/** About three lines once wrapped, since the label can't limit its own line count. */
export function preview(text: string): string {
    const full = text.trim().replace(/\r\n/g, '\n');
    let head = '';
    let line = 0;
    let column = 0;
    for (const ch of full) {
        const width = ch === '\n' ? Infinity : WIDE.test(ch) ? 2 : 1;
        if (column + width > LINE_COLUMNS) {
            if (++line === PREVIEW_LINES)
                break;
            column = 0;
        }
        if (ch !== '\n')
            column += width;
        head += ch;
    }
    return head.length < full.length ? `${head.trimEnd()}…` : head;
}

/** Throws on malformed JSON; drops entries that don't look like ours. */
export function parseIndex(json: string): Index {
    const data = JSON.parse(json) as Partial<Index> | null;
    const items = Array.isArray(data?.items) ? data.items as unknown[] : [];
    return {
        boot: typeof data?.boot === 'string' ? data.boot : '',
        items: items.filter((item): item is Item => {
            const i = item as Partial<Item> | null;
            // The hash becomes a file name, so it must not be able to escape the blob directory.
            return typeof i?.hash === 'string' && /^[\w-]+$/.test(i.hash) &&
                KINDS.includes(i.kind) && typeof i.text === 'string' &&
                typeof i.blob === 'boolean' && typeof i.pinned === 'boolean' && Number.isFinite(i.time) &&
                (i.size === undefined || Array.isArray(i.size) && i.size.length === 2 &&
                    i.size.every(n => Number.isSafeInteger(n) && n > 0));
        }),
    };
}

/**
 * Newest first. Pins don't count toward the limit, don't expire and survive clearing.
 * Removed items keep their blobs until purge(), so that restore() can undo the removal.
 */
export class History {
    items: Item[] = [];
    private _limit: number;
    private _maxAge: number;
    // Removed items that can still be restored, with the index each had.
    private readonly _removed = new Map<Item, number>();
    private readonly _changed: () => void;
    private readonly _deleteBlob: (hash: string) => void;

    /** `changed` runs after every change to the list, `deleteBlob` once nothing needs a blob any more. */
    constructor(limit: number, maxAge: number, changed: () => void, deleteBlob: (hash: string) => void) {
        this._limit = limit;
        this._maxAge = maxAge;
        this._changed = changed;
        this._deleteBlob = deleteBlob;
    }

    has(hash: string): boolean {
        return this.items.some(i => i.hash === hash);
    }

    /** Whether the history or an item that can still be restored refers to a blob. */
    needsBlob(hash: string): boolean {
        if (this.has(hash))
            return true;
        for (const item of this._removed.keys()) {
            if (item.hash === hash)
                return true;
        }
        return false;
    }

    /** Copying something again moves it to the top and keeps its pin. */
    add(item: Item): void {
        const index = this.items.findIndex(i => i.hash === item.hash);
        if (index >= 0)
            item.pinned = this.items.splice(index, 1)[0].pinned;
        this.items.unshift(item);
        this._trim(Date.now());
        this._changed();
    }

    /** Appends saved items behind anything copied while they were loading. */
    load(items: Item[]): void {
        const seen = new Set(this.items.map(i => i.hash));
        for (const item of items) {
            if (!seen.has(item.hash)) {
                this.items.push(item);
                seen.add(item.hash);
            }
        }
        this._trim(Date.now());
        this._changed();
    }

    remove(item: Item): void {
        const index = this.items.indexOf(item);
        if (index < 0)
            return;
        this.items.splice(index, 1);
        this._removed.set(item, index);
        this._changed();
    }

    clear(): Item[] {
        const removed: Item[] = [];
        this.items = this.items.filter((item, index) => {
            if (item.pinned)
                return true;
            removed.push(item);
            this._removed.set(item, index);
            return false;
        });
        this._changed();
        return removed;
    }

    /**
     * Puts removed items back: pins where they were, other items by when they were copied, as
     * more may have been copied since. Restored items count toward the limit again.
     */
    restore(items: Item[]): void {
        for (const [item, index] of [...this._removed].reverse()) {
            if (!items.includes(item))
                continue;
            this._removed.delete(item);
            // Copying it again has already brought it back.
            if (this.has(item.hash))
                continue;
            const at = item.pinned ? index : this.items.findIndex(i => !i.pinned && i.time < item.time);
            this.items.splice(at < 0 ? this.items.length : at, 0, item);
        }
        this._trim(Date.now());
        this._changed();
    }

    /** Makes removals final, deleting the blobs nothing else refers to. */
    purge(items: Item[]): void {
        items.forEach(i => this._removed.delete(i));
        const hashes = new Set(items.filter(i => i.blob).map(i => i.hash));
        if (hashes.size === 0)
            return;
        // Most survivors are unrelated; deleting absent keys is costly in SpiderMonkey.
        this.items.forEach(item => {
            if (hashes.has(item.hash))
                hashes.delete(item.hash);
        });
        for (const item of this._removed.keys())
            hashes.delete(item.hash);
        for (const hash of hashes)
            this._deleteBlob(hash);
    }

    togglePin(item: Item): void {
        item.pinned = !item.pinned;
        // As if copied just now, or it could be the first to go once it counts toward the limit again.
        if (!item.pinned) {
            item.time = Date.now();
            this.items = [item, ...this.items.filter(i => i !== item)];
            this._trim(item.time);
        }
        this._changed();
    }

    setLimit(limit: number): void {
        this._limit = limit;
        this.prune();
    }

    setMaxAge(maxAge: number): void {
        this._maxAge = maxAge;
        this.prune();
    }

    /** Drops unpinned items beyond the limit or older than the maximum age. */
    prune(now = Date.now()): void {
        if (this._trim(now))
            this._changed();
    }

    search(query: string): Item[] {
        const needle = query.trim().toLowerCase();
        if (!needle)
            return this.items;
        return this.items.filter(i => {
            const haystack = i.kind === 'files' ? fileNames(i.text).join('\n') : i.text;
            return haystack.toLowerCase().includes(needle);
        });
    }

    private _trim(now: number): boolean {
        const dropped = this.items.filter(i => !i.pinned)
            .filter((item, index) => index >= this._limit || now - item.time > this._maxAge);
        if (dropped.length === 0)
            return false;
        const removed = new Set(dropped);
        this.items = this.items.filter(i => !removed.has(i));
        this.purge(dropped);
        return true;
    }
}
