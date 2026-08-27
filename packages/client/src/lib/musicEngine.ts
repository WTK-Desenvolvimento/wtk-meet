/**
 * Motor de reprodução de uma faixa — a única parte do player que toca em DOM e
 * WebAudio (o estado, esse, mora no módulo puro `musicSession.js`).
 *
 * Duas formas de entrega, e a escolha entre elas não é preferência:
 *
 * - **`stream`** — o áudio decodificado sobe pelo canal de música do mesh e todo
 *   mundo ouve o que sai da máquina de quem adicionou a faixa. É a **única**
 *   possibilidade para arquivo local (ninguém mais tem o arquivo) e a preferida
 *   para URL, quando o host manda CORS.
 *   Grafo: `<audio>` → `MediaElementSource` → ganho → `MediaStreamDestination`
 *   (rede) **e** → ganho de monitoração → `destination` (alto-falante do dono).
 * - **`local`** — cada client baixa a mesma URL pública e toca por conta,
 *   sincronizado por posição. É o caminho quando a URL não tem CORS.
 *
 * Três armadilhas que este arquivo existe para evitar:
 *
 * 1. **`createMediaElementSource` desconecta o elemento da saída padrão.** Sem o
 *    ramo explícito de monitoração, o dono da faixa é o **único** que não ouve a
 *    própria música. Como todos os outros ouvem, o bug é reportado como "só eu
 *    não escuto" e a causa não está em lugar nenhum perto do sintoma.
 * 2. **Mídia cross-origin sem CORS produz silêncio digital, sem erro.** O grafo
 *    fica "tainted" e o `MediaStreamDestination` emite silêncio — nenhuma
 *    exceção, nenhum log. Daí a sonda de `Range: bytes=0-0` **antes** de tocar, e
 *    daí o modo `local` nunca usar WebAudio: no modo `local` o elemento toca
 *    direto na saída padrão, que é o que sempre funciona.
 * 3. **`crossOrigin` só tem efeito antes de `src`.** Depois não adianta. Por isso
 *    cada faixa nasce num elemento novo, em vez de reaproveitar um só.
 *
 * O `MediaStreamDestination` é criado **uma vez** e vive enquanto o motor vive:
 * assim o track que vai para o mesh tem identidade estável e trocar de faixa não
 * exige `replaceTrack` em todas as conexões.
 */

/** Uma faixa que não carrega em 20s não vai carregar. */
import type { Delivery, QueueEntry } from './musicSession.js';

const LOAD_TIMEOUT_MS = 20_000;

/** O que o motor reporta de errado, e sobre qual entrada. */
export interface MusicEngineError {
  reason: string;
  entryId: string;
}

export interface MusicEngineOptions {
  getContext?: () => AudioContext | null;
  onEnded?: (entryId: string) => void;
  onDurationKnown?: (entryId: string, durationSec: number) => void;
  onError?: (erro: MusicEngineError) => void;
  onBlocked?: () => void;
}

export class MusicEngine {
  getContext: (() => AudioContext | null) | undefined;
  onEnded: ((entryId: string) => void) | undefined;
  onDurationKnown: ((entryId: string, durationSec: number) => void) | undefined;
  onError: ((erro: MusicEngineError) => void) | undefined;
  onBlocked: (() => void) | undefined;

  /** Saída para o mesh. */
  destination: MediaStreamAudioDestinationNode | null;
  /** Ramo de monitoração local do dono. */
  monitorGain: GainNode | null;
  /** `<audio>` da faixa corrente. */
  element: HTMLAudioElement | null;
  /** `MediaElementSource` da faixa corrente. */
  source: MediaElementAudioSourceNode | null;
  entryId: string | null;
  delivery: Delivery;
  objectUrl: string | null;
  destroyed: boolean;
  monitorVolume: number;

  constructor({ getContext, onEnded, onDurationKnown, onError, onBlocked }: MusicEngineOptions = {}) {
    this.getContext = getContext;
    this.onEnded = onEnded;
    this.onDurationKnown = onDurationKnown;
    this.onError = onError;
    this.onBlocked = onBlocked;

    this.destination = null;
    this.monitorGain = null;
    this.element = null;
    this.source = null;
    this.entryId = null;
    this.delivery = 'stream';
    this.objectUrl = null;
    this.destroyed = false;
    this.monitorVolume = 1;
  }

  // ------------------------------------------------------------------- grafo

  _ensureGraph(): AudioContext | null {
    const ctx = this.getContext?.();
    if (!ctx) return null;
    if (!this.destination) {
      this.destination = ctx.createMediaStreamDestination();
      this.monitorGain = ctx.createGain();
      this.monitorGain.gain.value = this.monitorVolume;
      this.monitorGain.connect(ctx.destination);
    }
    return ctx;
  }

  /** O track que vai para `mesh.setMusicTrack`. `null` enquanto não há grafo. */
  get track(): MediaStreamTrack | null {
    return this.destination?.stream.getAudioTracks()[0] || null;
  }

  /**
   * Volume que **o dono** ouve da própria música (monitoração), e o volume da
   * reprodução no modo `local`. Nunca trafega: cada um ouve o que quiser.
   */
  setMonitorVolume(value: unknown): void {
    const volume = Math.min(
      1,
      Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 1),
    );
    this.monitorVolume = volume;
    if (this.monitorGain) this.monitorGain.gain.value = volume;
    if (this.element && this.delivery === 'local') this.element.volume = volume;
  }

  // -------------------------------------------------------------------- CORS

  /**
   * A URL deixa capturar o áudio? Só quem responde com `Access-Control-Allow-Origin`
   * deixa — e a resposta precisa vir **antes** de tocar, porque depois o sintoma
   * é silêncio sem erro. Um `Range` de um byte basta e não baixa a faixa inteira.
   */
  async probeDelivery(
    // Só os dois campos que a sonda olha, e não uma `QueueEntry` inteira: quem
    // chama a usa **antes** de a entrada existir, com o que acabou de ser colado.
    entry: Pick<QueueEntry, 'kind' | 'sourceRef'> | null | undefined,
  ): Promise<Delivery> {
    if (!entry) return 'stream';
    if (entry.kind === 'file') return 'stream'; // o arquivo é local: só há esse caminho
    if (entry.kind !== 'url') return 'local';
    try {
      const res = await fetch(entry.sourceRef, {
        method: 'GET',
        headers: { Range: 'bytes=0-0' },
        mode: 'cors',
        cache: 'no-store',
      });
      return res.ok || res.status === 206 ? 'stream' : 'local';
    } catch {
      // Erro de CORS, host fora do ar, mixed content — em qualquer caso a
      // captura não vai funcionar, e tocar local é melhor que tocar silêncio.
      return 'local';
    }
  }

  // ------------------------------------------------------------------- faixa

  /**
   * Prepara uma faixa. `file` é obrigatório para `kind: 'file'` (e só existe na
   * máquina de quem adicionou). `asOwner` distingue quem transmite de quem
   * apenas reproduz a mesma URL em modo `local`.
   */
  async load(
    entry: QueueEntry | null | undefined,
    {
      file = null,
      delivery = 'stream',
      asOwner = true,
    }: { file?: Blob | null; delivery?: Delivery; asOwner?: boolean } = {},
  ): Promise<MediaStreamTrack | null> {
    this.stop();
    if (this.destroyed || !entry) return null;

    let src: string;
    if (entry.kind === 'file') {
      if (!file) {
        this.onError?.({ reason: 'missing-file', entryId: entry.id });
        return null;
      }
      this.objectUrl = URL.createObjectURL(file);
      src = this.objectUrl;
    } else if (entry.kind === 'url') {
      src = entry.sourceRef;
    } else {
      // YouTube não passa por aqui: o áudio dele vive num iframe cross-origin,
      // fora do alcance de qualquer API de captura (ver `youtubePlayer.js`).
      this.onError?.({ reason: 'unsupported-kind', entryId: entry.id });
      return null;
    }

    const element = new Audio();
    element.preload = 'auto';
    // `blob:` é same-origin; pedir CORS nele não faz sentido e alguns navegadores
    // reclamam. Para URL remota em modo `stream`, isto vem **antes** do `src`.
    if (delivery === 'stream' && entry.kind === 'url') element.crossOrigin = 'anonymous';
    element.src = src;

    this.element = element;
    this.entryId = entry.id;
    this.delivery = delivery;

    element.addEventListener('ended', () => {
      if (this.entryId === entry.id) this.onEnded?.(entry.id);
    });
    element.addEventListener('error', () => {
      if (this.entryId === entry.id) this.onError?.({ reason: 'media-error', entryId: entry.id });
    });
    element.addEventListener('durationchange', () => {
      if (Number.isFinite(element.duration) && element.duration > 0) {
        this.onDurationKnown?.(entry.id, element.duration);
      }
    });

    if (delivery === 'stream' && asOwner) {
      const ctx = this._ensureGraph();
      if (!ctx) {
        this.onError?.({ reason: 'no-audio-context', entryId: entry.id });
        return null;
      }
      try {
        this.source = ctx.createMediaElementSource(element);
        // `_ensureGraph` acabou de garantir os dois nós; o `!` só diz isso ao
        // compilador, que não acompanha o efeito colateral do método.
        this.source.connect(this.destination!);
        // …e o ramo de monitoração, sem o qual o dono é o único que não ouve.
        this.source.connect(this.monitorGain!);
      } catch (err) {
        console.warn('[music] createMediaElementSource falhou:', err);
        this.onError?.({ reason: 'graph-error', entryId: entry.id });
        return null;
      }
    } else {
      // Modo `local` (ou ouvinte): o elemento toca direto na saída padrão. Nada
      // de WebAudio aqui — é exatamente o caminho que o taint de CORS quebraria.
      element.volume = this.monitorVolume;
    }

    await this._waitReady(element);
    return this.track;
  }

  _waitReady(element: HTMLAudioElement): Promise<void> {
    if (element.readyState >= 1) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        element.removeEventListener('loadedmetadata', done);
        element.removeEventListener('error', done);
        resolve();
      };
      const timer = setTimeout(done, LOAD_TIMEOUT_MS);
      element.addEventListener('loadedmetadata', done);
      element.addEventListener('error', done);
    });
  }

  // ---------------------------------------------------------------- comandos

  /**
   * `play()` devolve uma Promise que a política de autoplay **rejeita** quando
   * não houve gesto do usuário. Engolir essa rejeição é como o recurso vira
   * "não toca e ninguém sabe por quê": ela vira `onBlocked`, e a UI mostra um
   * aviso clicável.
   */
  async play(): Promise<boolean> {
    const element = this.element;
    if (!element) return false;
    try {
      const ctx = this.getContext?.();
      if (ctx?.state === 'suspended') await ctx.resume().catch(() => {});
      await element.play();
      return true;
    } catch {
      this.onBlocked?.();
      return false;
    }
  }

  pause(): void {
    this.element?.pause();
  }

  seek(positionSec: unknown): void {
    const element = this.element;
    if (!element || typeof positionSec !== 'number' || !Number.isFinite(positionSec)) return;
    try {
      element.currentTime = Math.max(0, positionSec);
    } catch {
      // seek antes dos metadados: o próximo `play` já começa do lugar certo
    }
  }

  get positionSec(): number {
    return this.element?.currentTime || 0;
  }

  get durationSec(): number | null {
    const value = this.element?.duration;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  }

  get playing(): boolean {
    return !!this.element && !this.element.paused && !this.element.ended;
  }

  /** Está engasgando? Corrigir posição durante buffering só piora a deriva. */
  get buffering(): boolean {
    return !!this.element && this.element.readyState < 3;
  }

  // ---------------------------------------------------------------- teardown

  /** Solta a faixa corrente. O grafo de saída **permanece**, e o track também. */
  stop(): void {
    const element = this.element;
    this.element = null;
    this.entryId = null;

    if (this.source) {
      try {
        this.source.disconnect();
      } catch {
        // já desconectado
      }
      this.source = null;
    }
    if (element) {
      element.pause();
      element.removeAttribute('src');
      try {
        element.load(); // solta o buffer de rede; sem isso o download continua
      } catch {
        // ignorar
      }
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  destroy(): void {
    this.stop();
    this.destroyed = true;
    try {
      this.monitorGain?.disconnect();
      this.destination?.disconnect();
    } catch {
      // já desconectado
    }
    for (const track of this.destination?.stream.getAudioTracks() || []) track.stop();
    this.destination = null;
    this.monitorGain = null;
  }
}
