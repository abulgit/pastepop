import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {appsRow} from './prefs/apps.ts';
import {comboRow, shortcutRow, switchRow} from './prefs/rows.ts';

function group(rows: Gtk.Widget[], title = '', description = ''): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({title, description});
    rows.forEach(row => group.add(row));
    return group;
}

function page(title: string, iconName: string, groups: Adw.PreferencesGroup[]): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({title, icon_name: iconName});
    groups.forEach(g => page.add(g));
    return page;
}

export default class PastePopPreferences extends ExtensionPreferences {
    override fillPreferencesWindow(window: Adw.PreferencesWindow): Promise<void> {
        const settings = this.getSettings();
        window.search_enabled = true;
        window.add(this._general(window, settings));
        window.add(this._privacy(window, settings));
        return Promise.resolve();
    }

    private _general(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.PreferencesPage {
        const size = Adw.SpinRow.new_with_range(1, 100, 1);
        size.title = _('Items to keep');
        size.subtitle = _('Pinned items don’t count');
        settings.bind('history-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);

        const about = new Adw.ActionRow({title: _('About PastePop'), activatable: true});
        about.connect('activated', () => {
            const url = this.metadata.url as string;
            new Adw.AboutDialog({
                application_name: 'PastePop',
                application_icon: 'edit-paste-symbolic',
                developer_name: 'Abul',
                version: this.metadata['version-name'] as string,
                website: url,
                issue_url: `${url}/issues`,
                license_type: Gtk.License.GPL_2_0,
            }).present(window);
        });

        return page(_('General'), 'preferences-system-symbolic', [
            group([shortcutRow(window, settings)], _('Shortcut')),
            group([
                size,
                comboRow(settings, 'keep-unpinned', _('Keep unpinned items'), [
                    ['forever', _('Forever')],
                    ['restart', _('Until restart')],
                    ['hour', _('For an hour')],
                    ['day', _('For a day')],
                    ['week', _('For a week')],
                ]),
            ], _('History')),
            group([
                comboRow(settings, 'open-at', _('Open at'), [
                    ['caret', _('Text cursor')],
                    ['pointer', _('Mouse pointer')],
                    ['center', _('Center of the screen')],
                ]),
                switchRow(settings, 'show-symbols', _('Emoji & symbols tabs')),
                switchRow(settings, 'paste-on-select', _('Paste automatically'),
                    _('When off, choosing an item only copies it')),
            ], _('Popup')),
            group([
                appsRow(window, settings, 'terminal-apps', _('Terminal apps'),
                    _('These apps paste with Ctrl+Shift+V')),
            ], _('Advanced')),
            group([about]),
        ]);
    }

    private _privacy(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.PreferencesPage {
        const dir = GLib.build_filenamev([GLib.get_user_data_dir(), 'pastepop']);
        const open = new Gtk.Button({label: _('Open Folder'), valign: Gtk.Align.CENTER});
        open.connect('clicked', () => new Gtk.FileLauncher({file: Gio.File.new_for_path(dir)}).launch(window, null, null));
        const storage = new Adw.ActionRow({
            title: _('Storage'),
            subtitle: dir.replace(GLib.get_home_dir(), '~'),
            subtitle_selectable: true,
        });
        storage.add_suffix(open);

        return page(_('Privacy'), 'preferences-system-privacy-symbolic', [
            group([
                switchRow(settings, 'private-mode', _('Private mode'), _('Stop recording what you copy')),
                appsRow(window, settings, 'excluded-apps', _('Excluded apps'),
                    _('What you copy in these apps is never recorded')),
            ]),
            group([storage], _('Data'), _('Your clipboard history is kept only on this computer')),
        ]);
    }
}
