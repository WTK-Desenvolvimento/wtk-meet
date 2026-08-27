/**
 * Supressão de ruído: preferência, matriz de decisão de modo, constraints e o
 * DSP do worklet.
 *
 * O DSP é a única parte desta entrega cuja correção **não é observável a olho
 * nu**: errar um índice de FFT não lança exceção, produz voz metálica; um
 * overlap-add mal normalizado não dá erro, dá ganho errado; um piso de ruído
 * que sobe rápido demais não avisa nada, apenas suprime quem fala. Por isso os
 * números aqui são medidos (dB de atenuação, erro máximo por amostra), e não
 * inspeções de estrutura.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIO_STORAGE_KEY,
  DEFAULT_AUDIO_PREFERENCES,
  MODE,
  PROCESSOR_NAME,
  decideCapabilityMode,
  decideMode,
  detectCapabilities,
  noiseConstraints,
  readAudioPreferences,
  writeAudioPreferences,
} from '../src/lib/noiseSuppression.js';

import type { AudioPreferences } from '../src/lib/noiseSuppression.js';
import type { SuppressorState } from '../src/lib/noiseSuppressorWorklet.js';
import { DEFAULT_PREFERENCES, buildConstraints } from '../src/lib/devices.js';
import {
  FFT_SIZE,
  HOP_SIZE,
  PROCESSOR_NAME as WORKLET_PROCESSOR_NAME,
  computeGains,
  createState,
  fftReal,
  ifftReal,
  pushQuantum,
  smoothGains,
  updateNoiseFloor,
} from '../src/lib/noiseSuppressorWorklet.js';

/** RMS acima disto = falando (`lib/audioLevels.js`, SPEAKING_ON). */
const SPEAKING_ON = 0.035;

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial));
  return {
    getItem: (key: string) => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string) => map.set(key, String(value)),
    dump: () => Object.fromEntries(map),
  };
}

// ------------------------------------------------------------- preferência

test('a supressão nasce ligada — quem tem ambiente barulhento não precisa achar o toggle', () => {
  assert.equal(DEFAULT_AUDIO_PREFERENCES.noiseSuppression, true);
  assert.deepEqual(readAudioPreferences(fakeStorage()), { noiseSuppression: true });
});

test('a preferência mora em chave própria, separada de wtk-meet:devices', () => {
  assert.equal(AUDIO_STORAGE_KEY, 'wtk-meet:audio');
  const storage = fakeStorage();
  writeAudioPreferences(storage, { noiseSuppression: false });
  const dump = storage.dump();
  assert.deepEqual(Object.keys(dump), ['wtk-meet:audio']);
  assert.deepEqual(JSON.parse(dump['wtk-meet:audio']), { noiseSuppression: false });
});

test('readAudioPreferences nunca lança: storage ausente, getItem lançando, JSON corrompido', () => {
  const throwing = {
    getItem() {
      throw new Error('modo privado');
    },
  };
  for (const storage of [undefined, null, {}, throwing, fakeStorage({ 'wtk-meet:audio': '{{{' })]) {
    assert.deepEqual(readAudioPreferences(storage), DEFAULT_AUDIO_PREFERENCES);
  }
});

test('valor de tipo errado cai no default ligado — nunca desliga a supressão por acidente', () => {
  for (const bogus of ['false', 0, 1, null, [], {}]) {
    const storage = fakeStorage({ 'wtk-meet:audio': JSON.stringify({ noiseSuppression: bogus }) });
    assert.equal(readAudioPreferences(storage).noiseSuppression, true, JSON.stringify(bogus));
  }
});

test('chaves desconhecidas são descartadas na leitura e na escrita', () => {
  const storage = fakeStorage({
    'wtk-meet:audio': JSON.stringify({ noiseSuppression: false, gain: 3, echoCancellation: false }),
  });
  assert.deepEqual(readAudioPreferences(storage), { noiseSuppression: false });
  // O cast: o caso é gravar uma chave que o tipo não tem — é o que se afirma
  // ser descartado.
  assert.deepEqual(
    writeAudioPreferences(storage, { rumor: true } as Partial<AudioPreferences>),
    { noiseSuppression: false },
  );
  assert.deepEqual(JSON.parse(storage.dump()['wtk-meet:audio']), { noiseSuppression: false });
});

test('writeAudioPreferences engole storage que recusa gravar e devolve o valor efetivo', () => {
  const readOnly = {
    getItem: () => null,
    setItem() {
      throw new Error('cota');
    },
  };
  assert.deepEqual(writeAudioPreferences(readOnly, { noiseSuppression: false }), {
    noiseSuppression: false,
  });
});

// ----------------------------------------------------- matriz de decisão

test('modo: constraint nativa suportada vence — é mais barata e não empilha supressões', () => {
  const caps = detectCapabilities({
    supportedConstraints: { noiseSuppression: true },
    audioWorkletSupported: true,
  });
  assert.deepEqual(caps, { native: true, worklet: true });
  assert.equal(decideMode(caps), MODE.NATIVE);
});

test('modo: sem constraint nativa, mas com AudioWorklet, o fallback assume', () => {
  assert.equal(
    // O cast: o caso é justamente uma `supportedConstraints` **sem**
    // `noiseSuppression` — o tipo só declara a chave que o módulo lê.
    decideCapabilityMode({
      supportedConstraints: { echoCancellation: true } as { noiseSuppression?: boolean },
      audioWorkletSupported: true,
    }),
    MODE.WORKLET,
  );
});

test('modo: sem os dois é `unsupported` — é o que desabilita o toggle com explicação', () => {
  assert.equal(
    decideCapabilityMode({ supportedConstraints: {}, audioWorkletSupported: false }),
    MODE.UNSUPPORTED,
  );
  // Navegador que nem responde `getSupportedConstraints` cai no mesmo lugar.
  assert.equal(decideCapabilityMode({}), MODE.UNSUPPORTED);
  assert.equal(decideMode(undefined), MODE.UNSUPPORTED);
});

test('o nome do processador é o mesmo nos dois arquivos — a cópia do worklet não pode divergir', () => {
  // O arquivo do worklet não pode importar nada, então o literal existe nos
  // dois lugares. Renomear só um lado daria "unknown processor" em runtime, no
  // caminho de fallback, que é justamente o que quase ninguém exercita.
  assert.equal(PROCESSOR_NAME, WORKLET_PROCESSOR_NAME);
});

// ---------------------------------------------------------- constraints

test('a constraint é emitida também quando o toggle está DESLIGADO', () => {
  // A armadilha conceitual da entrega inteira: Chrome, Edge, Firefox e Safari
  // ligam noiseSuppression por padrão. Omitir a constraint no estado desligado
  // entregaria um toggle que não desliga nada — sem erro, sem sintoma, e a
  // queixa chegaria semanas depois como "o toggle não faz nada".
  assert.deepEqual(noiseConstraints({ noiseSuppression: false }), {
    noiseSuppression: { ideal: false },
  });
  assert.deepEqual(noiseConstraints({ noiseSuppression: true }), {
    noiseSuppression: { ideal: true },
  });
  // Preferência ausente ou corrompida vale como ligada.
  assert.deepEqual(noiseConstraints(null), { noiseSuppression: { ideal: true } });
});

test('buildConstraints junta o processamento ao ramo de áudio, com e sem deviceId', () => {
  const processing = noiseConstraints({ noiseSuppression: true });

  assert.deepEqual(buildConstraints(DEFAULT_PREFERENCES, { audio: true, audioProcessing: processing }), {
    video: false,
    audio: { noiseSuppression: { ideal: true } },
  });

  const withMic = { ...DEFAULT_PREFERENCES, audioInputId: 'mic-1' };
  assert.deepEqual(buildConstraints(withMic, { audio: true, audioProcessing: processing }), {
    video: false,
    audio: { deviceId: { ideal: 'mic-1' }, noiseSuppression: { ideal: true } },
  });

  // Áudio não pedido continua `false`: o ramo de vídeo não ganha processamento.
  assert.deepEqual(
    buildConstraints(withMic, { video: true, audio: false, audioProcessing: processing }),
    { video: true, audio: false },
  );
});

test('nenhum `exact` entra nas constraints — com ele, um navegador sem a constraint entra sem áudio', () => {
  const json = JSON.stringify(
    buildConstraints(
      { ...DEFAULT_PREFERENCES, videoInputId: 'cam-1', audioInputId: 'mic-1' },
      { video: true, audio: true, audioProcessing: noiseConstraints({ noiseSuppression: false }) },
    ),
  );
  assert.ok(!json.includes('exact'), json);
});

test('sem audioProcessing o contrato antigo é preservado (`audio: true`)', () => {
  assert.deepEqual(buildConstraints(DEFAULT_PREFERENCES, { video: true, audio: true }), {
    video: true,
    audio: true,
  });
});

// ------------------------------------------------------------------- DSP

/** Ruído pseudoaleatório determinístico: o mesmo sinal em toda execução. */
function noiseGenerator(seed = 12345) {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return (state / 0x7fffffff) * 2 - 1;
  };
}

const rmsOf = (buffer: Float32Array, from = 0, to = buffer.length) => {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += buffer[i]! * buffer[i]!;
  return Math.sqrt(sum / (to - from));
};

/** Roda um sinal inteiro pelo DSP, quantum a quantum, como o worklet faria. */
function process(state: SuppressorState, signal: Float32Array, enabled = true) {
  const frames = Math.floor(signal.length / HOP_SIZE);
  const out = new Float32Array(frames * HOP_SIZE);
  const quantum = new Float32Array(HOP_SIZE);
  for (let k = 0; k < frames; k += 1) {
    pushQuantum(state, signal.subarray(k * HOP_SIZE, (k + 1) * HOP_SIZE), quantum, { enabled });
    out.set(quantum, k * HOP_SIZE);
  }
  return out;
}

const whiteNoise = (samples: number, amplitude: number, seed: number) => {
  const next = noiseGenerator(seed);
  const out = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) out[i] = next() * amplitude;
  return out;
};

test('ifftReal(fftReal(x)) devolve x — a FFT é a base de tudo o que vem depois', () => {
  const next = noiseGenerator(7);
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  const original = new Float64Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i += 1) {
    original[i] = next();
    re[i] = original[i];
  }

  fftReal(re, im);
  ifftReal(re, im);

  let worst = 0;
  for (let i = 0; i < FFT_SIZE; i += 1) {
    worst = Math.max(worst, Math.abs(re[i] - original[i]), Math.abs(im[i]));
  }
  assert.ok(worst < 1e-6, `erro máximo ${worst}`);
});

test('com `enabled: false` o overlap-add é a identidade, a menos da latência de 384 amostras', () => {
  // Prova que o caminho de bypass é o MESMO caminho de processamento, com ganho
  // unitário: mesma latência, sem clique na transição, e uma janela mal
  // normalizada apareceria aqui como erro de amplitude.
  const state = createState(48000);
  const next = noiseGenerator(21);
  const samples = 200 * HOP_SIZE;
  const input = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) input[i] = Math.sin(i * 0.05) * 0.5 + next() * 0.2;

  const output = process(state, input, false);

  const latency = FFT_SIZE - HOP_SIZE;
  assert.equal(latency, 384);
  let worst = 0;
  for (let i = latency; i < samples; i += 1) {
    worst = Math.max(worst, Math.abs(output[i] - input[i - latency]));
  }
  assert.ok(worst < 1e-6, `erro máximo por amostra ${worst}`);
});

test('ruído branco estacionário é atenuado em pelo menos 10 dB depois de 1 s de adaptação', () => {
  const state = createState(48000);
  const noise = whiteNoise(48000 * 2, 0.08, 4242);

  const output = process(state, noise, true);

  // Mede só o segundo segundo: o primeiro é a adaptação do piso.
  const before = rmsOf(noise, 48000, noise.length);
  const after = rmsOf(output, 48000, output.length);
  const attenuation = 20 * Math.log10(before / after);
  assert.ok(attenuation >= 10, `atenuação de apenas ${attenuation.toFixed(2)} dB`);
});

test('um tom em nível de fala atravessa quase intacto — supressão que come a voz é pior que nenhuma', () => {
  const state = createState(48000);
  // Primeiro o ambiente, para o piso convergir; depois a "fala" por cima dele.
  process(state, whiteNoise(48000, 0.01, 99), true);

  const samples = 187 * HOP_SIZE;
  const next = noiseGenerator(1234);
  const tone = new Float32Array(samples);
  for (let i = 0; i < samples; i += 1) {
    tone[i] = 0.15 * Math.sin((2 * Math.PI * 440 * i) / 48000) + next() * 0.01;
  }

  const output = process(state, tone, true);

  const latency = FFT_SIZE - HOP_SIZE;
  const attenuation =
    20 * Math.log10(rmsOf(tone, 0, samples - latency) / rmsOf(output, latency, samples));
  assert.ok(attenuation < 1, `o tom perdeu ${attenuation.toFixed(2)} dB`);
});

test('fala simulada continua acima do limiar do anel de fala depois da supressão', () => {
  // O risco concreto: um gMin agressivo derruba o RMS e o anel para de acender.
  // O sintoma chega como "o indicador de fala quebrou", não como "a supressão
  // está agressiva demais" — e o conserto errado seria baixar SPEAKING_ON, que
  // vale também para os streams remotos, que não passam por supressão nenhuma.
  const state = createState(48000);
  process(state, whiteNoise(48000, 0.01, 555), true);

  const samples = 375 * HOP_SIZE;
  const next = noiseGenerator(777);
  const speech = new Float32Array(samples);
  const harmonics = [
    [130, 1],
    [260, 0.6],
    [390, 0.4],
    [520, 0.25],
    [780, 0.15],
  ];
  for (let i = 0; i < samples; i += 1) {
    const t = i / 48000;
    // Envelope de sílabas: fala real não é um tom contínuo.
    const envelope = 0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t);
    let value = 0;
    for (const [frequency, amplitude] of harmonics) {
      value += amplitude * Math.sin(2 * Math.PI * frequency * t);
    }
    speech[i] = (0.34 * envelope * value) / 2.4 + next() * 0.01;
  }

  const output = process(state, speech, true);

  assert.ok(rmsOf(speech) > SPEAKING_ON, 'o sinal de teste precisa estar em nível de fala');
  const level = rmsOf(output, FFT_SIZE - HOP_SIZE, output.length);
  assert.ok(level > SPEAKING_ON, `RMS de ${level.toFixed(4)} não acenderia o anel de fala`);
});

test('o piso sobe devagar e desce rápido — é o que impede a fala de virar "ruído"', () => {
  const floor = new Float64Array([1, 1, 1]);
  const attack = 0.01;
  const release = 0.5;

  // Subida: com holdRatio alto o piso sobe, mas devagar.
  updateNoiseFloor(floor, new Float64Array([2, 2, 2]), { attack, release, holdRatio: 10 });
  assert.ok(floor[0] > 1 && floor[0] < 1.02, `subiu para ${floor[0]}`);

  // Descida: muito mais rápida, para acompanhar o ambiente ficando silencioso.
  const falling = new Float64Array([1, 1, 1]);
  updateNoiseFloor(falling, new Float64Array([0, 0, 0]), { attack, release, holdRatio: 10 });
  assert.equal(falling[0], 0.5);

  // Sinal muito acima do piso congela a estimativa: é fala, não ruído.
  const held = new Float64Array([1]);
  updateNoiseFloor(held, new Float64Array([50]), { attack, release, holdRatio: 4 });
  assert.equal(held[0], 1);

  // Piso ainda sem história adota a magnitude do primeiro quadro.
  const fresh = new Float64Array([0]);
  updateNoiseFloor(fresh, new Float64Array([0.7]), { attack, release, holdRatio: 4 });
  assert.equal(fresh[0], 0.7);
});

test('o ganho nunca fecha até o silêncio absoluto nem passa de 1', () => {
  const mags = new Float64Array([1, 0.5, 10, 0]);
  const floor = new Float64Array([1, 1, 0.01, 1]);
  const gains = computeGains(mags, floor, { gMin: 0.12, beta: 2 });

  // `Math.fround`: o ganho é guardado em Float32Array, e 0.12 não é exato lá.
  const gMin = Math.fround(0.12);
  assert.ok(gains[0] >= gMin, 'bin no nível do piso não pode ser zerado');
  assert.equal(gains[1], gMin, 'bin abaixo do piso satura no mínimo, não em zero');
  assert.ok(gains[2] > 0.99 && gains[2] <= 1, 'bin muito acima do piso passa inteiro');
  assert.equal(gains[3], 1, 'magnitude zero não tem o que suprimir');
});

test('a suavização em frequência é média móvel de verdade, sem se realimentar', () => {
  // Se a média lesse os bins já suavizados em vez dos originais, ela viraria um
  // filtro recursivo e o espectro sairia arrastado — o artefato é sutil e não
  // aparece em nenhuma asserção de estrutura.
  const gains = new Float32Array([0, 3, 0, 0, 0]);
  const previous = new Float32Array(5);
  smoothGains(gains, previous, { span: 3, alpha: 0 });
  assert.deepEqual([...gains], [1.5, 1, 1, 0, 0]);

  // alpha mistura com o quadro anterior e deixa `previous` pronto para o próximo.
  const held = new Float32Array([1, 1]);
  const before = new Float32Array([0, 0]);
  smoothGains(held, before, { span: 1, alpha: 0.5 });
  assert.deepEqual([...held], [0.5, 0.5]);
  assert.deepEqual([...before], [0.5, 0.5]);
});

test('quantum sem fonte conectada vira silêncio, e não uma exceção na thread de áudio', () => {
  const state = createState(48000);
  const output = new Float32Array(HOP_SIZE).fill(9);
  pushQuantum(state, null, output, { enabled: true });
  assert.ok(
    output.every((sample) => sample === 0),
    'entrada ausente tem que produzir silêncio',
  );
});

test('createState aceita a taxa que o navegador der, sem quebrar em 44,1 kHz', () => {
  for (const rate of [44100, 48000, 96000]) {
    const state = createState(rate);
    assert.equal(state.sampleRate, rate);
    // A normalização do overlap-add sai da própria janela: 4 janelas de Hann
    // com passo N/4 somam 1.5 em qualquer taxa.
    assert.ok(Math.abs(state.wolaGain - 1.5) < 1e-12, `wolaGain ${state.wolaGain}`);
  }
  // Taxa inválida não pode zerar divisor nenhum.
  assert.equal(createState(0).sampleRate, 48000);
  assert.equal(createState(undefined).sampleRate, 48000);
});
