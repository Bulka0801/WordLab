const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const bootstrap = html.match(/<script id="theme-bootstrap">([\s\S]*?)<\/script>/)[1];
const source = html.split('// BEGIN WORDLAB THEME')[1].split('// END WORDLAB THEME')[0];

function setup({ saved, dark = false, blocked = false } = {}) {
  const values = new Map([['study-data', 'untouched']]);
  if (saved !== undefined) values.set('wordlab.theme.v1', saved);
  const listeners = {}, mediaListeners = [], root = { dataset: {} }, picker = { value: '' }, meta = { setAttribute(key, value) { this[key] = value; } };
  const media = { matches: dark, addEventListener(type, listener) { mediaListeners.push(listener); } };
  const context = vm.createContext({ document: { documentElement: root, querySelector: selector => selector === '#theme-select' ? picker : meta, addEventListener(type, listener) { (listeners[type] ||= []).push(listener); } },
    window: { matchMedia: () => media, addEventListener(type, listener) { (listeners[type] ||= []).push(listener); } },
    localStorage: { getItem(key) { if (blocked) throw Error('blocked'); return values.get(key) ?? null; }, setItem(key, value) { if (blocked) throw Error('blocked'); values.set(key, value); } } });
  vm.runInContext(bootstrap, context);
  const initial = root.dataset.theme;
  vm.runInContext(source, context);
  return { context, initial, values, listeners, mediaListeners, root, picker, meta, media };
}

test('before-paint theme matches the application for system, explicit, invalid and blocked preferences', () => {
  for (const input of [{ dark: true }, { dark: false }, { saved: 'dark' }, { saved: 'light', dark: true }, { saved: 'invalid', dark: true }, { blocked: true, dark: true }]) {
    const app = setup(input);
    assert.equal(app.initial, app.root.dataset.theme);
    assert.equal(app.root.dataset.theme, input.saved === 'light' ? 'light' : input.saved === 'dark' || input.dark ? 'dark' : 'light');
  }
  assert.ok(html.indexOf('id="theme-bootstrap"') < html.indexOf('<style>'));
});

test('manual theme persists, updates browser chrome, and never changes study data', () => {
  const app = setup();
  for (const listener of app.listeners.change) listener({ target: { id: 'theme-select', value: 'dark' } });
  assert.equal(app.root.dataset.theme, 'dark');
  assert.equal(app.values.get('wordlab.theme.v1'), 'dark');
  assert.equal(app.meta.content, '#151119');
  assert.equal(app.values.get('study-data'), 'untouched');
  assert.equal(app.picker.value, 'dark');
});

test('system changes are followed only in System mode, including after switching back', () => {
  const app = setup();
  app.media.matches = true; app.mediaListeners[0]();
  assert.equal(app.root.dataset.theme, 'dark');
  vm.runInContext("applyTheme('light', true)", app.context);
  app.mediaListeners[0]();
  assert.equal(app.root.dataset.theme, 'light');
  vm.runInContext("applyTheme('system', true)", app.context);
  assert.equal(app.root.dataset.theme, 'dark');
});

test('cross-tab updates and storage clearing sync without writing a feedback loop', () => {
  const app = setup({ saved: 'light', dark: true });
  app.listeners.storage[0]({ key: 'wordlab.theme.v1', newValue: 'dark' });
  assert.equal(app.root.dataset.theme, 'dark');
  assert.equal(app.values.get('wordlab.theme.v1'), 'light');
  app.listeners.storage[0]({ key: null, newValue: null });
  assert.equal(app.root.dataset.themePreference, 'system');
  assert.equal(app.picker.value, 'system');
});

test('dark text and semantic colors have readable contrast on all base surfaces', () => {
  const tokens = Object.fromEntries([...html.match(/:root\[data-theme=dark\]\{([^}]+)/)[1].matchAll(/--([\w-]+):(#[\da-f]{6})/gi)].map(m => [m[1], m[2]]));
  const luminance = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(x => x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4).reduce((sum, x, i) => sum + x * [0.2126, 0.7152, 0.0722][i], 0);
  for (const fg of ['ink', 'muted', 'blue', 'green', 'red']) for (const bg of ['bg', 'white', 'pale']) {
    const [low, high] = [luminance(tokens[fg]), luminance(tokens[bg])].sort((a, b) => a - b);
    assert.ok((high + 0.05) / (low + 0.05) >= 4.5, fg + ' on ' + bg);
  }
});
