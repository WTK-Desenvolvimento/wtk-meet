/**
 * Protocolo de música sobre o data channel que já existe (`wtk-chat`,
 * `negotiated: true, id: 0`) — o mesmo que carrega `type: 'chat'` e
 * `type: 'state'`.
 *
 * **Nenhum evento novo no servidor de sinalização.** Tudo o que a música precisa
 * dizer, ela diz P2P. Como `_handleChannelMessage` ignora tipos desconhecidos,
 * um client antigo que receba `music-*` simplesmente não participa, em vez de
 * quebrar.
 *
 * Regra de identidade, que vale para todas as mensagens sem exceção: **o autor é
 * o peer da conexão em que a mensagem chegou** (`rec.peerId`). Nenhum campo
 * `from`, `voterId` ou `addedBy` do payload é aceito como identidade — em mesh
 * completo toda mensagem vem direto do autor, e confiar num id declarado
 * permitiria votar ou comandar no lugar de outro participante.
 *
 * Módulo **puro**: só monta e valida objetos.
 */

import { sanitizeEntry, sanitizePlayback } from './musicSession.js';
import { VOTE_DURATION_MS, isVoteKind, type VoteKind, type VoteResult, type VoteTarget } from './musicVote.js';
import type { Playback, QueueEntry, SessionSnapshot } from './musicSession.js';

export const MUSIC_MESSAGE_TYPES = new Set([
  'music-vote-open',
  'music-vote-cast',
  'music-vote-result',
  'music-queue-add',
  'music-queue-remove',
  'music-queue-reorder',
  'music-playback',
  'music-command',
  'music-snapshot',
]);

export const COMMAND_ACTIONS = new Set(['pause', 'resume', 'seek', 'play-entry']);

/**
 * Uma mensagem crua do canal de música. O único campo garantido é `type`; todo
 * o resto é `unknown` **de propósito** — é o que obriga cada leitura abaixo a
 * checar o tipo antes de usar, que é exatamente o que este módulo existe para
 * fazer.
 */
export interface MusicMessage {
  type: string;
  [campo: string]: unknown;
}

/**
 * O que `sanitizeMusicMessage` devolve — uma união discriminada por `type`.
 *
 * O tipo de entrada (`MusicMessage`) é um saco de campos `unknown`, porque é o
 * que chega do fio; o de **saída** é o oposto, e essa assimetria é o valor deste
 * módulo inteiro: depois de passar por aqui, cada campo tem tipo, e quem consome
 * não precisa re-checar nada.
 */
export type SanitizedMusicMessage =
  | {
      type: 'music-vote-open';
      voteId: string;
      kind: VoteKind;
      lamport: number;
      /** Sempre o remetente da conexão, nunca o que o payload declarou. */
      proposerId: string;
      proposerName: string;
      electorate: string[];
      durationMs: number;
      target: VoteTarget | null;
    }
  | { type: 'music-vote-cast'; voteId: string; voterId: string; vote: 'yes' | 'no' }
  | {
      type: 'music-vote-result';
      voteId: string;
      arbiterId: string;
      kind: VoteKind;
      approved: boolean;
      yes: number;
      no: number;
      target: VoteTarget | null;
    }
  | { type: 'music-queue-add'; entry: QueueEntry }
  | { type: 'music-queue-remove'; entryId: string; byId: string; byName: string }
  | { type: 'music-queue-reorder'; entryId: string; lamport: number; byId: string; byName: string }
  | { type: 'music-playback'; playback: Playback }
  | {
      type: 'music-command';
      entryId: string | null;
      action: string;
      positionSec: number | null;
      byId: string;
    }
  | { type: 'music-snapshot'; fromPeerId: string; snapshot: SanitizedSnapshot };

/**
 * O estado da sessão como ele **chega** de outro peer: já podado (200 entradas,
 * 400 lápides) mas ainda não validado item a item — quem faz isso é
 * `musicSession.sanitizeEntry`, e é por isso que `entries` e `playback` seguem
 * como `unknown`. Prometer `QueueEntry[]` aqui seria mentir sobre o que este
 * módulo conferiu.
 */
export interface SanitizedSnapshot {
  enabled: boolean;
  lamport: number;
  entries: unknown[];
  tombstones: string[];
  playback: object | null;
}

export function isMusicMessage(payload: unknown): payload is MusicMessage {
  return (
    !!payload &&
    typeof payload === 'object' &&
    'type' in payload &&
    typeof payload.type === 'string' &&
    MUSIC_MESSAGE_TYPES.has(payload.type)
  );
}

// ------------------------------------------------------------------ builders

export function voteOpenMessage({
  voteId,
  kind,
  lamport,
  proposerName,
  electorate,
  durationMs,
  target,
}: {
  voteId: string;
  kind: VoteKind;
  lamport: number;
  proposerName: string;
  electorate: readonly string[];
  durationMs: number;
  target?: VoteTarget | null;
}): MusicMessage {
  return {
    type: 'music-vote-open',
    voteId,
    kind,
    lamport,
    proposerName,
    electorate,
    durationMs,
    target: target || null,
  };
}

export function voteCastMessage({ voteId, vote }: { voteId: string; vote: 'yes' | 'no' }): MusicMessage {
  return { type: 'music-vote-cast', voteId, vote };
}

export function voteResultMessage(result: VoteResult): MusicMessage {
  return { type: 'music-vote-result', ...result };
}

export function queueAddMessage(entry: QueueEntry): MusicMessage {
  return { type: 'music-queue-add', entry };
}

export function queueRemoveMessage({ entryId, byName }: { entryId: string; byName: string }): MusicMessage {
  return { type: 'music-queue-remove', entryId, byName };
}

export function queueReorderMessage({
  entryId,
  lamport,
  byName,
}: {
  entryId: string;
  lamport: number;
  byName: string;
}): MusicMessage {
  return { type: 'music-queue-reorder', entryId, lamport, byName };
}

export function playbackMessage(playback: Playback): MusicMessage {
  return {
    type: 'music-playback',
    version: playback.version,
    ownerId: playback.ownerId,
    entryId: playback.entryId,
    positionSec: playback.positionSec,
    playing: playback.playing,
    delivery: playback.delivery,
    endedReason: playback.endedReason || null,
  };
}

export function commandMessage({
  entryId,
  action,
  positionSec = null,
}: {
  entryId: string | null;
  action: string;
  positionSec?: number | null;
}): MusicMessage {
  return { type: 'music-command', entryId, action, positionSec };
}

export function snapshotMessage(snapshot: SessionSnapshot): MusicMessage {
  return { type: 'music-snapshot', ...snapshot };
}

// ---------------------------------------------------------------- sanitização

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Inteiro não negativo a partir de um campo cru; `0` para qualquer outra coisa. */
function inteiro(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 0;
}

function name(value: unknown): string {
  return str(value, 40).trim() || 'Participante';
}

/**
 * Valida e normaliza uma mensagem recebida. Devolve `null` para qualquer coisa
 * malformada — campo faltando, tipo trocado, `kind` desconhecido, `sourceRef`
 * com esquema `javascript:` — sem lançar e sem tocar no estado.
 */
export function sanitizeMusicMessage(
  payload: unknown,
  { fromPeerId }: { fromPeerId?: unknown } = {},
): SanitizedMusicMessage | null {
  if (!isMusicMessage(payload)) return null;
  if (typeof fromPeerId !== 'string' || !fromPeerId) return null;

  switch (payload.type) {
    case 'music-vote-open': {
      const voteId = str(payload.voteId, 80);
      if (!voteId) return null;
      const kind: VoteKind = isVoteKind(payload.kind) ? payload.kind : 'enable';
      const electorate: string[] = Array.isArray(payload.electorate)
        ? payload.electorate.filter((id): id is string => typeof id === 'string' && !!id).slice(0, 12)
        : [];
      if (electorate.length === 0) return null;
      const durationMs =
        typeof payload.durationMs === 'number' &&
        Number.isFinite(payload.durationMs) &&
        payload.durationMs > 0 &&
        payload.durationMs <= 120_000
          ? payload.durationMs
          : VOTE_DURATION_MS;
      return {
        type: 'music-vote-open',
        voteId,
        kind,
        lamport: inteiro(payload.lamport),
        // O proponente é quem mandou, não quem o payload diz que é.
        proposerId: fromPeerId,
        proposerName: name(payload.proposerName),
        electorate,
        durationMs,
        target: sanitizeTarget(payload.target),
      };
    }

    case 'music-vote-cast': {
      const voteId = str(payload.voteId, 80);
      if (!voteId) return null;
      if (payload.vote !== 'yes' && payload.vote !== 'no') return null;
      return { type: 'music-vote-cast', voteId, voterId: fromPeerId, vote: payload.vote };
    }

    case 'music-vote-result': {
      const voteId = str(payload.voteId, 80);
      if (!voteId) return null;
      return {
        type: 'music-vote-result',
        voteId,
        arbiterId: fromPeerId,
        kind: isVoteKind(payload.kind) ? payload.kind : 'enable',
        approved: !!payload.approved,
        yes: Math.max(0, inteiro(payload.yes)),
        no: Math.max(0, inteiro(payload.no)),
        target: sanitizeTarget(payload.target),
      };
    }

    case 'music-queue-add': {
      const entry = sanitizeEntry(payload.entry, { addedBy: fromPeerId });
      if (!entry) return null;
      return { type: 'music-queue-add', entry };
    }

    case 'music-queue-remove': {
      const entryId = str(payload.entryId, 80);
      if (!entryId) return null;
      return { type: 'music-queue-remove', entryId, byId: fromPeerId, byName: name(payload.byName) };
    }

    case 'music-queue-reorder': {
      const entryId = str(payload.entryId, 80);
      if (!entryId) return null;
      if (typeof payload.lamport !== 'number' || !Number.isFinite(payload.lamport)) return null;
      return {
        type: 'music-queue-reorder',
        entryId,
        lamport: Math.max(0, Math.floor(payload.lamport)),
        byId: fromPeerId,
        byName: name(payload.byName),
      };
    }

    case 'music-playback': {
      // `ownerId` é o remetente: só o dono da faixa publica reprodução.
      const playback = sanitizePlayback(payload, { ownerId: fromPeerId });
      if (!playback) return null;
      return { type: 'music-playback', playback };
    }

    case 'music-command': {
      const entryId = str(payload.entryId, 80);
      if (typeof payload.action !== 'string' || !COMMAND_ACTIONS.has(payload.action)) return null;
      if (payload.action !== 'play-entry' && !entryId) return null;
      return {
        type: 'music-command',
        entryId: entryId || null,
        action: payload.action,
        positionSec:
          typeof payload.positionSec === 'number' &&
          Number.isFinite(payload.positionSec) &&
          payload.positionSec >= 0
            ? payload.positionSec
            : null,
        byId: fromPeerId,
      };
    }

    case 'music-snapshot': {
      const entries: unknown[] = Array.isArray(payload.entries) ? payload.entries.slice(0, 200) : [];
      const tombstones: string[] = Array.isArray(payload.tombstones)
        ? payload.tombstones.filter((id): id is string => typeof id === 'string' && !!id).slice(0, 400)
        : [];
      return {
        type: 'music-snapshot',
        fromPeerId,
        snapshot: {
          enabled: !!payload.enabled,
          lamport: inteiro(payload.lamport),
          // As entradas do snapshot são repasse: o remetente não é o autor delas,
          // então aqui o `addedBy` declarado é mantido (e validado adiante).
          entries,
          tombstones,
          playback: payload.playback && typeof payload.playback === 'object' ? payload.playback : null,
        },
      };
    }

    default:
      return null;
  }
}

function sanitizeTarget(raw: unknown): VoteTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  // O narrowing por `in` é o que dá acesso ao campo sem nenhum cast: ele estreita
  // `raw` para um objeto que sabidamente tem a chave, com valor `unknown`.
  const entryId = 'entryId' in raw && typeof raw.entryId === 'string' ? raw.entryId.slice(0, 80) : '';
  const title = 'title' in raw && typeof raw.title === 'string' ? raw.title.slice(0, 120) : '';
  const direction = 'direction' in raw && raw.direction === 'previous' ? 'previous' : 'next';
  return { entryId: entryId || null, title, direction };
}
