/**
 * O lado do áudio do motor: **um** `AudioContext`, **um** `MusicEngine`, **um**
 * `SoundboardPlayer` — e um `MediaStreamDestination` só, que é o canal de música
 * que vai para a sala.
 *
 * Os dois módulos vêm de `packages/client/src/lib/` por import relativo, sem
 * cópia: copiar produz divergência, e este repositório já pagou por isso uma vez
 * (`planAdvance` duplicado, registrado no §7 do `ARCHITECTURE.md`).
 *
 * O `AudioContext` nasce no boot e **não é fechado** enquanto o motor viver —
 * mesma regra de `lib/audioContext.ts` no app, e pelo mesmo motivo: nós de
 * contextos diferentes não se conectam, então um contexto novo por faixa faria o
 * soundboard e o player pararem de se encontrar no mesmo destination.
 * `contextCount` existe para que isso seja **verificável de fora**: o E2E abre N
 * abas, dispara efeitos e confere que o número continua `1`.
 *
 * A assimetria entre música e efeito é proposital e tem razão física: o
 * `MusicEngine` depende de um `<audio crossOrigin="anonymous">`, que fica
 * *tainted* quando o host não manda CORS — e o `MediaStreamDestination` passa a
 * emitir silêncio digital, sem erro nenhum. Por isso a sonda `Range: bytes=0-0`
 * é porteiro aqui (`probe`), e a recusa é visível (§11.8).
 */

import { MusicEngine } from '../../../client/src/lib/musicEngine.js';
import { SoundboardPlayer, SoundboardError } from '../../../client/src/lib/soundboardPlayer.js';
import { loadAudioFile } from '../../../client/src/lib/audioFileStorage.js';
import type { QueueEntry } from '../../../client/src/lib/musicSession.js';
import type { Favorite } from '../../../client/src/lib/soundboard.js';

import type { AudioSide, SoundHandle } from './core.js';

/** O efeito decodificado, embrulhado no formato que o motor troca com a UI. */
interface DecodedSound extends SoundHandle {
  buffer: AudioBuffer;
}

export interface ExtensionAudioOptions {
  /** Como o motor descobre o `fileId` (IndexedDB) de uma entrada de arquivo. */
  fileIdOf: (entryId: string) => string | null;
  onEnded: () => void;
  onError: (reason: string) => void;
  onBlocked: () => void;
}

export class ExtensionAudio implements AudioSide {
  private context: AudioContext | null = null;
  private contexts = 0;
  private engine: MusicEngine;
  private sound: SoundboardPlayer | null = null;
  /** Medidor do que sai para a sala. Ver `EngineState.outputLevel`. */
  private meter: AnalyserNode | null = null;
  // O parâmetro de tipo é exigência do `lib.dom` novo: `getByteTimeDomainData`
  // recusa um `Uint8Array<ArrayBufferLike>`, que é o que `new Uint8Array(n)`
  // infere quando o alvo não diz o contrário.
  private meterBuffer: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(0));
  private options: ExtensionAudioOptions;

  constructor(options: ExtensionAudioOptions) {
    this.options = options;
    this.engine = new MusicEngine({
      getContext: () => this.ensureContext(),
      onEnded: () => this.options.onEnded(),
      onError: ({ reason }) => this.options.onError(reason),
      onBlocked: () => this.options.onBlocked(),
    });
  }

  /**
   * O contexto único. `contexts` só é incrementado aqui, e esse é o ponto: um
   * segundo motor em outra aba apareceria como `2` no estado.
   */
  private ensureContext(): AudioContext {
    if (!this.context) {
      this.context = new AudioContext();
      this.contexts += 1;
    }
    return this.context;
  }

  audioContextCount(): number {
    return this.contexts;
  }

  audioState(): 'none' | 'running' | 'suspended' | 'closed' {
    const estado = this.context?.state;
    // `interrupted` existe no iOS e não tem equivalente no que a UI mostra; ele
    // é lido como `suspended`, que é o que ele significa para quem ouve.
    if (!estado) return 'none';
    if (estado === 'running' || estado === 'closed') return estado;
    return 'suspended';
  }

  /**
   * Garante o grafo de saída e devolve o track do canal de música — o que vai
   * para `mesh.setMusicTrack`, uma vez só, na entrada da sala.
   */
  musicTrack(): MediaStreamTrack | null {
    // O grafo primeiro, o medidor depois: atar o track é o que a sala depende, e
    // nada do diagnóstico pode ficar no caminho disso.
    this.engine.ensureOutput();
    const track = this.engine.track;
    this.ensureMeter();
    return track;
  }

  /**
   * Liga o medidor ao **stream** do destination, e não ao nó.
   *
   * `MediaStreamAudioDestinationNode` é terminal: ele tem entrada e **zero
   * saídas**, então `destination.connect(analyser)` não mede nada (na melhor das
   * hipóteses é no-op; na pior, lança). O que se quer medir é o que a sala
   * recebe — e isso é o `stream` dele, relido por um
   * `MediaStreamAudioSourceNode`.
   */
  private ensureMeter(): void {
    if (this.meter) return;
    const output = this.engine.ensureOutput();
    if (!output) return;
    try {
      const fonte = output.context.createMediaStreamSource(output.destination.stream);
      const analisador = output.context.createAnalyser();
      analisador.fftSize = 1024;
      fonte.connect(analisador);
      this.meter = analisador;
      this.meterBuffer = new Uint8Array(new ArrayBuffer(analisador.fftSize));
    } catch {
      // Medidor é diagnóstico: se o navegador recusar, o motor continua tocando.
      this.meter = null;
    }
  }

  outputLevel(): number {
    this.ensureMeter();
    if (!this.meter) return 0;
    this.meter.getByteTimeDomainData(this.meterBuffer);
    let pico = 0;
    for (const amostra of this.meterBuffer) pico = Math.max(pico, Math.abs(amostra - 128));
    return Number((pico / 128).toFixed(3));
  }

  /** O soundboard mixa no **mesmo** destination do player (§6.13 do app). */
  private ensureSoundboard(): SoundboardPlayer {
    if (!this.sound) {
      this.sound = new SoundboardPlayer({
        getOutput: () => this.engine.ensureOutput(),
      });
    }
    return this.sound;
  }

  setMonitorVolume(value: number): void {
    this.engine.setMonitorVolume(value);
    this.ensureSoundboard().setMonitorVolume(value);
  }

  async probe(entry: Pick<QueueEntry, 'kind' | 'sourceRef'>): Promise<boolean> {
    return (await this.engine.probeDelivery(entry)) === 'stream';
  }

  async loadTrack(entry: QueueEntry): Promise<{ ok: true } | { ok: false; reason: string }> {
    let file: Blob | null = null;
    if (entry.kind === 'file') {
      // O `Blob` vem do IndexedDB da origem da extensão, e não de um object URL:
      // um `URL.createObjectURL` criado na página `manager` é revogado quando
      // aquele documento é descarregado, e o áudio pararia ao fechar a aba.
      const fileId = this.options.fileIdOf(entry.id);
      file = fileId ? await loadAudioFile(fileId) : null;
      if (!file) return { ok: false, reason: 'not-audio' };
    }
    const track = await this.engine.load(entry, { file, delivery: 'stream', asOwner: true });
    if (!track) return { ok: false, reason: 'unsupported' };
    return { ok: true };
  }

  async play(): Promise<boolean> {
    // O documento offscreen não tem gesto do usuário: o contexto pode nascer
    // `suspended`. Retomar a cada comando de transporte é a rede de segurança —
    // se o Chrome isentar páginas de extensão da política de autoplay, isto vira
    // no-op barato.
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    return this.engine.play();
  }

  pause(): void {
    this.engine.pause();
  }

  seek(positionSec: number): void {
    this.engine.seek(positionSec);
  }

  stopTrack(): void {
    this.engine.stop();
  }

  positionSec(): number {
    return this.engine.positionSec;
  }

  durationSec(): number | null {
    return this.engine.durationSec;
  }

  isPlaying(): boolean {
    return this.engine.playing;
  }

  async loadSound(favorite: Favorite): Promise<DecodedSound> {
    const player = this.ensureSoundboard();
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});

    let buffer: AudioBuffer;
    if (favorite.kind === 'file') {
      const file = favorite.fileId ? await loadAudioFile(favorite.fileId) : null;
      if (!file) throw new SoundboardError('fetch-failed');
      buffer = await player.loadFromFile(file);
    } else {
      // URL sem CORS cai aqui como `SoundboardError('cors')` — a mesma recusa
      // com mensagem do app. É o caso do MyInstants (§11.8).
      buffer = await player.load(favorite.sourceRef);
    }
    return { buffer, durationMs: player.durationMsOf(buffer) };
  }

  startSound(handle: SoundHandle): { durationMs: number } {
    return this.ensureSoundboard().start((handle as DecodedSound).buffer);
  }

  /** Desligamento do motor. O contexto morre junto — e só aqui. */
  destroy(): void {
    this.sound?.destroy();
    this.sound = null;
    this.engine.destroy();
    void this.context?.close().catch(() => {});
    this.context = null;
  }
}
