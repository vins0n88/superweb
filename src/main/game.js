// H5 game mode: full-window play with the browser chrome hidden (Esc exits), a
// phone layout for mobile-first H5 games (device size, touch input, mobile user
// agent, letterboxed and scaled to the window), and per-tab mute.

export const DEVICES = {
  portrait: { width: 390, height: 844 },
  landscape: { width: 844, height: 390 },
};
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

/** Fits a device screen into the available area: centered, scaled down (never up). */
export function fitDevice(area, device) {
  const scale = Math.min(1, area.width / device.width, area.height / device.height);
  const width = Math.round(device.width * scale);
  const height = Math.round(device.height * scale);
  return {
    bounds: { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height },
    scale,
  };
}

/**
 * @param {object} deps
 * @param {() => object} deps.getTabs
 * @param {() => import('electron').BrowserWindow|null} deps.getWin
 * @param {(channel: string, payload: unknown) => void} deps.send
 */
export function createGameMode({ getTabs, getWin, send }) {
  const state = new Map(); // tabId → { fullscreen, device, muted }
  const get = (id) => state.get(id) ?? { fullscreen: false, device: 'off', muted: false };
  const publish = () => send('game:changed', Object.fromEntries(state));

  function applyDevice(tab, device) {
    const wc = tab.view.webContents;
    if (device === 'off') {
      tab.fit = null;
      wc.disableDeviceEmulation();
      wc.setUserAgent(tab.defaultUA ?? wc.getUserAgent());
      if (wc.debugger.isAttached()) wc.debugger.detach();
    } else {
      const size = DEVICES[device];
      tab.defaultUA ??= wc.getUserAgent();
      tab.fit = (area) => {
        const { bounds, scale } = fitDevice(area, size);
        wc.enableDeviceEmulation({ screenPosition: 'mobile', screenSize: size, viewPosition: { x: 0, y: 0 }, viewSize: size, deviceScaleFactor: 0, scale });
        return bounds;
      };
      wc.setUserAgent(MOBILE_UA);
      try {
        if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
        wc.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
        wc.debugger.sendCommand('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
      } catch {
        // DevTools open on this tab: layout and user agent still apply, touch emulation does not
      }
    }
    getTabs().layout();
    wc.reload(); // the page re-detects mobile vs desktop on load
  }

  function setFullscreen(tab, on) {
    const win = getWin();
    if (win) win.setFullScreen(on);
    if (on && !tab.gameKeys) {
      // Esc leaves game mode even while the game has keyboard focus.
      tab.gameKeys = (e, input) => {
        if (input.type === 'keyDown' && input.key === 'Escape' && get(tab.id).fullscreen) {
          e.preventDefault();
          update(tab.id, { fullscreen: false });
        }
      };
      tab.view.webContents.on('before-input-event', tab.gameKeys);
    }
  }

  function update(tabId, patch) {
    const tab = getTabs().get(tabId);
    if (!tab || tab.app) return get(tabId);
    const prev = get(tabId);
    const next = { ...prev, ...patch };
    if (patch.device && !DEVICES[patch.device] && patch.device !== 'off') throw new Error('unknown device layout');
    if (next.device !== prev.device) applyDevice(tab, next.device);
    if (next.fullscreen !== prev.fullscreen) setFullscreen(tab, next.fullscreen);
    if (next.muted !== prev.muted) tab.view.webContents.setAudioMuted(next.muted);
    tab.view.webContents.setBackgroundThrottling(!(next.fullscreen || next.device !== 'off')); // games keep full speed
    if (!next.fullscreen && next.device === 'off' && !next.muted) state.delete(tabId);
    else state.set(tabId, next);
    publish();
    return next;
  }

  return {
    get,
    update,
    state: () => Object.fromEntries(state),
    /** Native menu for the 🎮 button. */
    menuTemplate(tabId) {
      const s = get(tabId);
      return [
        { label: s.fullscreen ? '退出遊戲全螢幕（Esc）' : '遊戲全螢幕', click: () => update(tabId, { fullscreen: !s.fullscreen }) },
        { type: 'separator' },
        { label: '電腦版面', type: 'radio', checked: s.device === 'off', click: () => update(tabId, { device: 'off' }) },
        { label: '手機版面（直向）', type: 'radio', checked: s.device === 'portrait', click: () => update(tabId, { device: 'portrait' }) },
        { label: '手機版面（橫向）', type: 'radio', checked: s.device === 'landscape', click: () => update(tabId, { device: 'landscape' }) },
        { type: 'separator' },
        { label: '這個分頁靜音', type: 'checkbox', checked: s.muted, click: () => update(tabId, { muted: !s.muted }) },
      ];
    },
  };
}
