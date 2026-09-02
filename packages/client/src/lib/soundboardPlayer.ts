/**
 * O disparo de um efeito: da URL ao som que a sala ouve.
 *
 * Caminho, e por que é este: `fetch` → `decodeAudioData` → `AudioBufferSourceNode`
 * conectado ao **mesmo** `MediaStreamDestination` do canal de música. Nada de
 * `<audio>` e nada de `createMediaElementSource` para efeitos — o elemento de
 * mídia é a peça que fica *tainted* com CORS e emite silêncio digital sem erro
 * (armadilha nº 2 do cabeçalho de `musicEngine.js`), e um efeito de 1,2s não
 * sobrevive ao tempo de carga de um elemento novo por clique.
 *
 * Quatro decisões que este arquivo existe para segurar:
 *
 * 1. **A sonda de CORS vem antes de mixar.** Um `Range: bytes=0-0` — a mesma
 *    sonda de `musicEngine.probeDelivery` — decide se dá para capturar. Sem ela,
 *    o clique "funciona" na máquina de quem disparou (o monitor toca) e a sala
 *    recebe silêncio, sem erro em lugar nenhum. Com ela, a recusa vira mensagem
 *    no painel. **O MyInstants não manda CORS** (verificado em 2026-09-01): uma
 *    URL de lá cai exatamente nesta recusa, com mensagem, em vez de virar um
 *    clique que aparentemente não faz nada.
 * 2. **O cache guarda o `AudioBuffer`, nunca o `ArrayBuffer`.** `decodeAudioData`
 *    consome (detacha) o buffer cru: decodificar duas vezes o mesmo
 *    `ArrayBuffer` lança, e guardar o cru é guardar algo que não serve mais.
 * 3. **`AudioBufferSourceNode` é de uso único.** Um nó novo por disparo; reusar
 *    não toca de novo e não lança nada útil.
 * 4. **Um efeito por vez.** Um disparo novo corta o anterior *desta* máquina —
 *    somar quatro efeitos no mesmo canal satura, e saturação chega ao outro lado
 *    como distorção que ninguém sabe atribuir.
 *
 * O ganho **de rede** é fixo (1.0) com um compressor só neste sub-ramo: o
 * volume é sempre local e nunca trafega (§6.9), e o compressor fora do caminho
 * do player preserva a qualidade que o `contentHint = 'music'` foi buscar.
 */

import { MAX_SOUND_MS } from './soundboard.js';

/** Quantos efeitos decodificados ficam em memória. */
const CACHE_LIMIT = 24;

/** Uma falha de disparo, com razão que o painel sabe traduzir. */
export class SoundboardError extends Error {
  reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = 'SoundboardError';
    this.reason = reason;
  }
}

export interface SoundboardPlayerOptions {
  /** O ponto de mixagem do canal de música (ver `MusicEngine.ensureOutput`). */
  getOutput: () => { context: AudioContext; destination: AudioNode } | null;
  /** Injetável para teste; em produção é o `fetch` do navegador. */
  fetchImpl?: typeof fetch;
}

/** O que um disparo devolve a quem chamou. */
export interface FireResult {
  durationMs: number;
}

export class SoundboardPlayer {
  getOutput: SoundboardPlayerOptions['getOutput'];
  fetchImpl: typeof fetch;

  /** Efeitos já decodificados, por URL. */
  cache: Map<string, AudioBuffer>;
  /** O nó do efeito corrente — é ele que o próximo disparo corta. */
  current: AudioBufferSourceNode | null;
  /** Ganho de monitoração: só o que **quem dispara** ouve de si. */
  monitorGain: GainNode | null;
  monitorVolume: number;
  /** Ganho de rede: controla o volume do efeito no canal enviado à sala. */
  networkVolume: number;
  destroyed: boolean;

  constructor({ getOutput, fetchImpl }: SoundboardPlayerOptions) {
    this.getOutput = getOutput;
    this.fetchImpl = fetchImpl || ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.cache = new Map();
    this.current = null;
    this.monitorGain = null;
    this.monitorVolume = 1;
    this.networkVolume = 1;
    this.destroyed = false;
  }

  /**
   * A URL deixa capturar o áudio? Mesma pergunta, mesma sonda e mesma resposta
   * de `musicEngine.probeDelivery` — a diferença é o que se faz com o "não":
   * lá há o modo `local` como plano B, aqui **não há**, porque o requisito é o
   * efeito subir mixado no canal de quem disparou. Então o "não" é uma recusa
   * visível, e não um caminho alternativo silencioso.
   */
  async probe(sourceRef: string): Promise<boolean> {
    try {
      const res = await this.fetchImpl(sourceRef, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        mode: 'cors',
        cache: 'no-store',
      });
      return res.ok || res.status === 206;
    } catch {
      // CORS, host fora do ar, mixed content: em qualquer caso a captura não
      // funcionaria, e o sintoma seria silêncio sem erro.
      return false;
    }
  }

  /**
   * Baixa e decodifica, com cache. Sonda o CORS **antes** do download completo,
   * e só na primeira vez de cada URL — o cache já é a prova de que aquela deu
   * certo.
   */
  async load(sourceRef: string): Promise<AudioBuffer> {
    const cached = this.cache.get(sourceRef);
    if (cached) {
      // LRU pobre: reinserir põe no fim da ordem de iteração do `Map`.
      this.cache.delete(sourceRef);
      this.cache.set(sourceRef, cached);
      return cached;
    }

    const output = this.getOutput();
    if (!output) throw new SoundboardError('no-audio-context');

    if (!(await this.probe(sourceRef))) throw new SoundboardError('cors');

    let raw: ArrayBuffer;
    try {
      const res = await this.fetchImpl(sourceRef, { mode: 'cors', cache: 'default' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.arrayBuffer();
    } catch {
      throw new SoundboardError('fetch-failed');
    }

    let buffer: AudioBuffer;
    try {
      buffer = await output.context.decodeAudioData(raw);
    } catch {
      throw new SoundboardError('decode-failed');
    }

    this.cache.set(sourceRef, buffer);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return buffer;
  }

  /**
   * Lê e decodifica um `File` local, com cache. Não sonda CORS — o arquivo
   * está na máquina do usuário e não trafega pelo network stack.
   *
   * A chave de cache é `file:<nome>:<tamanho>`: boa o suficiente para evitar
   * redecodificação do mesmo arquivo na mesma sessão.
   */
  async loadFromFile(file: File): Promise<AudioBuffer> {
    const cacheKey = `file:${file.name}:${file.size}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      // LRU pobre: reinserir põe no fim da ordem de iteração do Map.
      this.cache.delete(cacheKey);
      this.cache.set(cacheKey, cached);
      return cached;
    }

    const output = this.getOutput();
    if (!output) throw new SoundboardError('no-audio-context');

    let raw: ArrayBuffer;
    try {
      raw = await file.arrayBuffer();
    } catch {
      throw new SoundboardError('fetch-failed');
    }

    let buffer: AudioBuffer;
    try {
      buffer = await output.context.decodeAudioData(raw);
    } catch {
      throw new SoundboardError('decode-failed');
    }

    this.cache.set(cacheKey, buffer);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return buffer;
  }

  /**
   * Quanto tempo o efeito vai durar de fato — a duração do áudio, cortada em
   * `MAX_SOUND_MS`. Vai no anúncio, e é o que dimensiona a janela de mute de
   * quem tiver silenciado quem disparou.
   */
  durationMsOf(buffer: AudioBuffer): number {
    const bruta = Number.isFinite(buffer.duration) ? buffer.duration * 1000 : 0;
    return Math.max(0, Math.min(MAX_SOUND_MS, Math.round(bruta)));
  }

  /**
   * Toca um buffer já decodificado. **Síncrono de propósito**: quem chama manda
   * o anúncio pelo data channel e chama isto no mesmo tique, para que o anúncio
   * ganhe a corrida contra o áudio (SCTP e SRTP têm latências diferentes).
   */
  start(buffer: AudioBuffer): FireResult {
    const output = this.getOutput();
    if (!output) throw new SoundboardError('no-audio-context');
    const ctx = output.context;

    this.stop();

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Ramo de rede: ganho configurável + compressor, para o efeito somado à
    // música não saturar do outro lado. Nunca no caminho do player.
    const networkGain = ctx.createGain();
    networkGain.gain.value = this.networkVolume;
    const compressor = ctx.createDynamicsCompressor();
    source.connect(networkGain);
    networkGain.connect(compressor);
    compressor.connect(output.destination);

    // …e o ramo de monitoração, sem o qual quem dispara é o único que não ouve
    // o próprio efeito (mesma armadilha do `createMediaElementSource`).
    if (!this.monitorGain) {
      this.monitorGain = ctx.createGain();
      this.monitorGain.gain.value = this.monitorVolume;
      this.monitorGain.connect(ctx.destination);
    }
    source.connect(this.monitorGain);

    const durationMs = this.durationMsOf(buffer);
    source.onended = () => {
      if (this.current === source) this.current = null;
      try {
        source.disconnect();
        networkGain.disconnect();
        compressor.disconnect();
      } catch {
        // já desconectado
      }
    };
    // O terceiro argumento é o corte em `MAX_SOUND_MS`: um efeito mais longo
    // que a janela para no fim dela, em vez de segurar o canal indefinidamente.
    source.start(0, 0, durationMs / 1000);
    this.current = source;
    return { durationMs };
  }

  /** Volume de monitoração: o que **quem dispara** ouve de si. Nunca trafega. */
  setMonitorVolume(value: unknown): void {
    const volume = Math.min(
      1,
      Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 1),
    );
    this.monitorVolume = volume;
    if (this.monitorGain) this.monitorGain.gain.value = volume;
  }

  /** Volume de saída para a sala. Aplicado no próximo disparo. */
  setNetworkVolume(value: unknown): void {
    this.networkVolume = Math.min(
      1,
      Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 1),
    );
  }

  /** Corta o efeito corrente. Um disparo novo chama isto antes de começar. */
  stop(): void {
    const source = this.current;
    this.current = null;
    if (!source) return;
    try {
      source.stop();
    } catch {
      // já parou ou nunca começou
    }
    try {
      source.disconnect();
    } catch {
      // já desconectado
    }
  }

  /**
   * Solta tudo o que é deste tocador. **Não** toca no destination do canal de
   * música: ele é do `MusicEngine`, e pará-lo aqui mataria a música da sala em
   * silêncio (ver `ensureOutput`).
   */
  destroy(): void {
    this.stop();
    this.destroyed = true;
    this.cache.clear();
    try {
      this.monitorGain?.disconnect();
    } catch {
      // já desconectado
    }
    this.monitorGain = null;
  }
}
