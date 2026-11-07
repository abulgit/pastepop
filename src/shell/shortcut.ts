import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SHELL_SCHEMA = 'org.gnome.shell.keybindings';
const TRAY = 'toggle-message-tray';
// Binding names are global in mutter, so ours carries the extension's name.
const KEY = 'ctrlv-shortcut';
const FLAGS = Meta.KeyBindingFlags.IGNORE_AUTOREPEAT;
// POPUP lets the shortcut close our own popup again, as GNOME's own popups do.
const MODES = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;

/**
 * Binds our shortcut. With takeover on, GNOME's message tray shortcut (Super+V and Super+M by default)
 * is rebound to whatever is left once ours is removed.
 */
export class Shortcut {
    private readonly _settings: Gio.Settings;
    private readonly _handler: () => void;
    private readonly _changedIds: number[];
    private _trayTaken = false;

    constructor(settings: Gio.Settings, handler: () => void) {
        this._settings = settings;
        this._handler = handler;
        this._bind();
        this._changedIds = ([`changed::${KEY}`, 'changed::takeover-shortcut'] as const).map(signal =>
            settings.connect(signal, () => {
                this._unbind();
                this._bind();
            }));
    }

    destroy(): void {
        this._changedIds.forEach(id => this._settings.disconnect(id));
        this._unbind();
    }

    // Order matters, or the wrong binding wins: GNOME's goes before ours is added, and comes back after ours is gone.
    private _bind(): void {
        if (this._settings.get_boolean('takeover-shortcut'))
            this._takeTray();
        Main.wm.addKeybinding(KEY, this._settings, FLAGS, MODES, this._handler);
    }

    private _unbind(): void {
        Main.wm.removeKeybinding(KEY);
        if (this._trayTaken)
            this._bindTray(new Gio.Settings({schema_id: SHELL_SCHEMA}));
        this._trayTaken = false;
    }

    private _takeTray(): void {
        const ours = this._settings.get_strv(KEY).map(a => a.toLowerCase());
        const system = new Gio.Settings({schema_id: SHELL_SCHEMA});
        const accels = system.get_strv(TRAY);
        const rest = accels.filter(a => !ours.includes(a.toLowerCase()));
        if (rest.length === accels.length)
            return;

        // A memory backend keeps the reduced list out of the user's saved settings.
        const memory = Gio.Settings.new_full(system.settings_schema, Gio.memory_settings_backend_new(), null);
        memory.set_strv(TRAY, rest);
        this._bindTray(memory);
        this._trayTaken = true;
    }

    private _bindTray(settings: Gio.Settings): void {
        Main.wm.removeKeybinding(TRAY);
        Main.wm.addKeybinding(TRAY, settings, FLAGS, MODES, () => Main.panel.toggleCalendar());
    }
}
