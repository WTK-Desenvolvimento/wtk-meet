/**
 * O escopo global do `AudioWorkletGlobalScope`.
 *
 * A `lib.dom` do TypeScript descreve o lado da **página** (`AudioWorkletNode`,
 * `AudioWorklet.addModule`) e não descreve o lado de **dentro** do worklet, que
 * roda noutro global. `AudioWorkletProcessor`, `registerProcessor`, `sampleRate`
 * e `currentTime` só existem lá, e é por isso que nada disto está na lib.
 *
 * Só `lib/noiseSuppressorWorklet.ts` depende deste arquivo — e ele é carregado
 * de duas formas (pelo browser via `addModule`, e pelo `node:test` como módulo
 * ES comum), o que é exatamente a razão de as duas guardas de runtime
 * (`typeof AudioWorkletProcessor`, `typeof registerProcessor`) existirem lá.
 */

/** Não está na lib.dom: só existe dentro do AudioWorkletGlobalScope. */
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: AudioWorkletNodeOptions);
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}

/** Não está na lib.dom: registra o processador no escopo do worklet. */
declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletNodeOptions) => AudioWorkletProcessor,
): void;

/** Não está na lib.dom: taxa de amostragem do contexto, global dentro do worklet. */
declare const sampleRate: number;

/** Não está na lib.dom: relógio do contexto, global dentro do worklet. */
declare const currentTime: number;
