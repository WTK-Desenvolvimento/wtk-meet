/**
 * Supressão de ruído por porta espectral — o motor de fallback.
 *
 * Este arquivo é carregado de duas formas **diferentes**, e é por isso que ele
 * não tem nenhum `import`:
 *
 * 1. pelo navegador, via `audioWorklet.addModule(url)`, num escopo global
 *    isolado onde `import` não é confiável e onde o Vite (que copia o arquivo
 *    verbatim por causa do `?url`) não resolveria dependência nenhuma;
 * 2. pelo `node:test`, como um módulo ES comum, para exercitar o DSP.
 *
 * As duas guardas de runtime (`typeof AudioWorkletProcessor`, `typeof
 * registerProcessor`) são o que permite o mesmo arquivo servir aos dois — sem
 * `try/catch` e, principalmente, sem duas cópias do DSP. Duas cópias divergem.
 *
 * Por que FFT e não um noise gate de banda larga: gate por RMS não faz **nada**
 * contra ventilador, ar-condicionado ou rua *enquanto a pessoa fala*, que é o
 * problema real. Ele só corta o silêncio entre frases — e o botão de mudo já
 * faz isso melhor.
 */

/** Janela de análise e passo entre janelas. `HOP` = 1 render quantum. */
export const FFT_SIZE = 512;
export const HOP_SIZE = 128;

/** Bins de uma FFT real de 512 pontos (0…Nyquist). */
export const BIN_COUNT = FFT_SIZE / 2 + 1;

/** Nome sob o qual o processador é registrado. */
export const PROCESSOR_NAME = 'wtk-noise-suppressor';

/**
 * Ganho mínimo por bin: ≈ −18 dB, **nunca** zero.
 *
 * Um gate que fecha até o silêncio absoluto faz a pessoa soar cortada, mata as
 * caudas naturais da fala e — efeito colateral concreto neste código — derruba o
 * RMS a zero, apagando o anel de fala de `audioLevels.js` durante as pausas.
 */
export const G_MIN = 0.12;

/**
 * Fator de sobre-subtração. Com β = 1 (subtração exata do piso), o ganho médio
 * sobre ruído gaussiano fica em torno de −6 dB: o piso estimado é uma *média*, e
 * metade dos bins fica acima dele a cada quadro. β = 2 é o que leva a atenuação
 * medida para a faixa dos −12 dB sem estreitar a fala, e é o parâmetro que um
 * dia vira o seletor leve/médio/agressivo.
 */
export const OVER_SUBTRACTION = 2;

/** Constantes de tempo do seguidor de piso e da suavização de ganho. */
export const ATTACK_SECONDS = 1.5;
export const RELEASE_SECONDS = 0.08;
export const GAIN_SMOOTHING_SECONDS = 0.03;

/**
 * Acima de `HOLD_RATIO` vezes o piso, o quadro é tratado como sinal e o piso
 * **congela** naquele bin.
 *
 * Sem isso, um ataque de 1.5 s ainda absorve fala: em meio segundo o piso já
 * subiu para ~28% da energia da voz, e a partir daí a pessoa passa a ser
 * suprimida por falar. Congelar durante sinal forte é o que faz "sobe devagar"
 * significar de fato "não incorpora a fala ao ruído".
 */
export const HOLD_RATIO = 4;

/** Média móvel em frequência, em bins (ímpar). Mata o *musical noise*. */
export const GAIN_SPAN = 3;

/**
 * Enquanto o piso não tem história, ele segue a magnitude nos dois sentidos e
 * sem congelamento — senão um piso que nasce em zero nunca sobe (tudo seria
 * "sinal forte") e a supressão simplesmente não aconteceria.
 */
export const WARMUP_SECONDS = 0.25;

const EPSILON = 1e-12;

// --------------------------------------------------------------------- FFT

/**
 * Tabelas de twiddle e de bit-reversal, memoizadas por tamanho.
 *
 * Ficam no escopo do módulo, e não no estado, porque `fftReal(re, im)` é a
 * assinatura do contrato — e porque calcular seno e cosseno a cada borboleta
 * custaria ~4600 chamadas trigonométricas por FFT, 375 vezes por segundo, na
 * thread de áudio.
 */
/**
 * Buffer de amostras. O DSP não se importa com a precisão — o estado usa
 * `Float64Array` onde acumula e `Float32Array` onde o WebAudio entrega —, e
 * fixar uma das duas nas assinaturas só obrigaria a converter à toa.
 */
type FloatBuffer = Float32Array | Float64Array;

export interface NoiseFloorOptions {
  attack?: number;
  release?: number;
  holdRatio?: number;
}

export interface ComputeGainsOptions {
  gMin?: number;
  beta?: number;
  /** Buffer de saída. Existe para o caminho de tempo real não alocar por quantum. */
  out?: Float32Array | null;
}

export interface SmoothGainsOptions {
  span?: number;
  alpha?: number;
}

/** Tudo que um quantum precisa; alocado uma vez por `createState`. */
export interface SuppressorState {
  sampleRate: number;
  window: Float64Array;
  wolaGain: number;
  input: Float64Array;
  overlap: Float64Array;
  re: Float64Array;
  im: Float64Array;
  mags: Float64Array;
  floor: Float64Array;
  gains: Float32Array;
  previous: Float32Array;
  attack: number;
  release: number;
  alpha: number;
  warmup: number;
  gMin: number;
  beta: number;
  span: number;
  holdRatio: number;
}

interface FftTables {
  cos: Float64Array;
  sin: Float64Array;
  rev: Uint32Array;
}

const tableCache = new Map<number, FftTables>();

function tablesFor(n: number): FftTables {
  let tables = tableCache.get(n);
  if (tables) return tables;

  const half = n >> 1;
  const cos = new Float64Array(half);
  const sin = new Float64Array(half);
  for (let i = 0; i < half; i += 1) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }

  let bits = 0;
  while (1 << bits < n) bits += 1;
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) {
    let r = 0;
    for (let b = 0; b < bits; b += 1) {
      if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    }
    rev[i] = r;
  }

  tables = { cos, sin, rev };
  tableCache.set(n, tables);
  return tables;
}

function transform(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  const { cos, sin, rev } = tablesFor(n);

  for (let i = 0; i < n; i += 1) {
    const j = rev[i];
    if (j > i) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let j = start, k = 0; j < start + half; j += 1, k += step) {
        const c = cos[k];
        const s = inverse ? -sin[k] : sin[k];
        const pair = j + half;
        const tr = re[pair] * c - im[pair] * s;
        const ti = re[pair] * s + im[pair] * c;
        re[pair] = re[j] - tr;
        im[pair] = im[j] - ti;
        re[j] += tr;
        im[j] += ti;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** FFT radix-2, in-place. `im` entra zerado para um sinal real. */
export function fftReal(re: Float64Array, im: Float64Array): void {
  transform(re, im, false);
}

/** Inversa da `fftReal`, in-place e já normalizada por N. */
export function ifftReal(re: Float64Array, im: Float64Array): void {
  transform(re, im, true);
}

/** Buffer vazio compartilhado: um quantum sem fonte conectada vira silêncio. */
const SEM_ENTRADA = new Float32Array(0);

// --------------------------------------------------------------------- DSP

function hannWindow(size: number): Float64Array {
  const win = new Float64Array(size);
  // Hann **periódica** (divisor `size`, não `size - 1`): é a que soma constante
  // no overlap-add com passo N/4, e é dessa constância que sai a reconstrução
  // exata quando o ganho é unitário.
  for (let i = 0; i < size; i += 1) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return win;
}

const ringCache = new Map<number, Float64Array>();

function ringFor(size: number): Float64Array {
  let ring = ringCache.get(size);
  if (!ring) {
    ring = new Float64Array(size);
    ringCache.set(size, ring);
  }
  return ring;
}

const timeCoefficient = (frameSeconds: number, tau: number): number =>
  1 - Math.exp(-frameSeconds / tau);

/**
 * Aloca janelas, buffers e o piso de ruído. `sampleRate` entra por parâmetro
 * porque o global de mesmo nome só existe no escopo do worklet — no `node:test`
 * ele não existe.
 */
export function createState(sampleRate?: number): SuppressorState {
  const rate = typeof sampleRate === 'number' && Number.isFinite(sampleRate) && sampleRate > 0
    ? sampleRate
    : 48000;
  const frameSeconds = HOP_SIZE / rate;
  const win = hannWindow(FFT_SIZE);

  // Σ w²  nas 4 janelas que cobrem cada amostra da saída. Medido da própria
  // janela em vez de escrito como `1.5`: se a janela mudar, a normalização
  // acompanha sozinha, e um overlap-add mal normalizado é ganho errado — não
  // erro.
  let wolaGain = 0;
  for (let i = 0; i < FFT_SIZE; i += HOP_SIZE) wolaGain += win[i] * win[i];

  return {
    sampleRate: rate,
    window: win,
    wolaGain,
    input: new Float64Array(FFT_SIZE),
    overlap: new Float64Array(FFT_SIZE),
    re: new Float64Array(FFT_SIZE),
    im: new Float64Array(FFT_SIZE),
    mags: new Float64Array(BIN_COUNT),
    floor: new Float64Array(BIN_COUNT),
    gains: new Float32Array(BIN_COUNT),
    // Nasce em 1: começar em zero faria o início da primeira frase entrar
    // rampando, que é audível justo no "alô".
    previous: new Float32Array(BIN_COUNT).fill(1),
    attack: timeCoefficient(frameSeconds, ATTACK_SECONDS),
    release: timeCoefficient(frameSeconds, RELEASE_SECONDS),
    alpha: Math.exp(-frameSeconds / GAIN_SMOOTHING_SECONDS),
    warmup: Math.ceil(WARMUP_SECONDS / frameSeconds),
    gMin: G_MIN,
    beta: OVER_SUBTRACTION,
    span: GAIN_SPAN,
    holdRatio: HOLD_RATIO,
  };
}

/**
 * Seguidor assimétrico do piso de ruído, in-place e por bin: sobe devagar
 * (`attack`), desce rápido (`release`) e congela acima de `holdRatio`.
 *
 * Descer rápido é o que acompanha o ambiente ficando mais silencioso; subir
 * devagar é o que impede a fala de virar "ruído".
 */
export function updateNoiseFloor(
  floor: FloatBuffer,
  mags: FloatBuffer,
  { attack = 0, release = 0, holdRatio = Infinity }: NoiseFloorOptions = {},
): void {
  for (let b = 0; b < floor.length; b += 1) {
    const m = mags[b];
    const f = floor[b];
    // Primeiro quadro (ou silêncio digital): não há história para seguir.
    if (!(f > 0)) {
      floor[b] = m;
      continue;
    }
    if (m < f) floor[b] = f + release * (m - f);
    else if (m < f * holdRatio) floor[b] = f + attack * (m - f);
    // acima de holdRatio o piso fica onde está: aquilo é sinal, não ruído
  }
}

/**
 * Ganho de Wiener por bin, com sobre-subtração e clamp em `[gMin, 1]`.
 *
 * `out` existe para o caminho de tempo real: alocar por quantum convidaria o GC
 * para a thread de áudio. Sem ele, aloca — que é o que o teste quer.
 */
export function computeGains(
  mags: FloatBuffer,
  floor: FloatBuffer,
  { gMin = G_MIN, beta = OVER_SUBTRACTION, out = null }: ComputeGainsOptions = {},
): Float32Array {
  const gains = out || new Float32Array(mags.length);
  for (let b = 0; b < gains.length; b += 1) {
    const m = mags[b];
    if (m <= EPSILON) {
      // Nada a suprimir: dividir aqui só produziria ruído numérico.
      gains[b] = 1;
      continue;
    }
    const g = 1 - (beta * floor[b]) / m;
    gains[b] = g < gMin ? gMin : g > 1 ? 1 : g;
  }
  return gains;
}

/**
 * Suaviza o ganho em frequência (média móvel de `span` bins) e no tempo
 * (1ª ordem, coeficiente `alpha`), in-place. `previous` guarda o quadro
 * anterior e é atualizado aqui.
 *
 * Ganho por bin aplicado cru produz *musical noise*: tons aleatórios entrando e
 * saindo. É o artefato clássico da subtração espectral e o motivo de a versão
 * ingênua soar pior do que não fazer nada.
 */
export function smoothGains(
  gains: FloatBuffer,
  previous: FloatBuffer,
  { span = GAIN_SPAN, alpha = 0 }: SmoothGainsOptions = {},
): void {
  const n = gains.length;
  const radius = Math.min(Math.max(0, (span - 1) >> 1), n);

  if (radius > 0) {
    // O anel guarda os valores **originais** dos bins já sobrescritos: sem ele,
    // a média em frequência realimentaria a si mesma e viraria um filtro
    // recursivo, com atraso crescente ao longo do espectro.
    const ring = ringFor(radius);
    for (let b = 0; b < n; b += 1) {
      const original = gains[b];
      let sum = original;
      let count = 1;
      for (let k = 1; k <= radius; k += 1) {
        const low = b - k;
        if (low >= 0) {
          sum += ring[low % radius];
          count += 1;
        }
        const high = b + k;
        if (high < n) {
          sum += gains[high];
          count += 1;
        }
      }
      ring[b % radius] = original;
      gains[b] = sum / count;
    }
  }

  for (let b = 0; b < n; b += 1) {
    const smoothed = alpha * previous[b] + (1 - alpha) * gains[b];
    gains[b] = smoothed;
    previous[b] = smoothed;
  }
}

/**
 * Consome 128 amostras de `input` e preenche 128 em `output`.
 *
 * Com `enabled: false` o ganho é fixo em 1.0 e o sinal atravessa o **mesmo**
 * caminho de overlap-add: mesma latência algorítmica (384 amostras ≈ 8 ms a
 * 48 kHz) e nenhum clique na transição, porque nada é desmontado nem religado.
 */
export function pushQuantum(
  state: SuppressorState,
  input: Float32Array | null,
  output: Float32Array,
  { enabled = true }: { enabled?: boolean } = {},
): void {
  const { window: win, input: inBuf, overlap, re, im, mags, floor, gains, previous } = state;

  // Desliza a janela: os 384 mais recentes descem, o quantum novo entra no fim.
  inBuf.copyWithin(0, HOP_SIZE);
  // `src` em vez de testar `input` duas vezes: com o buffer vazio, `available`
  // dá 0 e o laço escreve zeros — exatamente o que o `input ? … : 0` fazia.
  const src = input ?? SEM_ENTRADA;
  const available = Math.min(HOP_SIZE, src.length);
  const base = FFT_SIZE - HOP_SIZE;
  for (let i = 0; i < HOP_SIZE; i += 1) inBuf[base + i] = i < available ? src[i] : 0;

  for (let i = 0; i < FFT_SIZE; i += 1) {
    re[i] = inBuf[i] * win[i];
    im[i] = 0;
  }
  fftReal(re, im);

  for (let b = 0; b < BIN_COUNT; b += 1) mags[b] = Math.hypot(re[b], im[b]);

  const warming = state.warmup > 0;
  if (warming) state.warmup -= 1;
  // O piso continua adaptando com a supressão desligada: religar o toggle não
  // pode custar um segundo de convergência.
  updateNoiseFloor(floor, mags, {
    attack: warming ? state.release : state.attack,
    release: state.release,
    holdRatio: warming ? Infinity : state.holdRatio,
  });

  if (enabled) {
    computeGains(mags, floor, { gMin: state.gMin, beta: state.beta, out: gains });
    smoothGains(gains, previous, { span: state.span, alpha: state.alpha });
  } else {
    gains.fill(1);
    previous.fill(1);
  }

  // O espectro de um sinal real é conjugado-simétrico: o mesmo ganho vale para
  // o bin espelhado, senão a IFFT devolve um sinal complexo e a parte real sai
  // distorcida.
  for (let b = 0; b < BIN_COUNT; b += 1) {
    const g = gains[b];
    re[b] *= g;
    im[b] *= g;
    const mirror = FFT_SIZE - b;
    if (b > 0 && mirror < FFT_SIZE && mirror !== b) {
      re[mirror] *= g;
      im[mirror] *= g;
    }
  }
  ifftReal(re, im);

  for (let i = 0; i < FFT_SIZE; i += 1) overlap[i] += re[i] * win[i];
  for (let i = 0; i < HOP_SIZE; i += 1) output[i] = overlap[i] / state.wolaGain;
  overlap.copyWithin(0, HOP_SIZE);
  overlap.fill(0, base);
}

// ------------------------------------------------------------ AudioWorklet

// Fora do worklet (`node:test`, bundler) a base é uma classe vazia: o arquivo
// precisa **avaliar** nos dois mundos, e é só no worklet que a classe base
// existe.
const ProcessorBase: typeof AudioWorkletProcessor =
  typeof AudioWorkletProcessor === 'function'
    ? AudioWorkletProcessor
    // A classe vazia não tem `port`, e não precisa ter: fora do worklet nada
    // chama `process`. O cast é a única forma de dizer isso ao compilador,
    // porque `AudioWorkletProcessor` só existe no AudioWorkletGlobalScope.
    : (class {} as unknown as typeof AudioWorkletProcessor);

// `sampleRate` é global no escopo do `AudioWorkletGlobalScope`, e só lá — não é
// um global de `window`, então o lint precisa ser avisado.
/* global sampleRate */

export class NoiseSuppressorProcessor extends ProcessorBase {
  state: SuppressorState;
  enabled: boolean;
  /** Pré-alocados: nenhuma alocação pode acontecer dentro de `process`. */
  silence: Float32Array;
  mono: Float32Array;

  constructor(options?: AudioWorkletNodeOptions) {
    super(options);
    // `sampleRate` é global no escopo do worklet; fora dele, 48 kHz é só um
    // valor de partida que nenhum caminho real usa.
    this.state = createState(typeof sampleRate === 'number' ? sampleRate : 48000);
    this.enabled = options?.processorOptions?.enabled !== false;
    // Pré-alocados: nenhuma alocação pode acontecer dentro de `process`.
    this.silence = new Float32Array(HOP_SIZE);
    this.mono = new Float32Array(HOP_SIZE);
    this.port.onmessage = (event: MessageEvent) => {
      const data: unknown = event?.data;
      if (data && typeof data === 'object' && 'type' in data && data.type === 'enabled') {
        this.enabled = (data as { value?: unknown }).value !== false;
      }
    };
  }

  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    // Sem saída não há o que fazer — mas **nunca** retornar false: o navegador
    // coletaria o nó e o áudio sumiria sem erro nenhum.
    if (!output || output.length === 0) return true;

    const input = inputs[0];
    let mono;
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      // Quantum sem fonte conectada: silêncio na saída, e segue vivo.
      mono = this.silence;
    } else if (input.length === 1) {
      mono = input[0];
    } else {
      // Rebaixa para mono por média. Descartar o canal direito perderia metade
      // da captação de um microfone estéreo.
      const buffer = this.mono;
      const channels = input.length;
      const frames = Math.min(buffer.length, input[0].length);
      for (let i = 0; i < frames; i += 1) {
        let sum = 0;
        for (let c = 0; c < channels; c += 1) sum += input[c][i] || 0;
        buffer[i] = sum / channels;
      }
      for (let i = frames; i < buffer.length; i += 1) buffer[i] = 0;
      mono = buffer;
    }

    pushQuantum(this.state, mono, output[0], { enabled: this.enabled });
    for (let c = 1; c < output.length; c += 1) output[c].set(output[0]);
    return true;
  }
}

// Só existe dentro do worklet. No `node:test` este arquivo é um módulo comum.
if (typeof registerProcessor === 'function') {
  registerProcessor(PROCESSOR_NAME, NoiseSuppressorProcessor);
}
