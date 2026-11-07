import Clutter from 'gi://Clutter';
import type Graphene from 'gi://Graphene';
import type Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

// @girs types inputMethod as any. currentFocus is set while an app or shell entry takes text input.
export const inputMethod = () => Main.inputMethod as Clutter.InputMethod & {currentFocus: Clutter.InputFocus | null};

// @girs misses that nothing has focus on the desktop or in the overview.
export function focusWindow(): Meta.Window | null {
    return global.display.focus_window;
}

export function focusedAppId(): string | null {
    const window = focusWindow();
    if (!window)
        return null;
    return Shell.WindowTracker.get_default().get_window_app(window).get_id().replace(/\.desktop$/, '');
}

/**
 * Whether the focused window takes Ctrl+Shift+V. Null when there's nothing to paste into: no window
 * has focus, or shell UI such as the overview would get the keys.
 */
export function pasteTarget(terminalApps: string[]): {terminal: boolean} | null {
    if (!focusWindow() || Main.modalCount > 0)
        return null;
    const terminal = inputMethod().content_purpose === Clutter.InputContentPurpose.TERMINAL;
    return {terminal: terminal || terminalApps.includes(focusedAppId() ?? '')};
}

/** The text caret of the focused window, in stage coordinates, when its toolkit reports one. */
export class Caret {
    rect: Rect | null = null;

    private readonly _cursorId: number;
    private readonly _focusId: number;

    constructor() {
        this._cursorId = inputMethod().connect('cursor-location-changed', (_im, rect: Graphene.Rect) => {
            // Shell entries report their carets too, our own search field included.
            if (Main.modalCount === 0)
                this.rect = {x: rect.get_x(), y: rect.get_y(), width: rect.get_width(), height: rect.get_height()};
        });
        this._focusId = global.display.connect('notify::focus-window', () => {
            this.rect = null;
        });
    }

    destroy(): void {
        inputMethod().disconnect(this._cursorId);
        global.display.disconnect(this._focusId);
    }
}
