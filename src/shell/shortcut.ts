import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SHELL_SCHEMA = 'org.gnome.shell.keybindings';
const TRAY = 'toggle-message-tray';
// Binding names are global in mutter, so ours carries the extension's name.
const KEY = 'pastepop-shortcut';
const FLAGS = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
// POPUP lets the shortcut close our own popup again, as GNOME's own popups do.
const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;

/**
 * Binds our shortcut. While it is one of the accelerators of GNOME's message tray shortcut (Super+V and
 * Super+M by default), the tray is bound to the rest of them instead.
 */
export class Shortcut {
    private readonly _settings: Gio.Settings;
    private readonly _system = new Gio.Settings({schema_id: SHELL_SCHEMA});
    private readonly _handler: () => void;
    private readonly _changedId: number;
    private readonly _systemChangedId: number;
    private _trayTaken = false;

    constructor(settings: Gio.Settings, handler: () => void) {
        this._settings = settings;
        this._handler = handler;
        this._bind();
        const rebind = () => {
            this._unbind();
            this._bind();
        };
        this._changedId = settings.connect(`changed::${KEY}`, rebind);
        this._systemChangedId = this._system.connect(`changed::${TRAY}`, rebind);
    }

    destroy(): void {
        this._settings.disconnect(this._changedId);
        this._system.disconnect(this._systemChangedId);
        this._unbind();
    }

    // Order matters, or the wrong binding wins: GNOME's goes before ours is added, and comes back after ours is gone.
    private _bind(): void {
        this._takeTray();
        Main.wm.addKeybinding(KEY, this._settings, FLAGS, MODES, this._handler);
    }

    private _unbind(): void {
        Main.wm.removeKeybinding(KEY);
        if (this._trayTaken)
            this._bindTray(this._system);
        this._trayTaken = false;
    }

    private _takeTray(): void {
        const ours = this._settings.get_strv(KEY).map(a => a.toLowerCase());
        const accels = this._system.get_strv(TRAY);
        const rest = accels.filter(a => !ours.includes(a.toLowerCase()));
        if (rest.length === accels.length)
            return;

        // A memory backend keeps the reduced list out of the user's saved settings.
        const memory = Gio.Settings.new_full(this._system.settings_schema, Gio.memory_settings_backend_new(), null);
        memory.set_strv(TRAY, rest);
        this._bindTray(memory);
        this._trayTaken = true;
    }

    private _bindTray(settings: Gio.Settings): void {
        Main.wm.removeKeybinding(TRAY);
        Main.wm.addKeybinding(TRAY, settings, FLAGS, MODES, () => Main.panel.toggleCalendar());
    }
}
