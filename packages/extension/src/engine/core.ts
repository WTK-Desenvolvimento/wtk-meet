/**
 * O motor — a única verdade sobre fila, faixa corrente, favoritos e rate limit.
 *
 * Mora no documento offscreen, que o Chrome garante ser **um só por extensão**:
 * essa restrição de plataforma é exatamente a propriedade que o produto quer
 * (uma fila, um player, um soundboard, um `AudioContext`, não importa quantas
 * abas estejam abertas). Ver `ARCHITECTURE.md` §11.3.
 *
 * **Esta classe não toca em DOM, em `chrome.*` nem em rede.** Áudio e sala
 * entram por duas interfaces injetadas (`AudioSide` e `RoomSide`), e o storage
 * por um `PreferenceStorage` — o mesmo contrato que `lib/soundboard.ts` do
 * client já pede. É o que permite exercitar em `node --test`, sem navegador, as
 * três propriedades que o DoD desta entrega cobra:
 *
 * - N abas veem o mesmo estado (o `UiHub` espelha; o teste conecta portas dublê);
 * - N abas disparando produzem **uma** reprodução (`playCount`);
 * - o rate limit é **um só**: três disparos vindos de três abas consomem a mesma
 *   janela de 5s, e não três janelas independentes.
 *
 * O que **não** está aqui, de propósito: o protocolo colaborativo `music-*`. A
 * extensão é produtora de áudio, não co-autora da sessão da sala — o app toca o
 * canal de música de qualquer peer sem votação e sem painel aberto, então zero
 * mensagem é necessária para a sala ouvir. A única que sai é o anúncio
 * `soundboard-play` (§11.5 do `ARCHITECTURE.md`).
 */

import {
  SOUNDBOARD_ERRORS,
  addFavorite,
  readSoundboard,
  removeFavorite,
  renameFavorite,
  writeSoundboard,
} from '../../../client/src/lib/soundboard.js';
import type { Favorite, PreferenceStorage } from '../../../client/src/lib/soundboard.js';
import { consume, createRateState, retryInMs } from '../../../client/src/lib/soundboardRate.js';
import type { RateState } from '../../../client/src/lib/soundboardRate.js';
import { SOURCE_ERRORS, parseSource } from '../../../client/src/lib/musicSources.js';
import {
  addEntry,
  createSession,
  entryById,
  nextEntry,
  orderedQueue,
  removeEntry,
  sanitizeEntry,
} from '../../../client/src/lib/musicSession.js';
import type { MusicSession, QueueEntry } from '../../../client/src/lib/musicSession.js';
import { soundboardPlayMessage } from '../../../client/src/lib/musicProtocol.js';
import type { MusicMessage } from '../../../client/src/lib/musicProtocol.js';
import { isValidRoomPath, normalizeRoomPath } from '../../../client/src/lib/roomSlug.js';

import { UiHub, diffState } from '../lib/hub.js';
import type { PortLike } from '../lib/hub.js';
import { emptyState } from '../lib/protocol.js';
import type {
  EngineCommand,
  EnginePeer,
  EnginePendingJoin,
  EngineState,
  EngineStatus,
} from '../lib/protocol.js';

/**
 * Quem adiciona faixa na fila da extensão é sempre o motor. O campo existe
 * porque `sanitizeEntry` exige autoria — e na sala a autoria de verdade é a
 * conexão por onde a mensagem chegou, não este texto.
 */
const SELF_AUTHOR = 'extension';

/** Teto de tempo da sonda de CORS. Ver o uso, em `queueAdd`. */
const PROBE_TIMEOUT_MS = 8_000;

/** Um efeito já baixado e decodificado. Opaco: só o motor de áudio olha dentro. */
export interface SoundHandle {
  durationMs: number;
}

/** Tudo que o motor precisa do lado do áudio — implementado em `offscreen.ts`. */
export interface AudioSide {
  /**
   * Quantos `AudioContext` este processo criou. Um motor bem construído diz
   * `1` para sempre; é o número que o E2E compara depois de abrir N abas.
   */
  audioContextCount(): number;
  /** `suspended` é silêncio digital para a sala — ver `EngineState.audioState`. */
  audioState(): 'none' | 'running' | 'suspended' | 'closed';
  /** Pico recente do sinal que vai para a sala (0..1) — ver `outputLevel`. */
  outputLevel(): number;
  setMonitorVolume(value: number): void;
  /** A URL libera CORS? `false` significa "a sala ouviria silêncio". */
  probe(entry: Pick<QueueEntry, 'kind' | 'sourceRef'>): Promise<boolean>;
  /** Carrega a faixa (arquivo vem do IndexedDB, por `fileId`). */
  loadTrack(entry: QueueEntry): Promise<{ ok: true } | { ok: false; reason: string }>;
  play(): Promise<boolean>;
  pause(): void;
  seek(positionSec: number): void;
  stopTrack(): void;
  positionSec(): number;
  durationSec(): number | null;
  isPlaying(): boolean;
  /** Baixa e decodifica um efeito. Rejeita com `{ reason }` conhecido. */
  loadSound(favorite: Favorite): Promise<SoundHandle>;
  /** Toca o efeito. **Síncrono**: o anúncio sai no mesmo tique. */
  startSound(handle: SoundHandle): { durationMs: number };
}

/** Tudo que o motor precisa da sala. */
export interface RoomSide {
  connect(options: { roomPath: string; displayName: string }): void;
  disconnect(): void;
  /** Aprovação é **sempre** ato humano: o motor nunca decide sozinho (§11.6). */
  decideJoin(requesterId: string, approve: boolean): void;
  announce(message: MusicMessage): void;
}

export interface EngineCoreOptions {
  audio: AudioSide;
  room: RoomSide;
  storage: PreferenceStorage;
  /** Relógio monotônico injetado — o rate limit não olha `Date.now()`. */
  now?: () => number;
  /** Identidade desta instância. Ver `EngineState.engineId`. */
  engineId?: string;
  /** Chamado quando o badge do ícone precisa mudar (o motor não tem `action`). */
  onBadge?: (badge: { pending: number; playing: boolean; title: string }) => void;
}

export class EngineCore {
  private audio: AudioSide;
  private room: RoomSide;
  private storage: PreferenceStorage;
  private now: () => number;
  private onBadge: EngineCoreOptions['onBadge'];

  private hub = new UiHub();
  private state: EngineState;
  /** O estado do último `publish` — base do delta. */
  private published: EngineState;
  private session: MusicSession = createSession();
  /** A janela do rate limit. **Uma só**, para todas as abas (§11.5). */
  private rate: RateState = createRateState();
  private lamport = 0;
  private seq = 0;

  constructor({ audio, room, storage, now, engineId = '', onBadge }: EngineCoreOptions) {
    this.audio = audio;
    this.room = room;
    this.storage = storage;
    this.now = now ?? (() => Date.now());
    this.onBadge = onBadge;
    this.state = emptyState(engineId);
    this.published = { ...this.state };
  }

  /** Lê favoritos do storage já hidratado. Chamado uma vez, no boot do motor. */
  init(): void {
    this.state.favorites = [...readSoundboard(this.storage).favorites];
    this.published = { ...this.state };
  }

  /** Só leitura — a UI e os testes olham, ninguém escreve por aqui. */
  snapshot(): EngineState {
    return { ...this.state };
  }

  get viewers(): number {
    return this.hub.size;
  }

  // ----------------------------------------------------------------- portas

  /**
   * Uma superfície de UI chegou. Recebe o estado **inteiro** na hora: uma aba
   * que abre no meio de uma faixa não consegue montar a tela a partir de um
   * delta.
   */
  attach(port: PortLike): void {
    this.refreshDerived();
    this.hub.attach(port, this.snapshot());
  }

  detach(port: PortLike): void {
    this.hub.detach(port);
  }

  // --------------------------------------------------------------- comandos

  /**
   * O ponto de entrada de tudo que a UI pede. Devolve uma promessa para que os
   * testes (e o `offscreen.ts`) possam esperar o efeito — mas nada na UI depende
   * dessa espera: o resultado sempre volta como estado ou como `notice`.
   */
  async handleCommand(command: EngineCommand, port?: PortLike | null): Promise<void> {
    this.state.lastCommand = command.type;
    switch (command.type) {
      case 'connect':
        return this.connect(command.roomPath, command.displayName, port);
      case 'disconnect':
        return this.disconnect();
      case 'queue-add':
        return this.queueAdd(command.source, port);
      case 'queue-remove':
        return this.queueRemove(command.entryId);
      case 'transport':
        return this.transport(command.action, command.positionSec);
      case 'volume':
        this.audio.setMonitorVolume(command.value);
        this.state.volume = Math.min(1, Math.max(0, command.value));
        return this.publish();
      case 'soundboard-fire':
        return this.fire(command.favoriteId, port);
      case 'favorite-add':
        return this.favoriteAdd(command.input, port);
      case 'favorite-remove':
        this.commitFavorites(removeFavorite(this.prefs(), command.favoriteId));
        return this.publish();
      case 'favorite-rename':
        this.commitFavorites(renameFavorite(this.prefs(), command.favoriteId, command.title));
        return this.publish();
      case 'join-decision':
        this.room.decideJoin(command.requesterId, command.approve);
        this.state.pendingJoins = this.state.pendingJoins.filter(
          (join) => join.requesterId !== command.requesterId,
        );
        return this.publish();
    }
  }

  // ------------------------------------------------------------------- sala

  private async connect(roomPath: string, displayName: string, port?: PortLike | null): Promise<void> {
    const path = normalizeRoomPath(roomPath);
    if (!isValidRoomPath(path)) {
      this.hub.notice('error', 'Esse id de sala não serve — use letras, números e hífen.', port);
      return;
    }
    this.state.roomPath = path;
    this.state.displayName = displayName.trim().slice(0, 40) || 'Música (extensão)';
    this.state.status = 'connecting';
    this.state.lastError = null;
    this.publish();
    this.room.connect({ roomPath: path, displayName: this.state.displayName });
  }

  private async disconnect(): Promise<void> {
    this.room.disconnect();
    this.state.status = 'idle';
    this.state.peers = [];
    this.state.pendingJoins = [];
    this.publish();
  }

  /** O status da sala, vindo do `RoomSide`. */
  setStatus(status: EngineStatus, detail?: string | null): void {
    this.state.status = status;
    if (detail !== undefined) this.state.lastError = detail;
    this.publish();
  }

  setPeers(peers: EnginePeer[]): void {
    this.state.peers = peers;
    this.publish();
  }

  /**
   * Pedidos de entrada pendentes. O motor **não responde** a nenhum: ele guarda,
   * pinta o badge e espera um clique humano. Um porteiro que aprova qualquer um
   * transformaria "sala com aprovação" em "sala aberta para quem adivinhar o
   * endereço" — e o endereço, aqui, é derivado do código da reunião.
   */
  setPendingJoins(pending: EnginePendingJoin[]): void {
    this.state.pendingJoins = pending;
    this.publish();
  }

  // ------------------------------------------------------------------ fila

  private async queueAdd(
    source: { kind: 'url'; sourceRef: string } | { kind: 'file'; fileId: string; title: string },
    port?: PortLike | null,
  ): Promise<void> {
    let entry: QueueEntry | null;

    if (source.kind === 'file') {
      // O conteúdo já está no IndexedDB da origem da extensão (quem gravou foi a
      // página `manager`). O que anda entre contextos é o `fileId`: `File` e
      // `Blob` não atravessam mensagem de extensão, e um object URL morre com o
      // documento que o criou.
      entry = sanitizeEntry(
        {
          id: this.nextId(),
          kind: 'file',
          title: source.title || 'Arquivo',
          sourceRef: '',
          lamport: ++this.lamport,
          addedByName: 'Extensão',
          // `fileId` não faz parte de `QueueEntry`; ele viaja no id da entrada
          // (ver `fileIdOf`), que é o que mantém o módulo do client intocado.
        },
        { addedBy: SELF_AUTHOR },
      );
      if (entry) this.fileIds.set(entry.id, source.fileId);
    } else {
      // `allowYouTube: false`, e não é preguiça: MV3 proíbe código hospedado
      // remotamente (a IFrame API do YouTube é exatamente isso), e a entrega do
      // YouTube é `local` — cada participante toca o vídeo na própria máquina,
      // o que um motor sozinho não pode fazer pela sala.
      const parsed = parseSource(source.sourceRef, { allowYouTube: false });
      if (!parsed.ok) {
        this.hub.notice('error', SOURCE_ERRORS[parsed.reason] ?? SOURCE_ERRORS.unsupported!, port);
        return;
      }
      // A sonda de CORS vem **antes** de a faixa entrar na fila. Sem ela, o
      // clique "funciona" aqui (a monitoração toca) e a sala recebe silêncio
      // digital, sem erro em lugar nenhum. No app há o modo `local` como plano
      // B; aqui não há — o motor é a única máquina, e tocar local é tocar para
      // ninguém.
      // Com teto de tempo: um `fetch` que nunca resolve (host que aceita a
      // conexão e não responde) deixaria o "adicionar" pendurado para sempre —
      // sem fila, sem mensagem, sem nada para olhar.
      const sonda = await Promise.race([
        this.audio.probe({ kind: 'url', sourceRef: parsed.sourceRef }),
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), PROBE_TIMEOUT_MS)),
      ]);
      if (sonda !== true) {
        this.hub.notice(
          'error',
          sonda === 'timeout' ? SOUNDBOARD_ERRORS['fetch-failed']! : SOUNDBOARD_ERRORS.cors!,
          port,
        );
        return;
      }
      entry = sanitizeEntry(
        {
          id: this.nextId(),
          kind: parsed.kind,
          title: parsed.title,
          sourceRef: parsed.sourceRef,
          lamport: ++this.lamport,
          addedByName: 'Extensão',
        },
        { addedBy: SELF_AUTHOR },
      );
    }

    if (!entry) {
      this.hub.notice('error', SOURCE_ERRORS.unsupported!, port);
      return;
    }

    const result = addEntry(this.session, entry);
    this.session = result.session;
    if (!result.ok) {
      this.hub.notice('error', SOURCE_ERRORS[result.reason ?? 'unsupported'] ?? SOURCE_ERRORS.unsupported!, port);
      return;
    }

    this.publish();
    // Fila parada ganha faixa: começa a tocar. É o comportamento que quem clica
    // "adicionar" espera, e o único que faz sentido num motor sem tela.
    if (!this.state.current) await this.playEntry(entry);
  }

  private async queueRemove(entryId: string): Promise<void> {
    // Remover a corrente é pular: quem tira a entrada da fila é o `advance()`.
    // Tirá-la antes deixaria `advance()` procurando o sucessor de um id que a
    // fila já não tem — `nextEntry` devolve `null` para id desconhecido, e o
    // motor concluiria "acabou a fila" com faixas nela, em silêncio.
    if (this.state.current?.entryId === entryId) return this.advance();
    this.session = removeEntry(this.session, entryId);
    this.fileIds.delete(entryId);
    this.publish();
  }

  private async transport(action: 'play' | 'pause' | 'skip' | 'seek', positionSec?: number): Promise<void> {
    switch (action) {
      case 'play': {
        if (!this.state.current) {
          const first = orderedQueue(this.session)[0];
          if (first) return this.playEntry(first);
          return;
        }
        const ok = await this.audio.play();
        if (!ok) {
          // A política de autoplay recusou. Sem isto o sintoma é "não toca e
          // ninguém sabe por quê" — o documento offscreen não tem gesto do
          // usuário para oferecer.
          this.hub.notice('error', 'O navegador bloqueou a reprodução — clique de novo em tocar.');
        }
        break;
      }
      case 'pause':
        this.audio.pause();
        break;
      case 'seek':
        if (typeof positionSec === 'number') this.audio.seek(positionSec);
        break;
      case 'skip':
        return this.advance();
    }
    this.publish();
  }

  /** Carrega e toca uma entrada. Recusa com mensagem — nunca com silêncio. */
  private async playEntry(entry: QueueEntry): Promise<void> {
    const loaded = await this.audio.loadTrack(entry);
    if (!loaded.ok) {
      this.hub.notice('error', SOURCE_ERRORS[loaded.reason] ?? 'Não consegui tocar essa faixa.');
      this.session = removeEntry(this.session, entry.id);
      this.fileIds.delete(entry.id);
      this.currentEntryId = null;
      // Publica antes de seguir para que `advance()` leia `current = null` e
      // pegue o topo da fila: uma URL podre custa a própria faixa, não o resto
      // da playlist. Termina porque cada recusa encurta a fila.
      this.publish();
      return this.advance();
    }
    this.currentEntryId = entry.id;
    await this.audio.play();
    this.publish();
  }

  /** A faixa terminou (ou foi pulada): sai da fila e a próxima entra. */
  async advance(): Promise<void> {
    const atual = this.state.current?.entryId ?? null;
    const proxima = atual ? nextEntry(this.session, atual) : orderedQueue(this.session)[0] ?? null;
    if (atual) {
      this.session = removeEntry(this.session, atual);
      this.fileIds.delete(atual);
    }
    this.audio.stopTrack();
    this.currentEntryId = null;
    if (proxima) return this.playEntry(proxima);
    this.publish();
  }

  /** Um erro do player sobre a faixa corrente. */
  onTrackError(reason: string): void {
    this.hub.notice('error', SOURCE_ERRORS[reason] ?? 'Não consegui tocar essa faixa.');
    void this.advance();
  }

  /** O `fileId` (IndexedDB) de uma entrada de arquivo, se houver. */
  fileIdOf(entryId: string): string | null {
    return this.fileIds.get(entryId) ?? null;
  }

  private fileIds = new Map<string, string>();

  // ------------------------------------------------------------- soundboard

  /**
   * Dispara um efeito: consome a vaga, baixa, **anuncia** e toca — nesta ordem,
   * a mesma do app.
   *
   * A vaga é consumida **antes** do `await`, e isso é o que faz o limite ser
   * global de verdade: três cliques vindos de três abas diferentes, no mesmo
   * tique, passariam todos por uma checagem feita depois do download. O anúncio
   * sai antes do `start`, no mesmo tique, porque ele viaja por SCTP e o áudio
   * por SRTP — anunciar depois faria o mute de quem silenciou perder a corrida.
   */
  private async fire(favoriteId: string, port?: PortLike | null): Promise<void> {
    const favorite = this.state.favorites.find((item) => item.id === favoriteId);
    if (!favorite) {
      this.hub.notice('error', SOUNDBOARD_ERRORS.unsupported!, port);
      return;
    }

    const agora = this.now();
    const decision = consume(this.rate, agora);
    if (!decision.allowed) {
      this.state.cooldownMs = decision.retryInMs;
      this.publish();
      this.hub.notice('error', SOUNDBOARD_ERRORS['rate-limited']!, port);
      return;
    }
    this.rate = decision.state;
    this.state.cooldownMs = decision.retryInMs;
    this.publish();

    let handle: SoundHandle;
    try {
      handle = await this.audio.loadSound(favorite);
    } catch (err) {
      const reason = err && typeof err === 'object' && 'reason' in err ? String(err.reason) : 'fetch-failed';
      this.hub.notice('error', SOUNDBOARD_ERRORS[reason] ?? SOUNDBOARD_ERRORS['fetch-failed']!, port);
      return;
    }

    // Anúncio e `start` no mesmo tique — nada de `await` entre os dois.
    const durationMs = handle.durationMs;
    this.room.announce(
      soundboardPlayMessage({ soundId: favorite.id, title: favorite.title, durationMs }),
    );
    try {
      this.audio.startSound(handle);
    } catch {
      this.hub.notice('error', SOUNDBOARD_ERRORS['fetch-failed']!, port);
      return;
    }
    this.state.playCount += 1;
    this.publish();
  }

  /** Quanto falta para o próximo disparo caber. Chamado pelo tique do motor. */
  refreshCooldown(): void {
    this.state.cooldownMs = retryInMs(this.rate, this.now());
    this.publish();
  }

  // -------------------------------------------------------------- favoritos

  private prefs() {
    return readSoundboard(this.storage);
  }

  private commitFavorites(next: ReturnType<typeof readSoundboard>): void {
    const efetivo = writeSoundboard(this.storage, next);
    this.state.favorites = [...efetivo.favorites];
  }

  private async favoriteAdd(input: string, port?: PortLike | null): Promise<void> {
    const result = addFavorite(this.prefs(), input, { now: Date.now() });
    if (!result.ok) {
      this.hub.notice('error', SOUNDBOARD_ERRORS[result.reason ?? 'unsupported'] ?? SOUNDBOARD_ERRORS.unsupported!, port);
      return;
    }
    this.commitFavorites(result.prefs);
    this.publish();
  }

  /**
   * Outro contexto escreveu no `chrome.storage.local` — relê e espelha. É o que
   * mantém as abas com a mesma lista depois de uma edição na `manager`.
   */
  reloadFavorites(): void {
    this.state.favorites = [...readSoundboard(this.storage).favorites];
    this.publish();
  }

  // ------------------------------------------------------------- publicação

  /**
   * Recalcula o que é derivado (fila e faixa corrente saem da sessão e do
   * player, nunca de um espelho mantido à mão) e empurra **só o delta**.
   */
  private refreshDerived(): void {
    this.state.queue = orderedQueue(this.session).map((entry) => ({
      entryId: entry.id,
      title: entry.title,
      kind: entry.kind === 'file' ? 'file' : 'url',
      durationSec: entry.durationSec ?? 0,
    }));
    this.state.audioContextCount = this.audio.audioContextCount();
    this.state.audioState = this.audio.audioState();
    this.state.outputLevel = this.audio.outputLevel();

    const corrente = this.currentEntryId;
    const entry = corrente ? entryById(this.session, corrente) : null;
    this.state.current = entry
      ? {
          entryId: entry.id,
          title: entry.title,
          positionSec: this.audio.positionSec(),
          durationSec: this.audio.durationSec() ?? entry.durationSec ?? 0,
          playing: this.audio.isPlaying(),
        }
      : null;
  }

  /** Quem é a faixa corrente, do ponto de vista do lado de áudio. */
  private currentEntryId: string | null = null;

  /** O `offscreen.ts` avisa quando o player trocou de faixa. */
  setCurrentEntry(entryId: string | null): void {
    this.currentEntryId = entryId;
    this.publish();
  }

  /** Recalcula, emite o delta e atualiza o badge. Barato quando nada mudou. */
  publish(): void {
    this.refreshDerived();
    const patch = diffState(this.published, this.state);
    if (patch) {
      this.published = { ...this.state };
      this.hub.broadcast(patch);
      this.badge();
    }
  }

  private badge(): void {
    this.onBadge?.({
      pending: this.state.pendingJoins.length,
      playing: !!this.state.current?.playing,
      title: this.state.current?.playing ? `Tocando: ${this.state.current.title}` : '',
    });
  }

  private nextId(): string {
    this.seq += 1;
    return `ext-${this.seq}-${Math.random().toString(36).slice(2, 8)}`;
  }
}
