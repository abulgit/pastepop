import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';

import {History, createItem, fileNames, parseIndex, preview, type Item} from './history.ts';

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text);

function text(content: string, pinned = false): Item {
    return {hash: sha256(bytes(content)), kind: 'text', text: content, blob: false, pinned};
}

function history(limit = 10) {
    const removed: Item[] = [];
    const h = new History(limit, r => removed.push(...r));
    return {h, removed};
}

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
});

test('createItem reads copied files as a URI list', () => {
    const files = createItem('files', bytes('copy\nfile:///a/b%20c.txt\nfile:///d/\0'), sha256);
    assert.equal(files?.text, 'file:///a/b%20c.txt\nfile:///d/');
    assert.deepEqual(fileNames(files.text), ['b c.txt', 'd']);
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

test('the limit drops the oldest unpinned items and ignores pins', () => {
    const {h, removed} = history(2);
    h.add(text('a', true));
    h.add(text('b'));
    h.add(text('c'));
    h.add(text('d'));
    assert.deepEqual(h.items.map(i => i.text), ['d', 'c', 'a']);
    assert.deepEqual(removed.map(i => i.text), ['b']);

    h.setLimit(1);
    assert.deepEqual(h.items.map(i => i.text), ['d', 'a']);
});

test('clear keeps pins and reports what went', () => {
    const {h, removed} = history();
    h.add(text('a'));
    h.add(text('b', true));
    h.clear();
    assert.deepEqual(h.items.map(i => i.text), ['b']);
    assert.deepEqual(removed.map(i => i.text), ['a']);
});

test('restore appends saved items behind new ones', () => {
    const {h} = history();
    h.add(text('new'));
    h.restore([text('old'), text('new')]);
    assert.deepEqual(h.items.map(i => i.text), ['new', 'old']);
});

test('remove and togglePin', () => {
    const {h, removed} = history();
    h.add(text('a'));
    h.add(text('b'));
    h.togglePin(h.items[0]);
    assert.equal(h.items[0].pinned, true);
    h.remove(h.items[1]);
    assert.deepEqual(h.items.map(i => i.text), ['b']);
    assert.deepEqual(removed.map(i => i.text), ['a']);
});

test('search is case-insensitive and matches file names', () => {
    const {h} = history();
    h.add(text('Hello World'));
    h.add({hash: 'f', kind: 'files', text: 'file:///tmp/My%20Report.pdf', blob: false, pinned: false});
    h.add({hash: 'i', kind: 'image', text: '', blob: true, pinned: false});
    assert.equal(h.search('').length, 3);
    assert.deepEqual(h.search('hello').map(i => i.text), ['Hello World']);
    assert.deepEqual(h.search('my report').map(i => i.hash), ['f']);
});

test('parseIndex drops malformed entries and unsafe hashes', () => {
    const good = text('ok');
    const json = JSON.stringify({boot: 'b', items: [good, {...good, hash: '../x'}, {hash: 'y'}, null]});
    assert.deepEqual(parseIndex(json), {boot: 'b', items: [good]});
    assert.deepEqual(parseIndex('{}'), {boot: '', items: []});
    assert.throws(() => parseIndex('{'));
});
