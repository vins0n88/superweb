import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fitDevice, createGameMode, DEVICES } from '../src/main/game.js';

test('phone layout is centered and scaled down to fit, never up', () => {
  assert.deepEqual(fitDevice({ x: 0, y: 80, width: 1200, height: 700 }, DEVICES.portrait), { bounds: { x: 439, y: 80, width: 323, height: 700 }, scale: 700 / 844 });
  const big = fitDevice({ x: 10, y: 10, width: 2000, height: 1200 }, DEVICES.landscape);
  assert.equal(big.scale, 1);
  assert.deepEqual(big.bounds, { x: 588, y: 415, width: 844, height: 390 });
});

function fakeTab(id, { app = '' } = {}) {
  const calls = [];
  const listeners = {};
  const wc = {
    calls,
    attached: false,
    enableDeviceEmulation: (p) => calls.push(['emulate', p.screenSize.width, p.scale]),
    disableDeviceEmulation: () => calls.push(['emulate-off']),
    getUserAgent: () => 'Desktop UA',
    setUserAgent: (ua) => calls.push(['ua', ua.includes('iPhone') ? 'mobile' : ua]),
    setAudioMuted: (m) => calls.push(['muted', m]),
    setBackgroundThrottling: (b) => calls.push(['throttle', b]),
    reload: () => calls.push(['reload']),
    on: (ev, fn) => { listeners[ev] = fn; },
    debugger: {
      isAttached: () => wc.attached,
      attach: () => { wc.attached = true; },
      detach: () => { wc.attached = false; },
      sendCommand: (cmd) => calls.push(['cdp', cmd]),
    },
  };
  return { id, app, view: { webContents: wc }, listeners };
}

test('game mode: fullscreen hides chrome until Esc; phone layout emulates and restores; mute', () => {
  const tab = fakeTab(3);
  const tabs = { get: (id) => (id === 3 ? tab : null), layoutCalls: 0, layout() { this.layoutCalls++; } };
  const win = { fs: false, setFullScreen(v) { this.fs = v; } };
  const sent = [];
  const g = createGameMode({ getTabs: () => tabs, getWin: () => win, send: (c, p) => sent.push([c, p]) });

  g.update(3, { fullscreen: true });
  assert.equal(win.fs, true);
  assert.deepEqual(sent.at(-1), ['game:changed', { 3: { fullscreen: true, device: 'off', muted: false } }]);
  let prevented = false;
  tab.listeners['before-input-event']({ preventDefault: () => { prevented = true; } }, { type: 'keyDown', key: 'Escape' });
  assert.equal(prevented, true);
  assert.equal(win.fs, false);
  assert.deepEqual(g.state(), {}, 'nothing left on: the tab is back to normal');

  g.update(3, { device: 'portrait' });
  const wc = tab.view.webContents;
  assert.deepEqual(wc.calls.filter((c) => c[0] === 'ua' || c[0] === 'cdp' || c[0] === 'reload').map((c) => c.join(':')), ['ua:mobile', 'cdp:Emulation.setTouchEmulationEnabled', 'cdp:Emulation.setEmitTouchEventsForMouse', 'reload']);
  assert.deepEqual(tab.fit({ x: 0, y: 0, width: 800, height: 422 }), { x: 303, y: 0, width: 195, height: 422 });
  assert.deepEqual(wc.calls.find((c) => c[0] === 'emulate').slice(0, 2), ['emulate', 390]);
  assert.ok(wc.calls.some((c) => c[0] === 'throttle' && c[1] === false), 'games keep full speed in the background');
  g.update(3, { device: 'off', muted: true });
  assert.equal(tab.fit, null);
  assert.equal(wc.attached, false);
  assert.ok(wc.calls.some((c) => c.join(':') === 'ua:Desktop UA'));
  assert.ok(wc.calls.some((c) => c.join(':') === 'muted:true'));
  assert.throws(() => g.update(3, { device: 'tablet' }), /unknown device/);
  assert.equal(g.menuTemplate(3).find((i) => i.label === '這個分頁靜音').checked, true);
});

test('game mode never applies to built-in app tabs', () => {
  const tab = fakeTab(5, { app: 'wallet' });
  const g = createGameMode({ getTabs: () => ({ get: () => tab, layout() {} }), getWin: () => null, send: () => {} });
  g.update(5, { fullscreen: true });
  assert.deepEqual(g.state(), {});
});
