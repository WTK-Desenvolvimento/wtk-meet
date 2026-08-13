/**
 * Detecção de "quem está falando", 100% local.
 *
 * Política deliberada: **nenhum nível de áudio trafega pela rede**. Cada
 * participante analisa localmente o próprio stream e os streams remotos que já
 * está recebendo de qualquer forma (via WebRTC), com `AudioContext` +
 * `AnalyserNode`. Não há mensagem de "estou falando" no servidor de sinalização
 * nem no data channel — indicador de fala é derivado, não transmitido.
 *
 * Custo controlado: **um** `AudioContext` para a sala inteira e **um** loop
 * `requestAnimationFrame` que percorre todos os analisadores, em vez de um
 * timer por tile.
 */

/** RMS acima disto = falando. Abaixo de OFF, começa a contar o silêncio. */
const SPEAKING_ON = 0.035;
const SPEAKING_OFF = 0.022;

/**
 * Histerese: o indicador acende no primeiro frame acima do limiar (<200ms, na
 * prática ~16ms a 60fps) e só apaga após meio segundo contínuo de silêncio, para
 * não piscar nas pausas naturais entre palavras.
 */
const RELEASE_MS = 500;

/** Quantização do nível: evita re-render do React a cada frame. */
const LEVEL_STEP = 0.05;
const MIN_EMIT_INTERVAL_MS = 50;

/** Ganho aplicado ao RMS para levar fala normal perto de 1.0 na UI. */
const LEVEL_GAIN = 6;

/**
 * RMS do buffer de domínio do tempo. Compartilhado entre o loop do monitor da
 * sala e o medidor isolado do preview: duas cópias divergiriam, e o medidor do
 * modal deixaria de dizer a mesma coisa que o anel de fala.
 */
function rmsOf(buffer) {
  let sum = 0;
  for (let i = 0; i < buffer.length; i += 1) {
    sum += buffer[i] * buffer[i];
  }
  return Math.sqrt(sum / buffer.length);
}

const levelFromRms = (rms) => Math.min(1, rms * LEVEL_GAIN);

/** Quantização do nível emitido — a mesma nos dois caminhos. */
const quantizeLevel = (level) => Math.round(level / LEVEL_STEP) * LEVEL_STEP;

/**
 * Medidor isolado, para o preview do modal de configurações.
 *
 * Deliberadamente **fora** do registro do `AudioLevelMonitor` da sala: o `Room`
 * roda `monitor.retainOnly(...)` a cada mudança em `participants`, então um
 * `attach('preview', …)` seria detachado na próxima entrada ou saída de alguém —
 * o medidor morreria no meio do uso, por um evento de rede, sem erro nenhum.
 *
 * Recebe o `context` de fora quando já existe um na página (dentro da sala), o
 * que preserva a invariante de **um `AudioContext` por aba**. Sem contexto
 * injetado (Home), cria o próprio e o fecha no `stop()`.
 */
export function createLevelMeter({ stream, context = null, onLevel } = {}) {
  const noop = { stop() {} };
  if (!stream || stream.getAudioTracks().length === 0) return noop;

  let ctx = context;
  let ownsContext = false;
  if (!ctx) {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return noop;
    ctx = new Ctor();
    ownsContext = true;
  }
  if (ctx.state === 'suspended') {
    ctx.resume().catch(() => {
      // sem gesto do usuário ainda — o medidor fica em zero, sem quebrar nada
    });
  }

  let source;
  try {
    source = ctx.createMediaStreamSource(stream);
  } catch {
    if (ownsContext) ctx.close().catch(() => {});
    return noop;
  }

  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.2;
  source.connect(analyser);
  // Ramo sem saída: nada aqui é conectado ao `destination`, então o preview não
  // devolve o próprio microfone pelos alto-falantes.

  const buffer = new Float32Array(analyser.fftSize);
  let rafId = null;
  let stopped = false;
  let lastEmitted = -1;
  let lastEmitAt = 0;

  const tick = () => {
    rafId = null;
    if (stopped) return;
    analyser.getFloatTimeDomainData(buffer);
    const level = quantizeLevel(levelFromRms(rmsOf(buffer)));
    const now = performance.now();
    if (level !== lastEmitted && now - lastEmitAt >= MIN_EMIT_INTERVAL_MS) {
      lastEmitted = level;
      lastEmitAt = now;
      onLevel?.(level);
    }
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (rafId != null) cancelAnimationFrame(rafId);
      rafId = null;
      try {
        source.disconnect();
        analyser.disconnect();
      } catch {
        // já desconectado
      }
      if (ownsContext) {
        ctx.close().catch(() => {
          // já fechado
        });
      }
    },
  };
}

export class AudioLevelMonitor {
  constructor({ onUpdate } = {}) {
    this.onUpdate = onUpdate;
    this.ctx = null;
    this.sources = new Map(); // id -> { source, analyser, buffer, speaking, lastLoudAt, level }
    this.rafId = null;
    this.lastEmitAt = 0;
    this.lastEmitted = new Map(); // id -> { level, speaking }
    this.closed = false;
    this._tick = this._tick.bind(this);
  }

  /**
   * O AudioContext nasce suspenso até um gesto do usuário (política de
   * autoplay). Chamar depois de um clique — ou deixar `resumeOnGesture` cuidar.
   */
  ensureContext() {
    if (this.closed) return null;
    if (!this.ctx) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {
        // sem gesto ainda — tentará de novo no próximo attach/gesto
      });
    }
    return this.ctx;
  }

  /** Retenta o resume no primeiro gesto do usuário. Devolve um desregistrador. */
  resumeOnGesture() {
    const handler = () => {
      this.ensureContext();
    };
    for (const evt of ['click', 'keydown', 'touchstart']) {
      window.addEventListener(evt, handler, { passive: true });
    }
    return () => {
      for (const evt of ['click', 'keydown', 'touchstart']) {
        window.removeEventListener(evt, handler);
      }
    };
  }

  /**
   * Passa a monitorar `stream` sob a chave `id`. Idempotente por (id, stream):
   * chamar de novo com o mesmo stream não recria nada.
   */
  attach(id, stream) {
    if (this.closed || !stream) return;
    if (stream.getAudioTracks().length === 0) return;

    const existing = this.sources.get(id);
    if (existing?.stream === stream) return;
    if (existing) this.detach(id);

    const ctx = this.ensureContext();
    if (!ctx) return;

    let source;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch {
      // Stream sem track de áudio utilizável — nada a monitorar.
      return;
    }

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    // O analyser é um ramo sem saída: não conectamos ao `destination`, então
    // nada aqui produz som (evita eco do próprio microfone).

    this.sources.set(id, {
      stream,
      source,
      analyser,
      buffer: new Float32Array(analyser.fftSize),
      speaking: false,
      lastLoudAt: 0,
      level: 0,
    });

    this._start();
  }

  detach(id) {
    const entry = this.sources.get(id);
    if (!entry) return;
    try {
      entry.source.disconnect();
      entry.analyser.disconnect();
    } catch {
      // já desconectado
    }
    this.sources.delete(id);
    this.lastEmitted.delete(id);
    if (this.sources.size === 0) this._stop();
  }

  /** Remove tudo que não esteja em `validIds` (peers que saíram da sala). */
  retainOnly(validIds) {
    for (const id of [...this.sources.keys()]) {
      if (!validIds.has(id)) this.detach(id);
    }
  }

  _start() {
    if (this.rafId == null && !this.closed) {
      this.rafId = requestAnimationFrame(this._tick);
    }
  }

  _stop() {
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  _tick() {
    this.rafId = null;
    if (this.closed) return;

    const now = performance.now();
    let dirty = false;

    for (const [id, entry] of this.sources) {
      entry.analyser.getFloatTimeDomainData(entry.buffer);

      const rms = rmsOf(entry.buffer);

      if (rms >= SPEAKING_ON) {
        entry.speaking = true;
        entry.lastLoudAt = now;
      } else if (entry.speaking) {
        if (rms >= SPEAKING_OFF) {
          entry.lastLoudAt = now; // zona morta: sustenta sem re-disparar
        } else if (now - entry.lastLoudAt >= RELEASE_MS) {
          entry.speaking = false;
        }
      }

      entry.level = levelFromRms(rms);

      const quantized = Math.round(entry.level / LEVEL_STEP) * LEVEL_STEP;
      const previous = this.lastEmitted.get(id);
      if (!previous || previous.speaking !== entry.speaking || previous.level !== quantized) {
        dirty = true;
      }
    }

    if (dirty && now - this.lastEmitAt >= MIN_EMIT_INTERVAL_MS) {
      this.lastEmitAt = now;
      const snapshot = {};
      this.lastEmitted.clear();
      for (const [id, entry] of this.sources) {
        const quantized = Math.round(entry.level / LEVEL_STEP) * LEVEL_STEP;
        snapshot[id] = { level: quantized, speaking: entry.speaking };
        this.lastEmitted.set(id, { level: quantized, speaking: entry.speaking });
      }
      this.onUpdate?.(snapshot);
    }

    if (this.sources.size > 0) this._start();
  }

  /**
   * Bipe curto e discreto para avisos de entrada/saída. Reaproveita o mesmo
   * AudioContext — nenhum <audio> nem arquivo de mídia envolvido.
   */
  playBeep({ frequency = 660, duration = 0.12, volume = 0.05 } = {}) {
    const ctx = this.ensureContext();
    if (!ctx || ctx.state !== 'running') return;

    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, now);
    // Envelope suave: um ganho quadrado estala e chama mais atenção que o aviso.
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + duration + 0.02);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  close() {
    this.closed = true;
    this._stop();
    for (const id of [...this.sources.keys()]) {
      this.detach(id);
    }
    if (this.ctx) {
      this.ctx.close().catch(() => {
        // já fechado
      });
      this.ctx = null;
    }
  }
}
