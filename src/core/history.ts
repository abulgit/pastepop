export type Kind = 'text' | 'image' | 'files';

export interface Item {
    hash: string;
    kind: Kind;
    /** Plain text, newline-separated URIs for files, empty for images. A prefix only, when `blob` is set. */
    text: string;
    /** The full content lives in blobs/<hash>: always for images, and for text over INLINE_LIMIT bytes. */
    blob: boolean;
    pinned: boolean;
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
    if (kind === 'image')
        return {hash, kind, text: '', blob: true, pinned: false};

    const blob = kind === 'text' && data.length > INLINE_LIMIT;
    let text = new TextDecoder().decode(blob ? data.subarray(0, INLINE_LIMIT) : data);
    if (kind === 'files')
        text = text.split(/[\r\n\0]+/).slice(1).filter(Boolean).join('\n');
    return text.trim() ? {hash, kind, text, blob, pinned: false} : null;
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
                typeof i.blob === 'boolean' && typeof i.pinned === 'boolean';
        }),
    };
}

/** Newest first. Pins don't move; they don't count toward the limit and survive clearing. */
export class History {
    items: Item[] = [];
    private _limit: number;
    private readonly _changed: (removed: Item[]) => void;

    /** `changed` runs after every mutation with the items that left the history. */
    constructor(limit: number, changed: (removed: Item[]) => void) {
        this._limit = limit;
        this._changed = changed;
    }

    has(hash: string): boolean {
        return this.items.some(i => i.hash === hash);
    }

    /** Copying something again moves it to the top and keeps its pin. */
    add(item: Item): void {
        const index = this.items.findIndex(i => i.hash === item.hash);
        if (index >= 0)
            item.pinned = this.items.splice(index, 1)[0].pinned;
        this.items.unshift(item);
        this._changed(this._trim());
    }

    /** Appends saved items behind anything copied while they were loading. */
    restore(items: Item[]): void {
        this.items.push(...items.filter(i => !this.has(i.hash)));
        this._changed(this._trim());
    }

    remove(item: Item): void {
        this.items = this.items.filter(i => i !== item);
        this._changed([item]);
    }

    togglePin(item: Item): void {
        item.pinned = !item.pinned;
        this._changed([]);
    }

    clear(): void {
        const removed = this.items.filter(i => !i.pinned);
        this.items = this.items.filter(i => i.pinned);
        this._changed(removed);
    }

    setLimit(limit: number): void {
        this._limit = limit;
        this._changed(this._trim());
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

    private _trim(): Item[] {
        const removed = this.items.filter(i => !i.pinned).slice(this._limit);
        this.items = this.items.filter(i => !removed.includes(i));
        return removed;
    }
}
