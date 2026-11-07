import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SHORTCUT = 'pastepop-shortcut';
const GNOME_KEYBINDINGS = ['org.gnome.shell.keybindings', 'org.gnome.desktop.wm.keybindings',
    'org.gnome.mutter.keybindings', 'org.gnome.mutter.wayland.keybindings', 'org.gnome.settings-daemon.plugins.media-keys'];

/** Runs `sync` now and whenever `key` changes, for as long as `widget` exists. */
export function watch(settings: Gio.Settings, key: string, widget: Gtk.Widget, sync: () => void): void {
    sync();
    const id = settings.connect(`changed::${key}`, sync);
    widget.connect('destroy', () => settings.disconnect(id));
}

export function switchRow(settings: Gio.Settings, key: string, title: string, subtitle = ''): Adw.SwitchRow {
    const row = new Adw.SwitchRow({title, subtitle, use_markup: false});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function comboRow(settings: Gio.Settings, key: string, title: string, options: [string, string][]): Adw.ComboRow {
    const values = options.map(([value]) => value);
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(options.map(([, label]) => label))});
    watch(settings, key, row, () => {
        row.selected = values.indexOf(settings.get_string(key));
    });
    row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
    return row;
}

/** What GNOME uses an accelerator for, apart from the message tray, which PastePop takes over. */
function gnomeAction(accel: string): string | null {
    const [, key, mods] = Gtk.accelerator_parse(accel);
    const same = (other: string) => {
        const [, otherKey, otherMods] = Gtk.accelerator_parse(other);
        return otherKey === key && otherMods === mods;
    };
    for (const id of GNOME_KEYBINDINGS) {
        const schema = Gio.SettingsSchemaSource.get_default()?.lookup(id, true);
        if (!schema)
            continue;
        const settings = new Gio.Settings({settings_schema: schema});
        const name = schema.list_keys().find(k => k !== 'toggle-message-tray' &&
            schema.get_key(k).get_value_type().dup_string() === 'as' && settings.get_strv(k).some(same));
        if (name)
            return schema.get_key(name).get_summary();
    }
    return null;
}

export function shortcutRow(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.ActionRow {
    const label = new Adw.ShortcutLabel({disabled_text: _('Disabled'), valign: Gtk.Align.CENTER});
    const row = new Adw.ActionRow({title: _('Open clipboard'), activatable: true, use_markup: false});
    row.add_suffix(label);
    watch(settings, SHORTCUT, row, () => {
        const accel = settings.get_strv(SHORTCUT).at(0) ?? '';
        const action = accel && gnomeAction(accel);
        label.accelerator = accel;
        // Translators: %s is a GNOME shortcut's description, such as “Switch applications”.
        row.subtitle = action ? _('Also used by GNOME: %s').format(action) : '';
    });
    row.connect('activated', () => captureShortcut(window, settings));
    return row;
}

/** Asks for a key combination. GNOME's own shortcuts are inhibited meanwhile, so that Super+V gets here. */
function captureShortcut(window: Adw.PreferencesWindow, settings: Gio.Settings): void {
    const dialog = new Adw.AlertDialog({
        heading: _('Set Shortcut'),
        body: _('Press a key combination with Ctrl, Alt or Super, or Esc to cancel.'),
        close_response: 'cancel',
        default_response: 'super-v',
    });
    dialog.add_response('cancel', _('Cancel'));
    dialog.add_response('disable', _('Disable'));
    dialog.add_response('super-v', _('Use Super+V'));
    dialog.set_response_appearance('super-v', Adw.ResponseAppearance.SUGGESTED);
    dialog.connect('response', (_dialog, response: string) => {
        if (response === 'super-v')
            settings.set_strv(SHORTCUT, ['<Super>v']);
        else if (response === 'disable')
            settings.set_strv(SHORTCUT, []);
    });

    const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
    keys.connect('key-pressed', (_keys, keyval: number, _keycode: number, state: Gdk.ModifierType) => {
        const mods = state & Gtk.accelerator_get_default_mod_mask();
        // Without Ctrl, Alt or Super, the shortcut would swallow typing.
        if ((mods & ~Gdk.ModifierType.SHIFT_MASK) === 0 || !Gtk.accelerator_valid(keyval, mods))
            return Gdk.EVENT_PROPAGATE;
        settings.set_strv(SHORTCUT, [Gtk.accelerator_name(Gdk.keyval_to_lower(keyval), mods)]);
        dialog.close();
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(keys);

    const toplevel = window.get_surface() as Gdk.Toplevel;
    toplevel.inhibit_system_shortcuts(null);
    dialog.connect('closed', () => toplevel.restore_system_shortcuts());
    dialog.present(window);
}
