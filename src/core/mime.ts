import type {Kind} from './history.ts';

export const TEXT_MIME = 'text/plain;charset=utf-8';
export const PASSWORD_HINT = 'x-kde-passwordManagerHint';
const COPIED_FILES = 'x-special/gnome-copied-files';
const TEXT_MIMES = [TEXT_MIME, 'UTF8_STRING', 'text/plain', 'STRING'];

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
