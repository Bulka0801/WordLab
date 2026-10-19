// Kokoro runs off the UI thread. No local server, credentials, or Voicebox app.
export const KOKORO_MODULE = 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';
export const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
export const VOICE_ID = 'am_onyx';
export const VOICE_IDS = Object.freeze(['am_onyx', 'bm_george', 'af_heart']);

// PCM16 WAV plays on mobile browsers as well as desktop browsers.
export function pcm16Wav(samples, sampleRate) {
  if (!(samples instanceof Float32Array) || !samples.length || samples.length > 24000 * 90
      || !Number.isFinite(sampleRate) || sampleRate < 8000 || sampleRate > 48000) {
    throw new Error('Invalid generated audio');
  }
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((ch, i) => view.setUint8(offset + i, ch.charCodeAt(0)));
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true);
  text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, 'data'); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, Number.isFinite(samples[i]) ? samples[i] : 0));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return buffer;
}

// Exported injection point lets tests exercise the actual queue without a model download.
export function createOnyxWorker({ send, loadModule = () => import(KOKORO_MODULE) }) {
  let modelPromise = null, latest = null, queue = Promise.resolve(), ready = false;
  async function model(id) {
    if (!modelPromise) {
      modelPromise = (async () => {
        send({ id, type: 'loading' });
        const { KokoroTTS, env } = await loadModule();
        // Match the runtime bundled by kokoro-js 1.2.1; single-thread WASM works
        // without COOP/COEP headers, which GitHub Pages cannot configure.
        env.wasmPaths = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/';
        const tts = await KokoroTTS.from_pretrained(MODEL_ID, {
          dtype: 'q8', device: 'wasm',
          progress_callback(progress) {
            if (latest !== null && progress.status === 'progress' && String(progress.file || '').endsWith('.onnx') && Number.isFinite(progress.progress)) {
              send({ id: latest, type: 'progress', percent: Math.max(0, Math.min(100, Math.round(progress.progress))) });
            }
          },
        });
        ready = true;
        send({ type: 'ready' });
        return tts;
      })().catch(error => { modelPromise = null; ready = false; throw error; });
    }
    return modelPromise;
  }
  async function generate(id, text, voice) {
    if (id !== latest) return;
    try {
      const tts = await model(id);
      if (id !== latest) return;
      send({ id, type: 'generating' });
      const audio = await tts.generate(text, { voice, speed: 1 });
      if (id !== latest) return;
      const buffer = pcm16Wav(audio.audio, audio.sampling_rate);
      send({ id, type: 'audio', buffer }, [buffer]);
    } catch {
      if (id === latest) send({ id, type: 'error', message: 'Не вдалося запустити AI-голос у цьому браузері. Перевір інтернет і повтори спробу або обери голос пристрою.' });
    }
  }
  return message => {
    if (message?.type === 'cancel') { if (latest === message.id) latest = null; return; }
    const { id, text, voice = VOICE_ID } = message || {};
    if (!Number.isSafeInteger(id) || !VOICE_IDS.includes(voice) || typeof text !== 'string' || !text.trim() || text.length > 200) return;
    latest = id;
    send({ id, type: ready ? 'queued' : 'loading' });
    queue = queue.catch(() => {}).then(() => generate(id, text, voice));
  };
}

if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof document === 'undefined') {
  const handle = createOnyxWorker({ send: (message, transfer = []) => self.postMessage(message, transfer) });
  self.onmessage = event => handle(event.data);
}
