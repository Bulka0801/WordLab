import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcm16Wav, createOnyxWorker, MODEL_ID, VOICE_ID, KOKORO_MODULE } from '../onyx-worker.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

test('mobile-compatible PCM16 WAV has correct headers and clipped samples', () => {
  const buffer = pcm16Wav(new Float32Array([-2, -0.5, 0, 0.5, 2, NaN]), 24000);
  const view = new DataView(buffer);
  assert.equal(new TextDecoder().decode(buffer.slice(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(buffer.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(24, true), 24000);
  assert.equal(view.getInt16(44, true), -32768);
  assert.equal(view.getInt16(52, true), 32767);
  assert.equal(view.getInt16(54, true), 0);
  assert.throws(() => pcm16Wav(new Float32Array(), 24000));
});

test('actual worker loads one q8 WASM model, generates Onyx and transfers PCM audio', async () => {
  const messages = [], loads = [], spoken = [];
  const env = {};
  const handle = createOnyxWorker({ send: (message, transfer) => messages.push({ ...message, transfer }), loadModule: async () => ({ env, KokoroTTS: { async from_pretrained(model, options) { loads.push({ model, options }); options.progress_callback({ status: 'progress', progress: 42 }); return { async generate(text, settings) { spoken.push({ text, settings }); return { audio: new Float32Array([0, 0.5]), sampling_rate: 24000 }; } }; } } }) });
  handle({ id: 1, text: 'capacity' });
  await tick();
  handle({ id: 2, text: 'reliability' });
  await tick();
  assert.equal(loads.length, 1);
  assert.equal(loads[0].model, MODEL_ID);
  assert.equal(loads[0].options.dtype, 'q8');
  assert.equal(loads[0].options.device, 'wasm');
  assert.equal(spoken[0].settings.voice, VOICE_ID);
  assert.equal(VOICE_ID, 'am_onyx');
  assert.match(KOKORO_MODULE, /kokoro-js@1\.2\.1/);
  assert.match(env.wasmPaths, /transformers@3\.5\.1/);
  const audio = messages.find(x => x.type === 'audio');
  assert.equal(audio.transfer[0], audio.buffer);
  assert.equal(new DataView(audio.buffer).getUint16(20, true), 1);
});

test('cancelled or replaced jobs never emit old audio; model survives navigation', async () => {
  let resolveModel;
  const messages = [], spoken = [];
  const handle = createOnyxWorker({ send: m => messages.push(m), loadModule: async () => ({ env: {}, KokoroTTS: { from_pretrained: () => new Promise(resolve => { resolveModel = resolve; }) } }) });
  handle({ id: 1, text: 'old' });
  await tick();
  handle({ type: 'cancel', id: 1 });
  handle({ id: 2, text: 'new' });
  resolveModel({ async generate(text) { spoken.push(text); return { audio: new Float32Array([0]), sampling_rate: 24000 }; } });
  await tick();
  assert.deepEqual(spoken, ['new']);
  assert.deepEqual(messages.filter(x => x.type === 'audio').map(x => x.id), [2]);
});

test('load failure can be retried and malformed jobs cannot start a download', async () => {
  let attempts = 0;
  const messages = [];
  const handle = createOnyxWorker({ send: m => messages.push(m), loadModule: async () => { attempts++; throw Error('offline'); } });
  handle({ id: 1, text: '' });
  handle({ id: 1, text: 'x'.repeat(201) });
  handle({ id: 'invalid', text: 'test' });
  await tick();
  assert.equal(attempts, 0);
  handle({ id: 2, text: 'test' });
  await tick();
  handle({ id: 3, text: 'retry' });
  await tick();
  assert.equal(attempts, 2);
  assert.equal(messages.filter(x => x.type === 'error').length, 2);
});

test('all three favorite voices use their actual IDs with one shared model', async () => {
  let loads = 0;
  const voices = [], messages = [];
  const handle = createOnyxWorker({ send: m => messages.push(m), loadModule: async () => ({ env: {}, KokoroTTS: { async from_pretrained() { loads++; return { async generate(text, { voice }) { voices.push(voice); return { audio: new Float32Array([0]), sampling_rate: 24000 }; } }; } } }) });
  handle({ id: 0, text: 'test', voice: 'unknown' });
  await tick();
  assert.equal(loads, 0);
  for (const [index, voice] of ['am_onyx', 'bm_george', 'af_heart'].entries()) {
    handle({ id: index + 1, text: 'test', voice });
    await tick();
  }
  assert.equal(loads, 1);
  assert.deepEqual(voices, ['am_onyx', 'bm_george', 'af_heart']);
  assert.equal(messages.filter(m => m.type === 'audio').length, 3);
});
