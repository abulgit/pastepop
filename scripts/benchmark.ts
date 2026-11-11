// npm run build
// npx tsc -p tsconfig.test.json --noEmit false --outDir /tmp/pastepop-benchmark
// gjs -m /tmp/pastepop-benchmark/scripts/benchmark.js "$PWD/dist/core/history.js"
// Run each revision in a separate process on the same idle machine.
import type {} from '@girs/gjs';
import type {} from '@girs/glib-2.0';
import GLib from 'gi://GLib';
import System from 'system';

import type {Item} from '../src/core/history.ts';

if (ARGV.length !== 1)
    throw new Error('Usage: gjs -m benchmark.js <built core/history.js path or URI>');
const uri = ARGV[0].includes('://') ? ARGV[0]
    : GLib.filename_to_uri(GLib.canonicalize_filename(ARGV[0], null), null);
const {History} = await import(uri) as typeof import('../src/core/history.ts');
const now = Date.now();
const item = (id: number | string, pinned = false, blob = false): Item => ({
    hash: `item${id}`, kind: blob ? 'image' : 'text', text: `text ${id}`, blob, pinned, time: now,
});
const operations = ['add', 'prune', 'expire', 'clear', 'load', 'load-after-copy'] as const;
const warmup = 5;
const samples = 30;
const iterations = 10;

function measure(pins: number, limit: number, operation: typeof operations[number]): number {
    const entries = [
        ...Array.from({length: pins}, (_, i) => item(i, true)),
        ...Array.from({length: limit}, (_, i) => item(pins + i, false, true)),
    ];
    const timings = [];
    for (let sample = 0; sample < warmup + samples; sample++) {
        System.gc();
        let elapsed = 0;
        for (let iteration = 0; iteration < iterations; iteration++) {
            const h = new History(limit, Infinity, () => {}, () => {});
            h.items = entries.slice();
            let run: () => unknown;
            switch (operation) {
            case 'add': run = () => h.add(item('extra')); break;
            case 'prune': run = () => h.prune(now); break;
            case 'expire': run = () => h.setMaxAge(-1); break;
            case 'clear': run = () => h.clear(); break;
            case 'load': h.items = []; run = () => h.load(entries); break;
            case 'load-after-copy':
                h.items = Array.from({length: 10}, (_, i) => item(`new${i}`));
                run = () => h.load(entries);
                break;
            }
            // Input construction and forced GC are excluded; normal allocation inside the method is included.
            const start = GLib.get_monotonic_time();
            run();
            elapsed += (GLib.get_monotonic_time() - start) / 1000;
        }
        if (sample >= warmup)
            timings.push(elapsed / iterations);
    }
    timings.sort((a, b) => a - b);
    return (timings[samples / 2 - 1] + timings[samples / 2]) / 2;
}

print(JSON.stringify({runtime: 'GJS', version: System.version, statistic: 'median', samples, iterations}));
for (const limit of [10, 100]) {
    for (const pins of [0, 1000, 10000]) {
        for (const operation of operations)
            print(JSON.stringify({limit, pins, operation, medianMs: measure(pins, limit, operation)}));
    }
}
