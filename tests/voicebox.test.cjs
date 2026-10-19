const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const source = html.split('// BEGIN WORDLAB VOICEBOX')[1].split('// END WORDLAB VOICEBOX')[0];
const profile = '1a6aa532-e30a-4763-a705-5f83af26d8c7';
const generation = '22222222-2222-4222-8222-222222222222';
const metadata = { id: profile, name: 'WordLab — Onyx', language: 'en', voice_type: 'preset', preset_engine: 'kokoro', preset_voice_id: 'am_onyx' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const wav = () => new Response(new Blob(['RIFF-test-audio'], { type: 'audio/wav' }));

function setup(handler, initial) {
  const nodes = new Map(), calls = [], played = [], spoken = [], listeners = {}, values = new Map(initial ? [['wordlab.voicebox.v1', JSON.stringify(initial)]] : []);
  function node(id) { if (!nodes.has(id)) nodes.set(id, { value: '', textContent: '', hidden: false, disabled: false, classList: { toggle() {} }, setAttribute() {} }); return nodes.get(id); }
  class FakeAudio {
    constructor(src) { this.src = src; played.push(this); }
    async play() { this.onplaying?.(); }
    pause() { this.paused = true; }
    load() {}
    removeAttribute(name) { delete this[name]; }
  }
  class FakeURL extends URL {}
  let urls = 0;
  FakeURL.createObjectURL = () => 'blob:test-' + ++urls;
  FakeURL.revokeObjectURL = () => {};
  const context = vm.createContext({ console, URL: FakeURL, Audio: FakeAudio, Blob, Response, AbortController, DOMException, setTimeout, clearTimeout, Date,
    localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) },
    window: { speechSynthesis: { cancel() {}, getVoices: () => [], speak: utterance => { spoken.push(utterance); utterance.onstart?.(); } } },
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } },
    document: { addEventListener(name, fn) { (listeners[name] ||= []).push(fn); } },
    $: node, primaryEnglish: word => word.en,
    fetch: async (url, options) => { calls.push({ url, ...options }); return handler(url, options); }
  });
  vm.runInContext(source + `\nthis.api={speakWord,stopSpeech,clearVoiceCache,voiceBase,populateVoiceForm,checkVoiceConnection,saveVoiceSettings,voiceCacheKey,voiceStore,voiceDB,get settings(){return voiceSettings},get busy(){return voiceBusy},get memory(){return voiceMemoryCache},get write(){return voiceCacheWrite}};`, context);
  context.api.populateVoiceForm();
  return { context, api: context.api, calls, played, spoken, node, listeners, values };
}

test('loading WordLab never probes localhost automatically', () => {
  const app = setup(() => { throw Error('Unexpected network'); });
  assert.equal(app.calls.length, 0);
  assert.equal(app.api.settings.profile, profile);
  assert.equal(app.api.settings.provider, 'voicebox');
});

test('ready generation uses exact Onyx payload, caches audio, and reuses it for slow playback', async () => {
  const app = setup(url => url.endsWith('/generate') ? json({ id: generation, status: 'completed' }) : wav());
  await app.api.speakWord({ en: 'connectivity' });
  assert.equal(app.played.length, 1);
  const payload = JSON.parse(app.calls[0].body);
  assert.deepEqual(payload, { profile_id: profile, text: 'connectivity', language: 'en', engine: 'kokoro', personality: false, effects_chain: [], seed: 0 });
  assert.equal(app.calls[0].credentials, 'omit');
  app.played[0].onended();
  await app.api.speakWord({ en: 'connectivity' }, true);
  assert.equal(app.calls.length, 2);
  assert.equal(app.played[1].playbackRate, 0.75);
  assert.equal(app.played[1].preservesPitch, true);
  app.api.stopSpeech();
});

test('queued API is polled before requesting audio', async () => {
  const app = setup(url => url.endsWith('/generate') ? json({ id: generation, status: 'generating' }) : url.includes('/history/') ? json({ id: generation, status: 'completed' }) : wav());
  await app.api.speakWord({ en: 'reliability' });
  assert.match(app.calls[1].url, /\/history\//);
  assert.match(app.calls[2].url, /\/audio\//);
  assert.equal(app.played.length, 1);
  app.api.stopSpeech();
});

test('late response after stop cannot play or enter the cache', async () => {
  let release;
  const app = setup(url => url.endsWith('/generate') ? new Promise(resolve => { release = resolve; }) : wav());
  const speaking = app.api.speakWord({ en: 'old word' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  app.api.stopSpeech();
  release(json({ id: generation, status: 'completed' }));
  await speaking;
  assert.equal(app.played.length, 0);
  assert.equal(app.api.memory.size, 0);
  assert.equal(app.api.busy, false);
});

test('repeated clicks while a word is generating do not submit duplicate jobs', async () => {
  let release;
  const app = setup(url => url.endsWith('/generate') ? new Promise(resolve => { release = resolve; }) : wav());
  const first = app.api.speakWord({ en: 'connectivity' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await app.api.speakWord({ en: 'connectivity' });
  assert.equal(app.calls.length, 1);
  release(json({ id: generation, status: 'completed' }));
  await first;
  assert.equal(app.played.length, 1);
  app.api.stopSpeech();
});

test('a failed generation does not play or silently use browser speech', async () => {
  const app = setup(url => url.endsWith('/generate') ? json({ id: generation, status: 'failed' }) : wav());
  await app.api.speakWord({ en: 'capacity' });
  assert.equal(app.calls.length, 1);
  assert.equal(app.played.length, 0);
  assert.equal(app.spoken.length, 0);
  assert.match(app.node('#voice-status').textContent, /Не вдалося/);
});

test('network failure is actionable; browser voice is used only when selected', async () => {
  const app = setup(() => { throw new TypeError('Failed to fetch'); });
  await app.api.speakWord({ en: 'capacity' });
  assert.match(app.node('#voice-status').textContent, /Start-WordLab/);
  assert.equal(app.spoken.length, 0);
  app.node('#voice-provider').value = 'browser';
  app.api.saveVoiceSettings();
  await app.api.speakWord({ en: 'capacity' });
  assert.equal(app.spoken[0].text, 'capacity');
  assert.equal(app.calls.length, 1);
  app.api.stopSpeech();
});

test('connection check validates Onyx and can discover a recreated profile', async () => {
  const replacement = '33333333-3333-4333-8333-333333333333';
  const app = setup(() => json([{ ...metadata, id: replacement }]));
  await app.api.checkVoiceConnection();
  assert.equal(app.node('#voice-profile').value, replacement);
  assert.equal(app.api.settings.profile, profile); // Not persisted without Save.
  app.api.saveVoiceSettings();
  assert.equal(app.api.settings.profile, replacement);
});

test('malformed settings, remote URLs, credentials, queries, and non-Onyx profiles are rejected', async () => {
  const app = setup(() => json([{ ...metadata, preset_voice_id: 'bm_daniel' }]), { provider: 'voicebox', base: 'https://attacker.example', profile });
  assert.equal(app.api.settings.base, 'http://127.0.0.1:17494/voicebox');
  for (const value of ['https://localhost:17494', 'http://example.com', 'http://127.0.0.1.evil.test', 'http://x:y@localhost:17494', 'http://localhost:17494/?x=1', 'http://localhost:17494/private']) assert.throws(() => app.api.voiceBase(value));
  await app.api.checkVoiceConnection();
  assert.match(app.node('#voice-status').textContent, /не знайдено/);
});

test('cache keys separate profiles and exact text; clearing cache causes a new generation', async () => {
  const app = setup(url => url.endsWith('/generate') ? json({ id: generation }) : wav());
  const a = app.api.voiceCacheKey(app.api.settings, 'backup');
  assert.notEqual(a, app.api.voiceCacheKey({ ...app.api.settings, profile: generation }, 'backup'));
  assert.notEqual(a, app.api.voiceCacheKey(app.api.settings, 'Backup'));
  await app.api.speakWord({ en: 'backup' });
  await app.api.clearVoiceCache();
  await app.api.speakWord({ en: 'backup' });
  assert.equal(app.calls.filter(c => c.method === 'POST').length, 2);
  app.api.stopSpeech();
});

test('non-audio and invalid generation IDs never play', async () => {
  for (const result of [{ id: '<script>' }, { id: generation }]) {
    const app = setup(url => url.endsWith('/generate') ? json(result) : json({ error: 'not audio' }));
    await app.api.speakWord({ en: 'capacity' });
    assert.equal(app.played.length, 0);
  }
});

test('full inline script parses and speech UI is outside the changing workspace', () => {
  new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1]);
  assert.ok(html.indexOf('id="voice-controls"') < html.indexOf('id="workspace"'));
  assert.match(html, /function turnCard[\s\S]*?stopSpeech\(\)/);
});

module.exports = { setup, json, wav, profile, generation };
