/**
 * Matematica pura do medidor de voz. Sem DOM, sem WebAudio — testavel isolado.
 * O pipeline e: amostras no dominio do tempo -> RMS -> dBFS -> nivel 0..1 suavizado.
 */

export const SPEAKING_DBFS = -50; // limiar de fala, calibrado para ruido de sala
export const FLOOR_DBFS = -65; // abaixo disso o halo fica no tamanho minimo
export const CEILING_DBFS = -12; // acima disso o halo satura

/**
 * RMS de um buffer de dominio do tempo do AnalyserNode (getByteTimeDomainData,
 * onde 128 e o silencio).
 * @param {Uint8Array} samples
 * @returns {number} 0..1
 */
export function rmsFromTimeDomain(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const centered = (samples[i] - 128) / 128;
    sum += centered * centered;
  }
  return Math.sqrt(sum / samples.length);
}

/** @param {number} rms 0..1 @returns {number} dBFS (-Infinity no silencio absoluto) */
export function toDbfs(rms) {
  if (rms <= 0) return -Infinity;
  return 20 * Math.log10(rms);
}

/**
 * Mapeia dBFS para 0..1 usando a faixa util da voz humana em chamada.
 * @param {number} dbfs
 * @returns {number} 0..1
 */
export function normalizeLevel(dbfs, floor = FLOOR_DBFS, ceiling = CEILING_DBFS) {
  if (!Number.isFinite(dbfs)) return 0;
  const clamped = Math.min(Math.max(dbfs, floor), ceiling);
  return (clamped - floor) / (ceiling - floor);
}

/** Atalho: buffer bruto -> nivel 0..1 + dBFS. */
export function measure(samples) {
  const rms = rmsFromTimeDomain(samples);
  const dbfs = toDbfs(rms);
  return { rms, dbfs, level: normalizeLevel(dbfs) };
}

/**
 * Suavizador com ataque rapido / liberacao lenta e hangover.
 *
 * O hangover impede que o halo pisque entre silabas: uma vez detectada fala,
 * o estado "falando" so cai depois de `hangoverMs` continuos abaixo do limiar.
 */
export function createLevelSmoother({
  attack = 0.55,
  release = 0.12,
  hangoverMs = 500,
  speakingDbfs = SPEAKING_DBFS,
} = {}) {
  let level = 0;
  let speaking = false;
  let lastLoudAt = -Infinity;

  return {
    /**
     * @param {{dbfs:number, level:number}} sample
     * @param {number} now timestamp em ms
     */
    push(sample, now) {
      const target = sample.level;
      const coef = target > level ? attack : release;
      level += (target - level) * coef;
      if (level < 0.001) level = 0;

      if (sample.dbfs >= speakingDbfs) lastLoudAt = now;
      speaking = now - lastLoudAt <= hangoverMs;

      // Fora do estado "falando" o nivel nao e zerado na marra: ele decai pela
      // constante de release, senao o halo sumiria com um corte seco.
      return { level, speaking };
    },
    get state() {
      return { level, speaking };
    },
    reset() {
      level = 0;
      speaking = false;
      lastLoudAt = -Infinity;
    },
  };
}
