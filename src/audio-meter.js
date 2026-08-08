import { measure, createLevelSmoother } from './lib/level.js';

/**
 * Medidor de nivel de voz de todos os participantes.
 *
 * Duas exigencias que moldam o desenho:
 *  1. ~60 fps sem travar a UI  -> loop em requestAnimationFrame, e o resultado
 *     e escrito direto numa custom property CSS (nenhum re-render de app).
 *  2. CPU zero em silencio     -> quando ninguem fala, o rAF e DESLIGADO e
 *     entra uma sondagem barata a cada 250 ms. Um analyser de 512 amostras
 *     rodando 4x/s e ruido estatistico no perfil de CPU; a 60 fps, nao e.
 *
 * Pegadinha do Chrome ja considerada: um AnalyserNode alimentado por stream
 * REMOTO so produz dados se o mesmo stream estiver anexado a um elemento de
 * midia vivo no DOM. Os tiles fazem isso.
 */

const IDLE_POLL_MS = 250;
const WAKE_LEVEL = 0.02;

export function createAudioMeter({ onUpdate }) {
  /** @type {AudioContext|null} */
  let ctx = null;
  /** @type {Map<string, object>} */
  const inputs = new Map();
  let rafId = null;
  let idleId = null;
  let mode = 'stopped'; // 'stopped' | 'active' | 'idle'

  function ensureContext() {
    if (!ctx) ctx = new (window.AudioContext ?? window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function add(id, stream) {
    if (!stream || stream.getAudioTracks().length === 0) return;
    remove(id);
    const context = ensureContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.8;
    source.connect(analyser);
    // Nao conectamos ao destino: o audio ja sai pelo elemento <video> do tile.
    inputs.set(id, {
      source,
      analyser,
      buffer: new Uint8Array(analyser.fftSize),
      smoother: createLevelSmoother(),
    });
    schedule();
  }

  function remove(id) {
    const input = inputs.get(id);
    if (!input) return;
    input.source.disconnect();
    inputs.delete(id);
    if (inputs.size === 0) stop();
  }

  /** Uma passada por todos os analisadores. @returns {boolean} alguem falando */
  function sample(now) {
    let active = false;
    const results = new Map();
    for (const [id, input] of inputs) {
      input.analyser.getByteTimeDomainData(input.buffer);
      const state = input.smoother.push(measure(input.buffer), now);
      results.set(id, state);
      if (state.speaking || state.level > WAKE_LEVEL) active = true;
    }
    onUpdate(results);
    return active;
  }

  function loop() {
    const active = sample(performance.now());
    if (active) {
      rafId = requestAnimationFrame(loop);
    } else {
      rafId = null;
      goIdle();
    }
  }

  function goIdle() {
    if (mode === 'stopped' || inputs.size === 0) return;
    mode = 'idle';
    clearTimeout(idleId);
    idleId = setTimeout(function poll() {
      if (mode !== 'idle') return;
      if (sample(performance.now())) {
        goActive();
      } else {
        idleId = setTimeout(poll, IDLE_POLL_MS);
      }
    }, IDLE_POLL_MS);
  }

  function goActive() {
    if (mode === 'active' || inputs.size === 0) return;
    mode = 'active';
    clearTimeout(idleId);
    idleId = null;
    if (rafId === null) rafId = requestAnimationFrame(loop);
  }

  /** Comeca no modo ocioso: sem fala, sem rAF. */
  function schedule() {
    if (mode === 'stopped') {
      mode = 'idle';
      goIdle();
    }
  }

  function stop() {
    mode = 'stopped';
    if (rafId !== null) cancelAnimationFrame(rafId);
    clearTimeout(idleId);
    rafId = null;
    idleId = null;
  }

  function destroy() {
    stop();
    for (const id of [...inputs.keys()]) remove(id);
    ctx?.close().catch(() => {});
    ctx = null;
  }

  return {
    add,
    remove,
    destroy,
    /** Exposto para os testes de fumaça e para o painel de diagnostico. */
    get mode() {
      return mode;
    },
    get size() {
      return inputs.size;
    },
  };
}
