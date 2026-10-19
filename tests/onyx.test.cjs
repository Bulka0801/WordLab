const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.split('// BEGIN WORDLAB ONYX')[1].split('// END WORDLAB ONYX')[0];

function setup({ run, initial, playDenied = false, protocol = 'https:' } = {}) {
  const nodes = new Map(), workers = [], played = [], spoken = [], listeners = {};
  const values = new Map(initial ? [['wordlab.voicebox.v1', JSON.stringify(initial)]] : []);
  const node = id => { if (!nodes.has(id)) nodes.set(id, { textContent: '', value: '', hidden: true, classList: { toggle() {} }, setAttribute() {} }); return nodes.get(id); };
  class FakeWorker {
    constructor(url, options) { this.url = url; this.options = options; this.jobs = []; workers.push(this); }
    postMessage(message) { this.jobs.push(message); if (message.type === 'cancel') return; if (run) run(this, message); else queueMicrotask(() => { this.emit({ type: 'ready' }); this.emit({ id: message.id, type: 'audio', buffer: new ArrayBuffer(46) }); }); }
    emit(data) { this.onmessage?.({ data }); }
    terminate() { this.terminated = true; }
  }
  class FakeAudio {
    constructor(src) { this.src = src; played.push(this); }
    async play() { this.attempts = (this.attempts || 0) + 1; if (playDenied && this.attempts === 1) throw new DOMException('Tap required', 'NotAllowedError'); this.onplaying?.(); }
    pause() { this.paused = true; } load() {} removeAttribute() {}
  }
  class FakeURL extends URL {}
  FakeURL.createObjectURL = () => 'blob:audio'; FakeURL.revokeObjectURL = () => {};
  const context = vm.createContext({ console, Blob, ArrayBuffer, URL: FakeURL, Audio: FakeAudio, Worker: FakeWorker, WebAssembly, AbortController, DOMException, setTimeout, clearTimeout, Date,
    location: { protocol }, window: { addEventListener() {}, speechSynthesis: { cancel() {}, getVoices: () => [], speak: u => { spoken.push(u); u.onstart?.(); } } },
    document: { baseURI: 'https://bulka0801.github.io/WordLab/', addEventListener(type, fn) { (listeners[type] ||= []).push(fn); } },
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } }, $: node, primaryEnglish: w => w.en });
  vm.runInContext(source + '\nthis.api={speakWord,stopSpeech,clearVoiceCache,populateVoiceForm,saveVoiceSettings,voiceCacheKey,disposeOnyxWorker,get settings(){return voiceSettings},get busy(){return voiceBusy},get memory(){return voiceMemoryCache}};', context);
  context.api.populateVoiceForm();
  return { context, api: context.api, workers, played, spoken, node, listeners, values };
}

test('bootstrap loads no worker/model and migrates local Voicebox settings', () => {
  const app = setup({ initial: { provider: 'voicebox', base: 'http://127.0.0.1:17494/voicebox', profile: 'old' } });
  assert.equal(app.workers.length, 0);
  assert.equal(app.api.settings.provider, 'onyx');
  assert.equal(app.api.settings.base, undefined);
});

test('Onyx worker respects GitHub Pages subpath and cache reuses audio at slow speed', async () => {
  const app = setup();
  await app.api.speakWord({ en: 'capacity' });
  assert.equal(app.workers[0].url.href, 'https://bulka0801.github.io/WordLab/onyx-worker.mjs');
  assert.equal(app.workers[0].options.type, 'module');
  assert.equal(app.played.length, 1);
  app.played[0].onended();
  await app.api.speakWord({ en: 'capacity' }, true);
  assert.equal(app.workers[0].jobs.filter(x => x.type === 'generate').length, 1);
  assert.equal(app.played[1].playbackRate, 0.75);
  assert.equal(app.played[1].preservesPitch, true);
  app.api.stopSpeech();
});

test('late worker audio cannot play an old card, and repeated clicks do not duplicate work', async () => {
  const app = setup({ run() {} });
  const speaking = app.api.speakWord({ en: 'old' });
  while (!app.workers.length) await new Promise(resolve => setImmediate(resolve));
  await app.api.speakWord({ en: 'old' });
  assert.equal(app.workers[0].jobs.length, 1);
  const id = app.workers[0].jobs[0].id;
  app.api.stopSpeech();
  app.workers[0].emit({ id, type: 'audio', buffer: new ArrayBuffer(46) });
  await speaking;
  assert.equal(app.played.length, 0);
  assert.equal(app.api.memory.size, 0);
});

test('worker failure is recoverable and never silently changes the voice', async () => {
  const app = setup({ run(worker, message) { queueMicrotask(() => worker.emit({ id: message.id, type: 'error', message: 'Onyx unavailable' })); } });
  await app.api.speakWord({ en: 'test' });
  assert.equal(app.spoken.length, 0);
  assert.equal(app.workers[0].terminated, true);
  app.node('#voice-provider').value = 'browser';
  app.api.saveVoiceSettings();
  await app.api.speakWord({ en: 'test' });
  assert.equal(app.spoken[0].text, 'test');
  app.api.stopSpeech();
});

test('mobile autoplay rejection preserves the ready player for a direct user tap', async () => {
  const app = setup({ playDenied: true });
  await app.api.speakWord({ en: 'test' });
  assert.equal(app.node('#voice-play-ready').hidden, false);
  const button = { disabled: false, dataset: { action: 'voice-play-ready' } };
  for (const listener of app.listeners.click) listener({ target: { closest: () => button } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.played[0].attempts, 2);
  assert.equal(app.node('#voice-play-ready').hidden, true);
  assert.equal(app.played.length, 1);
  app.api.stopSpeech();
});

test('clearing audio keeps study data and forces fresh synthesis', async () => {
  const app = setup();
  app.values.set('wordlab-study-data', 'keep me');
  await app.api.speakWord({ en: 'test' });
  await app.api.clearVoiceCache();
  await app.api.speakWord({ en: 'test' });
  assert.equal(app.workers[0].jobs.filter(x => x.type === 'generate').length, 2);
  assert.equal(app.values.get('wordlab-study-data'), 'keep me');
  app.api.stopSpeech();
});

test('local files get a clear website link instruction and device voice preference survives migration', async () => {
  const local = setup({ protocol: 'file:' });
  await local.api.speakWord({ en: 'test' });
  assert.equal(local.workers.length, 0);
  assert.match(local.node('#voice-status').textContent, /GitHub Pages/);
  const app = setup({ initial: { provider: 'browser' } });
  assert.equal(app.api.settings.provider, 'browser');
});

test('full app parses and settings no longer contain a local server or profile form', () => {
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.doesNotMatch(html, /id="voice-(?:base|profile|check)"/);
  assert.doesNotMatch(html, /Start-WordLab|127\.0\.0\.1:1749/);
});
