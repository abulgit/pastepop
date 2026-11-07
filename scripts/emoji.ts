// Writes data/emoji.json from emojibase-data: base emoji by group, as [emoji, name, keywords].
import {writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';

import type {Emoji} from 'emojibase';

// Emoji 18 has no colour glyphs in Noto Color Emoji 2026-09, the version Fedora 45 ships.
const MAX_VERSION = 17;
// emojibase group numbers; 2 holds the skin tone and hair components.
const GROUPS = new Map<number | undefined, string>([
    [0, 'smileys'], [1, 'people'], [3, 'nature'], [4, 'food'], [5, 'travel'],
    [6, 'activities'], [7, 'objects'], [8, 'symbols'], [9, 'flags'],
]);

const sections: Record<string, string[][]> = Object.fromEntries([...GROUPS.values()].map(id => [id, []]));
for (const emoji of createRequire(import.meta.url)('emojibase-data/en/data.json') as Emoji[]) {
    const id = GROUPS.get(emoji.group);
    if (!id || emoji.version > MAX_VERSION)
        continue;
    const words = new Set(emoji.label.toLowerCase().split(/\W+/));
    const keywords = (emoji.tags ?? []).map(t => t.toLowerCase()).filter(t => !words.has(t));
    sections[id].push([emoji.emoji, emoji.label, keywords.join(' ')]);
}

// One emoji per line keeps updates reviewable.
const json = Object.entries(sections).map(([id, items]) => `"${id}": [\n${items.map(i => JSON.stringify(i)).join(',\n')}\n]`);
writeFileSync(new URL('../data/emoji.json', import.meta.url), `{\n${json.join(',\n')}\n}\n`);
