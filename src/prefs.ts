import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function listRow(settings: Gio.Settings, key: string, title: string): Adw.EntryRow {
    const row = new Adw.EntryRow({title, text: settings.get_strv(key).join(', '), show_apply_button: true});
    row.connect('apply', () => settings.set_strv(key, row.text.split(',').map(s => s.trim()).filter(Boolean)));
    return row;
}

function switchRow(settings: Gio.Settings, key: string, title: string, subtitle: string): Adw.SwitchRow {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export default class CtrlVPreferences extends ExtensionPreferences {
    override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();

        const shortcut = new Adw.EntryRow({
            title: 'Shortcut',
            text: settings.get_strv('ctrlv-shortcut').at(0) ?? '',
            show_apply_button: true,
        });
        shortcut.connect('apply', () => {
            const [valid, key] = Gtk.accelerator_parse(shortcut.text);
            if (valid && key !== 0) {
                shortcut.remove_css_class('error');
                settings.set_strv('ctrlv-shortcut', [shortcut.text]);
            } else {
                shortcut.add_css_class('error');
            }
        });

        const keyboard = new Adw.PreferencesGroup({title: 'Keyboard'});
        keyboard.add(shortcut);
        keyboard.add(switchRow(settings, 'takeover-shortcut', 'Take over Super+V',
            'GNOME uses it for the notification list, which stays on Super+M'));

        const size = Adw.SpinRow.new_with_range(1, 100, 1);
        size.title = 'Items to keep';
        size.subtitle = 'Pinned items don\'t count';
        settings.bind('history-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);

        const history = new Adw.PreferencesGroup({title: 'History'});
        history.add(size);
        history.add(switchRow(settings, 'persist-history', 'Keep history after restart',
            'When off, only pinned items survive a restart'));
        history.add(switchRow(settings, 'private-mode', 'Private mode', 'Stop recording what you copy'));

        const apps = new Adw.PreferencesGroup({
            title: 'Apps',
            description: 'Comma-separated app IDs, such as org.gnome.Ptyxis',
        });
        apps.add(listRow(settings, 'excluded-apps', 'Never record copies from'));
        apps.add(listRow(settings, 'terminal-apps', 'Paste with Ctrl+Shift+V in'));

        const page = new Adw.PreferencesPage();
        page.add(keyboard);
        page.add(history);
        page.add(apps);
        window.add(page);
        return Promise.resolve();
    }
}
