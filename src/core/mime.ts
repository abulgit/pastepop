import type {Kind} from './history.ts';

export const TEXT_MIME = 'text/plain;charset=utf-8';
export const PASSWORD_HINT = 'x-kde-passwordManagerHint';
const COPIED_FILES = 'x-special/gnome-copied-files';
const TEXT_MIMES = [TEXT_MIME, 'UTF8_STRING', 'text/plain', 'STRING'];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = 0x49484452;

/** Picks the one format worth reading, or null for things we can't show. */
export function pickFormat(mimes: string[]): {kind: Kind; mime: string} | null {
    if (mimes.includes(COPIED_FILES))
        return {kind: 'files', mime: COPIED_FILES};
    // Office apps put a picture of the selection next to the text; the text is what was meant.
    const text = TEXT_MIMES.find(m => mimes.includes(m));
    if (text)
        return {kind: 'text', mime: text};
    return mimes.includes('image/png') ? {kind: 'image', mime: 'image/png'} : null;
}

/** Width and height from a PNG's IHDR chunk, which always comes first. */
export function pngSize(data: Uint8Array): [number, number] | undefined {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data.length < 24 || PNG_SIGNATURE.some((byte, i) => data[i] !== byte) || view.getUint32(12) !== IHDR)
        return undefined;
    return [view.getUint32(16), view.getUint32(20)];
}
