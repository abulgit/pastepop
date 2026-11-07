import assert from 'node:assert/strict';
import {test} from 'node:test';

import {pickFormat} from './mime.ts';

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
