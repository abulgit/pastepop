import assert from 'node:assert/strict';
import {test} from 'node:test';

import {pickFormat, pngSize} from './mime.ts';

test('files win over the text that file managers also offer', () => {
    assert.deepEqual(pickFormat(['text/plain', 'x-special/gnome-copied-files', 'text/uri-list']),
        {kind: 'files', mime: 'x-special/gnome-copied-files'});
});

test('text wins over a picture of it, utf-8 first', () => {
    assert.deepEqual(pickFormat(['image/png', 'STRING', 'text/plain;charset=utf-8']),
        {kind: 'text', mime: 'text/plain;charset=utf-8'});
    assert.deepEqual(pickFormat(['UTF8_STRING', 'TEXT']), {kind: 'text', mime: 'UTF8_STRING'});
});

test('images without text, nothing for unknown formats', () => {
    assert.deepEqual(pickFormat(['text/html', 'image/png']), {kind: 'image', mime: 'image/png'});
    assert.equal(pickFormat(['image/jpeg']), null);
    assert.equal(pickFormat([]), null);
});

test('pngSize reads the IHDR chunk', () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
        0, 0, 0x07, 0x80, 0, 0, 0x04, 0x38, 8, 6, 0, 0, 0]);
    assert.deepEqual(pngSize(png), [1920, 1080]);
    assert.deepEqual(pngSize(png.subarray(0, 24)), [1920, 1080]);
    assert.equal(pngSize(png.subarray(0, 23)), undefined);
    assert.equal(pngSize(Uint8Array.from([0xff, ...png.subarray(1)])), undefined);
    const padded = new Uint8Array(png.length + 3);
    padded.set(png, 3);
    assert.deepEqual(pngSize(padded.subarray(3)), [1920, 1080]);
});
