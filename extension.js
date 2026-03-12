import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';

// D-Bus interface: supergfxctl (GPU mode switching)
const SuperGfxIface = `<node>
  <interface name="org.supergfxctl.Daemon">
    <method name="Mode">
      <arg type="u" direction="out"/>
    </method>
    <method name="SetMode">
      <arg name="mode" type="u" direction="in"/>
      <arg type="u" direction="out"/>
    </method>
    <method name="PendingMode">
      <arg type="u" direction="out"/>
    </method>
    <method name="PendingUserAction">
      <arg type="u" direction="out"/>
    </method>
    <signal name="NotifyGfx">
      <arg name="mode" type="u"/>
    </signal>
    <signal name="NotifyAction">
      <arg name="action" type="u"/>
    </signal>
  </interface>
</node>`;

// GPU mode enum (supergfxctl GfxMode)
const GfxMode = {HYBRID: 0, INTEGRATED: 1, NVIDIA_NO_MODESET: 2, VFIO: 3, ASUS_EGPU: 4, ASUS_MUX_DGPU: 5};
const GFX_INFO = {
    [GfxMode.HYBRID]:       {label: 'Hybrid',     icon: 'video-display-symbolic',              menuIcon: 'video-display-symbolic'},
    [GfxMode.INTEGRATED]:   {label: 'Integrated', icon: 'power-profile-power-saver-symbolic', menuIcon: 'power-profile-power-saver-symbolic'},
    [GfxMode.ASUS_MUX_DGPU]: {label: 'MUX dGPU', icon: 'applications-games-symbolic',        menuIcon: 'applications-games-symbolic'},
};
const WANTED_GFX_MODES = [GfxMode.INTEGRATED, GfxMode.HYBRID, GfxMode.ASUS_MUX_DGPU];

// User action required after GPU mode switch
const UserAction = {LOGOUT: 0, REBOOT: 1, SWITCH_TO_INTEGRATED: 2, ASUS_EGPU_DISABLE: 3, NOTHING: 4};
const ACTION_SHORT = {
    [UserAction.LOGOUT]: 'pending logout',
    [UserAction.REBOOT]: 'pending reboot',
};

const SuperGfxProxy = Gio.DBusProxy.makeProxyWrapper(SuperGfxIface);

// --- System actions (skip second confirmation since we already confirmed) ---

function triggerSystemAction(action) {
    switch (action) {
    case 'logout':
        // Mode 1 = no confirmation (we already confirmed in our dialog)
        Gio.DBus.session.call(
            'org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', 'Logout',
            new GLib.Variant('(u)', [1]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
        break;
    case 'restart':
        Gio.DBus.system.call(
            'org.freedesktop.login1', '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager', 'Reboot',
            new GLib.Variant('(b)', [true]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
        break;
    case 'poweroff':
        Gio.DBus.system.call(
            'org.freedesktop.login1', '/org/freedesktop/login1',
            'org.freedesktop.login1.Manager', 'PowerOff',
            new GLib.Variant('(b)', [true]),
            null, Gio.DBusCallFlags.NONE, -1, null, null);
        break;
    }
}

// --- GPU Switch Confirmation Dialog ---

const GpuSwitchDialog = GObject.registerClass(
class GpuSwitchDialog extends ModalDialog.ModalDialog {
    _init(fromMode, toMode, onConfirm) {
        super._init({destroyOnClose: true});

        const fromInfo = GFX_INFO[fromMode] ?? {label: `Mode ${fromMode}`};
        const toInfo = GFX_INFO[toMode] ?? {label: `Mode ${toMode}`};
        const needsReboot = fromMode === GfxMode.ASUS_MUX_DGPU
            || toMode === GfxMode.ASUS_MUX_DGPU;

        const content = new Dialog.MessageDialogContent({
            title: 'Switch GPU Mode',
            description: needsReboot
                ? `Switching from ${fromInfo.label} to ${toInfo.label} requires a reboot.`
                : `Switching from ${fromInfo.label} to ${toInfo.label} requires logging out.`,
        });
        this.contentLayout.add_child(content);

        // Reboot-type (MUX involved): config+firmware written immediately
        // by SetMode, so both restart and power off apply the change.
        //
        // Logout-type (Hybrid <-> Integrated): daemon waits for session end
        // then does driver work. Reboot/shutdown kills the daemon before it
        // finishes, losing the change. Only logout works.
        if (needsReboot) {
            this.setButtons([
                {label: 'Cancel', action: () => this.close(), key: Clutter.KEY_Escape},
                {label: 'Power Off', action: () => this._confirm(onConfirm, 'poweroff')},
                {label: 'Restart', action: () => this._confirm(onConfirm, 'restart'), 'default': true},
            ]);
        } else {
            this.setButtons([
                {label: 'Cancel', action: () => this.close(), key: Clutter.KEY_Escape},
                {label: 'Log Out', action: () => this._confirm(onConfirm, 'logout'), 'default': true},
            ]);
        }
    }

    // Wait for dialog to fully close before triggering the action,
    // following the same pattern as GNOME's EndSessionDialog.
    _confirm(onConfirm, action) {
        const signalId = this.connect('closed', () => {
            this.disconnect(signalId);
            onConfirm(action);
        });
        this.close();
    }
});

// --- GPU Mode Quick Toggle ---

const GpuModeToggle = GObject.registerClass(
class GpuModeToggle extends QuickSettings.QuickMenuToggle {
    _init() {
        super._init({
            title: 'GPU Mode',
            iconName: 'video-display-symbolic',
            toggleMode: true,
        });

        this._proxy = null;
        this._notifyGfxId = 0;
        this._nameOwnerId = 0;
        this._currentMode = null;
        this._sessionMode = null;
        this._rebootTarget = null;
        this._pendingMode = null;
        this._pendingAction = null;
        this._switching = false;
        this._pendingPollId = 0;
        this._items = {};

        // Click the toggle body: cycle GPU mode
        // Hybrid → Integrated, anything else → Hybrid
        this.connect('clicked', () => {
            this.checked = this._currentMode === GfxMode.ASUS_MUX_DGPU;
            if (this._currentMode === null)
                return;
            const target = this._currentMode === GfxMode.HYBRID
                ? GfxMode.INTEGRATED : GfxMode.HYBRID;
            this._onModeSelected(target);
        });

        this.menu.setHeader('video-display-symbolic', 'GPU Mode');
        this._section = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._section);

        this._connectProxy();
    }

    _connectProxy() {
        try {
            SuperGfxProxy(
                Gio.DBus.system,
                'org.supergfxctl.Daemon',
                '/org/supergfxctl/Gfx',
                (proxy, error) => {
                    if (error) {
                        log(`[AsusGpuControl] SuperGfx proxy error: ${error.message}`);
                        this.subtitle = 'Unavailable';
                        return;
                    }
                    this._proxy = proxy;
                    this._proxy.set_default_timeout(120000);

                    this._notifyGfxId = proxy.connectSignal(
                        'NotifyGfx', () => {
                            this._switching = false;
                            this._fetchMode();
                        });

                    this._nameOwnerId = proxy.connect(
                        'notify::g-name-owner', () => this._onNameOwnerChanged());

                    this._fetchMode();
                    this._buildMenu();
                },
                null,
                Gio.DBusProxyFlags.NONE,
            );
        } catch (e) {
            log(`[AsusGpuControl] SuperGfx proxy init error: ${e.message}`);
        }
    }

    _onNameOwnerChanged() {
        if (this._proxy.g_name_owner) {
            this._switching = false;
            this._rebootTarget = null;
            this._stopPendingPoll();
            this._sessionMode = null;
            this._fetchMode();
            this._buildMenu();
        } else {
            this.subtitle = 'Unavailable';
            this._currentMode = null;
            this._sessionMode = null;
            this._rebootTarget = null;
            this._pendingMode = null;
            this._pendingAction = null;
            this._switching = false;
            this._stopPendingPoll();
        }
    }

    _fetchMode() {
        this._proxy.ModeRemote((result, error) => {
            if (error) {
                log(`[AsusGpuControl] Get GPU mode error: ${error.message}`);
                return;
            }
            this._currentMode = result[0];
            if (this._sessionMode === null)
                this._sessionMode = this._currentMode;
            this._fetchPending();
        });
    }

    _fetchPending() {
        this._proxy.PendingModeRemote((result, error) => {
            if (error) {
                log(`[AsusGpuControl] Get pending mode error: ${error.message}`);
                this._clearPending();
                return;
            }
            const pending = result[0];
            if (pending === 6 || pending === this._currentMode) {
                this._clearPending();
                return;
            }
            this._pendingMode = pending;
            this._proxy.PendingUserActionRemote((res2, err2) => {
                this._pendingAction = err2 ? null : res2[0];
                this._schedulePendingPoll();
                this._sync();
            });
        });
    }

    _clearPending() {
        this._pendingMode = null;
        this._pendingAction = null;
        this._stopPendingPoll();
        this._sync();
    }

    _schedulePendingPoll() {
        this._stopPendingPoll();
        this._pendingPollId = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, 15, () => {
                this._pendingPollId = 0;
                if (this._proxy?.g_name_owner)
                    this._fetchPending();
                return GLib.SOURCE_REMOVE;
            });
    }

    _stopPendingPoll() {
        if (this._pendingPollId) {
            GLib.source_remove(this._pendingPollId);
            this._pendingPollId = 0;
        }
    }

    _buildMenu() {
        this._section.removeAll();
        this._items = {};

        for (const id of WANTED_GFX_MODES) {
            const info = GFX_INFO[id];
            if (!info)
                continue;
            const item = new PopupMenu.PopupImageMenuItem(info.label, info.menuIcon);
            item.connect('activate', () => this._onModeSelected(id));
            this._section.addMenuItem(item);
            this._items[id] = item;
        }
        this._sync();
    }

    _onModeSelected(id) {
        if (this._switching || id === this._currentMode)
            return;

        // Cancelling back to the mode we actually booted into: just call
        // SetMode directly. The firmware is written back to the original
        // value, so no reboot/logout is needed.
        if (id === this._sessionMode && this._currentMode !== this._sessionMode) {
            this._doCancelSwitch(id);
            return;
        }

        // Close quick settings panel before opening modal dialog
        Main.panel.statusArea.quickSettings.menu.close();

        const dialog = new GpuSwitchDialog(this._currentMode, id, (systemAction) => {
            this._doSetMode(id, systemAction);
        });
        dialog.open();
    }

    _doCancelSwitch(id) {
        this._switching = true;
        this._setSensitive(false);
        this.subtitle = 'Switching\u2026';
        this.menu.setHeader('content-loading-symbolic', 'GPU Mode', 'Switching\u2026');

        this._proxy.SetModeRemote(id, (result, error) => {
            this._switching = false;
            this._rebootTarget = null;

            if (error) {
                log(`[AsusGpuControl] Cancel GPU mode error: ${error.message}`);
                Main.notify('GPU Mode', `Failed: ${error.message}`);
            }
            this._fetchMode();
        });
    }

    _doSetMode(id, systemAction) {
        this._switching = true;
        this._setSensitive(false);
        this._stopPendingPoll();
        this.subtitle = 'Switching\u2026';
        this.menu.setHeader('content-loading-symbolic', 'GPU Mode', 'Switching\u2026');

        this._proxy.SetModeRemote(id, (result, error) => {
            this._switching = false;

            if (error) {
                log(`[AsusGpuControl] Set GPU mode error: ${error.message}`);
                Main.notify('GPU Mode', `Failed: ${error.message}`);
                this._fetchMode();
                return;
            }

            const action = result[0];

            // If daemon says nothing needed (e.g. already in this mode),
            // don't trigger the system action.
            if (action === UserAction.NOTHING) {
                this._fetchMode();
                return;
            }

            if (action === UserAction.REBOOT)
                this._rebootTarget = (id === this._sessionMode) ? null : id;

            triggerSystemAction(systemAction);

            // Update state as fallback in case system action is delayed
            this._fetchMode();
        });
    }

    _setSensitive(sensitive) {
        for (const item of Object.values(this._items))
            item.setSensitive(sensitive);
    }

    _sync() {
        if (this._currentMode === null)
            return;

        if (this._switching)
            return;

        const info = GFX_INFO[this._currentMode]
            ?? {label: `Mode ${this._currentMode}`, icon: 'video-display-symbolic'};

        let subtitle = info.label;
        let headerDetail = info.label;

        const hasPending = this._pendingMode !== null
            && this._pendingMode !== this._currentMode;

        // Detect unapplied switch: either tracked by _rebootTarget (extension
        // switch) or by Mode() differing from session mode (CLI switch).
        // For MUX switches, Mode() changes immediately without rebooting.
        const needsReboot = this._rebootTarget !== null;
        const hasUnappliedSwitch = this._currentMode !== this._sessionMode
            && this._rebootTarget === null;
        if (needsReboot) {
            if (this._rebootTarget !== this._currentMode) {
                const targetInfo = GFX_INFO[this._rebootTarget]
                    ?? {label: `Mode ${this._rebootTarget}`};
                subtitle = `${info.label} \u2192 ${targetInfo.label} (reboot to apply)`;
            } else {
                subtitle = `${info.label} (reboot to apply)`;
            }
            headerDetail = subtitle;
        } else if (hasUnappliedSwitch) {
            const sessionInfo = GFX_INFO[this._sessionMode]
                ?? {label: `Mode ${this._sessionMode}`};
            subtitle = `${info.label} (switched from ${sessionInfo.label}, reboot to apply)`;
            headerDetail = subtitle;
        }

        if (hasPending) {
            const pendingInfo = GFX_INFO[this._pendingMode]
                ?? {label: `Mode ${this._pendingMode}`};
            const actionHint = ACTION_SHORT[this._pendingAction] ?? 'pending';
            subtitle = `${info.label} \u2192 ${pendingInfo.label} (${actionHint})`;
            headerDetail = subtitle;
        }

        this.subtitle = subtitle;
        this.iconName = info.icon;
        this.checked = this._currentMode === GfxMode.ASUS_MUX_DGPU;
        this.menu.setHeader(info.icon, 'GPU Mode', headerDetail);

        for (const [itemId, item] of Object.entries(this._items)) {
            const id = parseInt(itemId);
            item.setOrnament(id === this._currentMode
                ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);

            if (needsReboot || hasUnappliedSwitch)
                item.setSensitive(id === this._sessionMode);
            else if (hasPending)
                item.setSensitive(false);
            else
                item.setSensitive(true);
        }
    }

    destroy() {
        this._stopPendingPoll();
        if (this._proxy) {
            if (this._notifyGfxId) {
                this._proxy.disconnectSignal(this._notifyGfxId);
                this._notifyGfxId = 0;
            }
            if (this._nameOwnerId) {
                this._proxy.disconnect(this._nameOwnerId);
                this._nameOwnerId = 0;
            }
        }
        this._proxy = null;
        super.destroy();
    }
});

// --- System Indicator ---

const AsusIndicator = GObject.registerClass(
class AsusIndicator extends QuickSettings.SystemIndicator {
    _init() {
        super._init();

        this._gpuToggle = new GpuModeToggle();
        this.quickSettingsItems.push(this._gpuToggle);
    }

    destroy() {
        this.quickSettingsItems.forEach(item => item.destroy());
        super.destroy();
    }
});

// --- Extension entry point ---

export default class AsusTufControlExtension extends Extension {
    enable() {
        this._indicator = new AsusIndicator();
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
