import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {watch} from './rows.ts';

/** Installed apps by the id that the shell's window tracker reports, without the .desktop suffix. */
function installedApps(): Map<string, Gio.AppInfo> {
    return new Map(Gio.AppInfo.get_all().map(app => [app.get_id()?.replace(/\.desktop$/, '') ?? '', app]));
}

function appRow(id: string, app: Gio.AppInfo | undefined): Adw.ActionRow {
    const row = new Adw.ActionRow({title: app?.get_display_name() ?? id, subtitle: app ? id : '', use_markup: false});
    row.add_prefix(new Gtk.Image({
        gicon: app?.get_icon() ?? new Gio.ThemedIcon({name: 'application-x-executable'}),
        icon_size: Gtk.IconSize.LARGE,
    }));
    return row;
}

/** A row opening a page that lists the apps in an app id key, where apps can be added and removed. */
export function appsRow(window: Adw.PreferencesWindow, settings: Gio.Settings, key: string, title: string,
    description: string): Adw.ActionRow {
    const row = new Adw.ActionRow({title, subtitle: description, activatable: true});
    row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
    row.connect('activated', () => window.push_subpage(appsPage(window, settings, key, title, description)));
    return row;
}

function appsPage(window: Adw.PreferencesWindow, settings: Gio.Settings, key: string, title: string,
    description: string): Adw.NavigationPage {
    const installed = installedApps();
    const list = new Adw.PreferencesGroup({description});
    let rows: Adw.ActionRow[] = [];

    const add = new Adw.ButtonRow({title: _('Add App…'), start_icon_name: 'list-add-symbolic'});
    add.connect('activated', () => pickApp(window, settings, key, installed));
    const actions = new Adw.PreferencesGroup();
    actions.add(add);

    const page = new Adw.PreferencesPage();
    page.add(list);
    page.add(actions);
    watch(settings, key, page, () => {
        rows.forEach(row => list.remove(row));
        rows = settings.get_strv(key).map(id => {
            const row = appRow(id, installed.get(id));
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove'),
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
            });
            remove.connect('clicked', () => settings.set_strv(key, settings.get_strv(key).filter(i => i !== id)));
            row.add_suffix(remove);
            list.add(row);
            return row;
        });
    });

    const toolbar = new Adw.ToolbarView({content: page});
    toolbar.add_top_bar(new Adw.HeaderBar());
    return new Adw.NavigationPage({title, child: toolbar});
}

function pickApp(window: Adw.PreferencesWindow, settings: Gio.Settings, key: string,
    installed: Map<string, Gio.AppInfo>): void {
    const search = new Gtk.SearchEntry({placeholder_text: _('Search apps'), hexpand: true});
    const dialog = new Adw.Dialog({title: _('Add App'), content_width: 420, content_height: 560, focus_widget: search});
    const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, valign: Gtk.Align.START, css_classes: ['boxed-list']});
    list.set_placeholder(new Gtk.Label({label: _('No apps found'), margin_top: 12, margin_bottom: 12, css_classes: ['dim-label']}));

    const chosen = settings.get_strv(key);
    const apps = [...installed].filter(([id, app]) => app.should_show() && !chosen.includes(id))
        .sort(([, a], [, b]) => a.get_display_name().localeCompare(b.get_display_name()));
    for (const [id, app] of apps) {
        const row = appRow(id, app);
        row.activatable = true;
        row.connect('activated', () => {
            settings.set_strv(key, [...settings.get_strv(key), id]);
            dialog.close();
        });
        list.append(row);
    }
    list.set_filter_func(row => {
        const {title, subtitle} = row as Adw.ActionRow;
        return `${title}\n${subtitle}`.toLowerCase().includes(search.text.toLowerCase());
    });
    search.connect('search-changed', () => list.invalidate_filter());
    search.connect('stop-search', () => dialog.close());
    search.set_key_capture_widget(dialog);

    const toolbar = new Adw.ToolbarView({
        content: new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            child: new Adw.Clamp({
                child: list,
                margin_top: 12,
                margin_bottom: 12,
                margin_start: 12,
                margin_end: 12,
            }),
        }),
    });
    toolbar.add_top_bar(new Adw.HeaderBar());
    toolbar.add_top_bar(new Adw.Bin({child: search, margin_start: 12, margin_end: 12, margin_bottom: 6}));
    dialog.child = toolbar;
    dialog.present(window);
}
