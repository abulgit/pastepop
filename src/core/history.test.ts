import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';

import {History, createItem, fileNames, maxAge, parseIndex, preview, type Item} from './history.ts';

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text);

const HOUR = 60 * 60 * 1000;

function text(content: string, pinned = false, time = Date.now()): Item {
    return {hash: sha256(bytes(content)), kind: 'text', text: content, blob: false, pinned, time};
}

function image(hash: string, time = Date.now()): Item {
    return {hash, kind: 'image', text: '', blob: true, pinned: false, time};
}

function history(limit = 10, age = Infinity) {
    const deleted: string[] = [];
    let changes = 0;
    const h = new History(limit, age, () => changes++, hash => deleted.push(hash));
    return {h, deleted, changes: () => changes};
}

const texts = (h: History) => h.items.map(i => i.text || i.hash);

test('text is hashed fully, large images by size and edges', () => {
    const hash = (kind: 'text' | 'image', data: Uint8Array) => createItem(kind, data, sha256)?.hash;
    assert.equal(hash('text', bytes('abc')), sha256(bytes('abc')));

    const image = new Uint8Array(300 * 1024).fill(1);
    const changedMiddle = image.slice();
    changedMiddle[150 * 1024] = 2;
    const changedEnd = image.slice();
    changedEnd[image.length - 1] = 2;
    assert.match(hash('image', image) ?? '', /^307200-[0-9a-f]{64}-[0-9a-f]{64}$/);
    assert.equal(hash('image', changedMiddle), hash('image', image));
    assert.notEqual(hash('image', changedEnd), hash('image', image));
});

test('createItem skips blank text and empty images, and moves long text to a blob', () => {
    assert.equal(createItem('text', bytes(' \n\t'), sha256), null);
    assert.equal(createItem('image', new Uint8Array(), sha256), null);

    const long = createItem('text', bytes('x'.repeat(5000)), sha256);
    assert.equal(long?.blob, true);
    assert.equal(long.text.length, 4096);
    assert.equal(createItem('text', bytes('x'.repeat(4096)), sha256)?.blob, false);

    assert.equal(createItem('image', new Uint8Array([1]), sha256)?.blob, true);
    assert.equal(createItem('image', new Uint8Array([1]), sha256)?.size, undefined);
});

test('createItem reads copied files as a URI list', () => {
    const files = createItem('files', bytes('copy\nfile:///a/b%20c.txt\nfile:///d/\0'), sha256);
    assert.equal(files?.text, 'file:///a/b%20c.txt\nfile:///d/');
    assert.deepEqual(fileNames(files.text), ['b c.txt', 'd']);
});

test('long text is kept when only its preview is blank', () => {
    const content = `${' '.repeat(4096)}important text`;
    const item = createItem('text', bytes(content), sha256);
    assert.equal(item?.blob, true);
    assert.equal(item.text, ' '.repeat(4096));
    assert.equal(item.hash, sha256(bytes(content)));
    assert.equal(createItem('text', bytes(' '.repeat(5000)), sha256), null);
});

test('preview keeps about three wrapped lines and ellipsizes', () => {
    assert.equal(preview('  one\r\ntwo  '), 'one\ntwo');
    assert.equal(preview('1\n2\n3\n4'), '1\n2\n3…');
    assert.equal(preview('a'.repeat(200)), `${'a'.repeat(96)}…`);
    assert.equal(preview('字'.repeat(100)), `${'字'.repeat(48)}…`);
    assert.equal(preview(`${'a'.repeat(50)}\nb\nc`), `${'a'.repeat(50)}\nb…`);
});

test('add puts new items on top and moves duplicates, keeping the pin', () => {
    const {h} = history();
    h.add(text('a', true));
    h.add(text('b'));
    h.add(text('a'));
    assert.deepEqual(h.items.map(i => [i.text, i.pinned]), [['a', true], ['b', false]]);
});

test('the limit drops the oldest unpinned items and their blobs, and ignores pins', () => {
    const {h, deleted} = history(2);
    h.add(text('a', true));
    h.add(image('b'));
    h.add(text('c'));
    h.add(text('d'));
    assert.deepEqual(h.items.map(i => i.hash), [text('d').hash, text('c').hash, text('a').hash]);
    assert.deepEqual(deleted, ['b']);

    h.setLimit(1);
    assert.deepEqual(texts(h), ['d', 'a']);
});

test('unpinned items expire by age when pruned', () => {
    const now = Date.now();
    const {h, changes} = history(10, maxAge('day'));
    h.load([text('new', false, now - 1.5 * HOUR), text('old', false, now - 2 * HOUR), text('pin', true, now - 9 * HOUR)]);
    assert.deepEqual(texts(h), ['new', 'old', 'pin']);

    const before = changes();
    h.prune(now + 21 * HOUR);
    assert.equal(changes(), before, 'nothing expired, nothing to save');
    h.prune(now + 22.25 * HOUR);
    assert.deepEqual(texts(h), ['new', 'pin']);

    h.setMaxAge(maxAge('hour'));
    assert.deepEqual(texts(h), ['pin']);
    h.add(text('fresh', false, now - 2 * HOUR));
    assert.deepEqual(texts(h), ['pin'], 'added items are pruned too');
});

test('maxAge maps keep-unpinned values', () => {
    assert.equal(maxAge('hour'), HOUR);
    assert.equal(maxAge('week'), 7 * 24 * HOUR);
    assert.equal(maxAge('forever'), Infinity);
    assert.equal(maxAge('restart'), Infinity);
});

test('load appends saved items behind new ones', () => {
    const {h} = history();
    h.add(text('new'));
    h.load([text('old'), text('new')]);
    assert.deepEqual(texts(h), ['new', 'old']);
});

test('load deduplicates saved items and keeps the version copied while loading', () => {
    const {h} = history();
    h.add(text('new', true));
    h.load([text('old', true), text('old'), text('new')]);
    assert.deepEqual(h.items.map(i => [i.text, i.pinned]), [['new', true], ['old', true]]);
});

test('load handles a large pinned history without an argument limit', () => {
    const {h} = history();
    const items = Array.from({length: 150_000}, (_, i) => ({
        hash: `pin${i}`, kind: 'text' as const, text: `${i}`, blob: false, pinned: true, time: i,
    }));
    h.load(items);
    assert.equal(h.items.length, items.length);
    assert.equal(h.items[0], items[0]);
    assert.equal(h.items.at(-1), items.at(-1));
});

test('clear keeps pins, returns what went and keeps its blobs', () => {
    const {h, deleted} = history();
    h.add(image('a'));
    h.add(text('b', true));
    assert.deepEqual(h.clear().map(i => i.hash), ['a']);
    assert.deepEqual(texts(h), ['b']);
    assert.deepEqual(deleted, []);
});

test('restore puts pins back in place and other items by time', () => {
    const now = Date.now();
    const {h} = history();
    h.load(['a', 'b', 'c', 'd', 'e'].map((t, i) => text(t, t === 'b', now - i)));
    const [, b, c] = h.items;
    h.remove(c);
    h.remove(b);
    const cleared = h.clear();
    assert.deepEqual(texts(h), []);
    h.restore([b, c, ...cleared]);
    assert.deepEqual(texts(h), ['a', 'b', 'c', 'd', 'e']);
    assert.equal(b.pinned, true);

    const [a] = h.items;
    h.remove(a);
    h.add(text('a'));
    h.restore([a]);
    assert.deepEqual(texts(h), ['a', 'b', 'c', 'd', 'e'], 'copied again meanwhile');
});

test('restore fits items between copies made since, and trims to the limit', () => {
    const now = Date.now();
    const {h, deleted} = history(4);
    h.load([text('a', false, now - 1), text('b', false, now - 2), text('c', false, now - 3), image('d', now - 4)]);
    const [, b, , d] = h.items;
    h.remove(d);
    h.add(text('x'));
    h.remove(b);
    h.add(text('y'));
    h.restore([d, b]);
    assert.deepEqual(texts(h), ['y', 'x', 'a', 'b']);
    assert.deepEqual(deleted, ['d']);
});

test('undoing clear all after a copy leaves pins where they are', () => {
    const now = Date.now();
    const {h} = history();
    h.load([text('pin', true, now - 1), text('a', false, now - 2), text('b', false, now - 3)]);
    const cleared = h.clear();
    h.add(text('new'));
    h.restore(cleared);
    assert.deepEqual(texts(h), ['new', 'pin', 'a', 'b']);
});

test('unpinning counts as copying again', () => {
    const now = Date.now();
    const {h} = history(1, maxAge('hour'));
    h.load([text('new', false, now), text('old pin', true, now - 2 * HOUR)]);
    h.togglePin(h.items[1]);
    h.prune();
    assert.deepEqual(texts(h), ['old pin']);
});

test('unpinning enforces the limit immediately and keeps other pins', () => {
    const {h, deleted} = history(1);
    h.load([text('keep pin', true), text('unpin', true), image('old')]);
    h.togglePin(h.items[1]);
    assert.deepEqual(texts(h), ['unpin', 'keep pin']);
    assert.deepEqual(deleted, ['old']);
});

test('purge deletes the blobs that nothing else needs', () => {
    const {h, deleted} = history();
    const x = image('x');
    const y = image('y');
    h.add(x);
    h.add(y);
    h.remove(x);
    h.remove(y);
    assert.equal(h.needsBlob('x'), true);
    h.add(image('y'));
    h.purge([x, y]);
    assert.deepEqual(deleted, ['x'], 'y was copied again');
    assert.equal(h.needsBlob('x'), false);
});

test('purge keeps a blob that another undoable removal still needs', () => {
    const {h, deleted} = history();
    const first = image('same');
    const second = image('same');
    h.add(first);
    h.remove(first);
    h.add(second);
    h.remove(second);
    h.purge([first]);
    assert.deepEqual(deleted, []);
    assert.equal(h.needsBlob('same'), true);
    h.purge([second]);
    assert.deepEqual(deleted, ['same']);
});

test('togglePin', () => {
    const {h} = history();
    h.add(text('a'));
    h.togglePin(h.items[0]);
    assert.equal(h.items[0].pinned, true);
});

test('search is case-insensitive and matches file names', () => {
    const {h} = history();
    h.add(text('Hello World'));
    h.add({hash: 'f', kind: 'files', text: 'file:///tmp/My%20Report.pdf', blob: false, pinned: false, time: 0});
    h.add(image('i'));
    assert.equal(h.search('').length, 3);
    assert.deepEqual(h.search('hello').map(i => i.text), ['Hello World']);
    assert.deepEqual(h.search('my report').map(i => i.hash), ['f']);
});

test('parseIndex drops malformed entries and unsafe hashes', () => {
    const good = text('ok');
    const sized = {...image('i'), size: [3, 4]};
    const json = JSON.stringify({boot: 'b', items: [good, sized, {...good, hash: '../x'}, {...sized, size: [3]},
        {...sized, size: [0, 4]}, {...sized, size: [-1, 4]}, {...sized, size: [Number.MAX_VALUE, 4]},
        {...good, time: undefined}, {hash: 'y'}, null]});
    assert.deepEqual(parseIndex(json), {boot: 'b', items: [good, sized]});
    assert.deepEqual(parseIndex('{}'), {boot: '', items: []});
    assert.deepEqual(parseIndex(JSON.stringify({items: [good]}).replace(`"time":${good.time}`, '"time":1e400')).items, []);
    assert.throws(() => parseIndex('{'));
});
