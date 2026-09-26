/**
 * O contrato entre os três contextos da extensão: popup/`manager` (a UI), o
 * service worker (o roteador) e o documento offscreen (o motor).
 *
 * Módulo **puro** — só tipos, constantes e funções de decisão. Nada de
 * `chrome.*` aqui dentro, e é por isso que o roteamento tem teste em
 * `node --test` sem navegador nenhum.
 *
 * **Toda mensagem carrega `target`, e todo listener filtra por ele.**
 * `chrome.runtime` entrega a mensagem a *todos* os contextos da extensão — o
 * service worker recebe o que a UI mandou para o motor, o motor recebe o que a
 * UI mandou para o service worker, e um listener que não filtra responde por
 * engano. O `target` não é decoração: é o endereçamento.
 */

import type { Favorite } from '../../../client/src/lib/soundboard.js';

/** O nome da porta de longa duração. Quem não for este nome não é nosso. */
export const PORT_NAME = 'wtk-engine';

/** Os três endereços possíveis. */
export type Target = 'sw' | 'engine' | 'ui';

// ------------------------------------------------------------------ UI → SW

export interface EnsureEngineMessage {
  target: 'sw';
  type: 'ensure-engine';
}

/** O motor pede ao service worker o que ele não pode fazer (§7.4 do doc). */
export interface BadgeMessage {
  target: 'sw';
  type: 'badge';
  pending: number;
  playing: boolean;
  /** O que o ícone diz ao passar o mouse. Vazio volta ao título padrão. */
  title: string;
}

export interface OpenManagerMessage {
  target: 'sw';
  type: 'open-manager';
}

/**
 * A UI pergunta ao service worker qual é o endereço sugerido. Quem lê a aba
 * ativa é ele: `chrome.tabs` não existe no documento offscreen, e concentrar a
 * leitura num lugar só evita duas respostas diferentes para a mesma pergunta.
 */
export interface PrefillRequest {
  target: 'sw';
  type: 'prefill';
}

/**
 * O motor pedindo disco ao service worker.
 *
 * Não é indireção gratuita: **o documento offscreen não tem `chrome.storage`**
 * (verificado no Chromium; ver o cabeçalho de `lib/storage.ts`). Ele tem
 * `chrome.runtime`, e é por ele que os favoritos e as preferências passam.
 */
export interface StorageGetMessage {
  target: 'sw';
  type: 'storage-get';
  keys: string[];
}

export interface StorageSetMessage {
  target: 'sw';
  type: 'storage-set';
  key: string;
  value: string;
}

/** O caminho de volta: o service worker avisa o motor do que mudou. */
export interface StorageChangedMessage {
  target: 'engine';
  type: 'storage-changed';
  key: string;
  value: string | null;
}

export type SwMessage =
  | EnsureEngineMessage
  | BadgeMessage
  | OpenManagerMessage
  | PrefillRequest
  | StorageGetMessage
  | StorageSetMessage;

// -------------------------------------------------------------- UI → motor

export interface ConnectCommand {
  target: 'engine';
  type: 'connect';
  roomPath: string;
  displayName: string;
}

export interface DisconnectCommand {
  target: 'engine';
  type: 'disconnect';
}

export interface QueueAddCommand {
  target: 'engine';
  type: 'queue-add';
  /** URL colada (`kind: 'url'`) ou id de um arquivo já gravado no IndexedDB. */
  source: { kind: 'url'; sourceRef: string } | { kind: 'file'; fileId: string; title: string };
}

export interface QueueRemoveCommand {
  target: 'engine';
  type: 'queue-remove';
  entryId: string;
}

export interface TransportCommand {
  target: 'engine';
  type: 'transport';
  action: 'play' | 'pause' | 'skip' | 'seek';
  positionSec?: number;
}

export interface VolumeCommand {
  target: 'engine';
  type: 'volume';
  /** `0..1`. **Local, nunca trafega** — é monitoração, como no app (§6.9). */
  value: number;
}

export interface SoundboardFireCommand {
  target: 'engine';
  type: 'soundboard-fire';
  favoriteId: string;
}

export interface FavoriteAddCommand {
  target: 'engine';
  type: 'favorite-add';
  input: string;
}

export interface FavoriteAddFileCommand {
  target: 'engine';
  type: 'favorite-add-file';
  /** Chave no IndexedDB da origem da extensão — gravado pela manager antes de enviar. */
  fileId: string;
  /** Nome do arquivo, usado como título inicial do favorito. */
  title: string;
}

export interface FavoriteRemoveCommand {
  target: 'engine';
  type: 'favorite-remove';
  favoriteId: string;
}

export interface FavoriteRenameCommand {
  target: 'engine';
  type: 'favorite-rename';
  favoriteId: string;
  title: string;
}

/**
 * O handshake: a UI (pelo service worker) pergunta se o motor já atende. Ver o
 * cabeçalho de `offscreen.ts` — "o documento existe" e "o motor atende" são
 * dois instantes diferentes, e conectar no primeiro é uma tela vazia sem erro.
 */
export interface PingCommand {
  target: 'engine';
  type: 'ping';
}

export interface JoinDecisionCommand {
  target: 'engine';
  type: 'join-decision';
  requesterId: string;
  approve: boolean;
}

export type EngineCommand =
  | ConnectCommand
  | DisconnectCommand
  | QueueAddCommand
  | QueueRemoveCommand
  | TransportCommand
  | VolumeCommand
  | SoundboardFireCommand
  | FavoriteAddCommand
  | FavoriteAddFileCommand
  | FavoriteRemoveCommand
  | FavoriteRenameCommand
  | JoinDecisionCommand
  | PingCommand
  | StorageChangedMessage;

// -------------------------------------------------------------- motor → UI

/** O ciclo de vida da sala, do ponto de vista de quem olha o popup. */
export type EngineStatus =
  | 'idle'
  | 'connecting'
  | 'waiting-approval'
  | 'connected'
  | 'denied'
  | 'error';

export interface EngineQueueEntry {
  entryId: string;
  title: string;
  kind: 'url' | 'file';
  durationSec: number;
}

export interface EngineCurrent {
  entryId: string;
  title: string;
  positionSec: number;
  durationSec: number;
  playing: boolean;
}

export interface EnginePeer {
  id: string;
  displayName: string;
}

export interface EnginePendingJoin {
  requesterId: string;
  displayName: string;
}

/**
 * Tudo que a UI precisa para renderizar, e **nada além**. Serializável por
 * construção: é o que atravessa `port.postMessage`, e um `MediaStreamTrack` ou
 * um `AudioBuffer` aqui dentro viraria erro de clonagem em runtime.
 */
export interface EngineState {
  /**
   * Identidade desta instância do motor. Muda quando o documento offscreen é
   * recriado — é o que um teste usa para provar que **um** motor atendeu duas
   * abas (§11.3 do `ARCHITECTURE.md`).
   */
  engineId: string;
  status: EngineStatus;
  roomPath: string;
  displayName: string;
  peers: EnginePeer[];
  pendingJoins: EnginePendingJoin[];
  queue: EngineQueueEntry[];
  current: EngineCurrent | null;
  favorites: Favorite[];
  /** Volume de monitoração local (`0..1`). */
  volume: number;
  /** Quanto falta para o próximo disparo caber na janela do rate limit. */
  cooldownMs: number;
  /**
   * Quantos disparos de soundboard este motor executou. Contador monotônico: é
   * o que prova que N abas disparando produzem **uma** reprodução.
   */
  playCount: number;
  /** Quantos `AudioContext` este motor criou. Um motor bem construído diz `1`. */
  audioContextCount: number;
  /**
   * O estado do `AudioContext` do motor.
   *
   * Está aqui porque `suspended` é uma falha **silenciosa**: o elemento toca, a
   * posição anda, o track continua vivo — e o que sai para a sala é silêncio
   * digital. Sem este campo, o sintoma que chega é "a sala não ouve" sem nada
   * para olhar.
   */
  audioState: 'none' | 'running' | 'suspended' | 'closed';
  /**
   * Pico recente do que **sai** para a sala (0..1), medido no mesmo ponto em que
   * o track nasce.
   *
   * Existe porque "a sala não ouve" é, quase sempre, uma de duas coisas muito
   * diferentes — o motor não está produzindo som, ou o som não está chegando — e
   * sem esta medida não há nada para olhar. Zero com a faixa tocando é silêncio
   * digital, e o lugar de procurar é o grafo de áudio, não a rede.
   */
  outputLevel: number;
  lastError: string | null;
  /**
   * O último comando que o motor **recebeu** (não o último que deu certo).
   *
   * É diagnóstico, e existe porque a pergunta "o clique chegou?" não tinha
   * resposta: entre a porta da UI e o motor há um service worker, um documento
   * offscreen e duas filas, e um comando perdido no caminho é indistinguível de
   * um comando que chegou e falhou em silêncio.
   */
  lastCommand: string | null;
}

export interface StateMessage {
  target: 'ui';
  type: 'state';
  state: EngineState;
}

export interface PatchMessage {
  target: 'ui';
  type: 'patch';
  patch: Partial<EngineState>;
}

export interface NoticeMessage {
  target: 'ui';
  type: 'notice';
  kind: 'error' | 'info';
  text: string;
}

/** A resposta do service worker ao `prefill` — o popup só a exibe. */
export interface PrefillMessage {
  target: 'ui';
  type: 'prefill';
  value: string;
  fromMeet: boolean;
  notice: string | null;
}

export type UiMessage = StateMessage | PatchMessage | NoticeMessage | PrefillMessage;

export type AnyMessage = SwMessage | EngineCommand | UiMessage;

// ------------------------------------------------------------------- guardas

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A mensagem é para mim?
 *
 * Usada em **todo** listener. Devolve `false` para qualquer coisa malformada —
 * um `postMessage` de outra extensão, um payload antigo depois de um reload sem
 * recarregar as abas, ou a própria mensagem voltando por reflexo.
 */
export function isFor<T extends Target>(target: T, message: unknown): message is Extract<AnyMessage, { target: T }> {
  return isRecord(message) && message.target === target && typeof message.type === 'string';
}

/** Estado inicial — o que a UI mostra antes de o motor dizer qualquer coisa. */
export function emptyState(engineId = ''): EngineState {
  return {
    engineId,
    status: 'idle',
    roomPath: '',
    displayName: '',
    peers: [],
    pendingJoins: [],
    queue: [],
    current: null,
    favorites: [],
    volume: 1,
    cooldownMs: 0,
    playCount: 0,
    audioContextCount: 0,
    audioState: 'none',
    outputLevel: 0,
    lastError: null,
    lastCommand: null,
  };
}
