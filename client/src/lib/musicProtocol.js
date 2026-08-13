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
import { VOTE_DURATION_MS, VOTE_KINDS } from './musicVote.js';

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

export function isMusicMessage(payload) {
  return !!payload && typeof payload.type === 'string' && MUSIC_MESSAGE_TYPES.has(payload.type);
}

// ------------------------------------------------------------------ builders

export function voteOpenMessage({ voteId, kind, lamport, proposerName, electorate, durationMs, target }) {
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

export function voteCastMessage({ voteId, vote }) {
  return { type: 'music-vote-cast', voteId, vote };
}

export function voteResultMessage(result) {
  return { type: 'music-vote-result', ...result };
}

export function queueAddMessage(entry) {
  return { type: 'music-queue-add', entry };
}

export function queueRemoveMessage({ entryId, byName }) {
  return { type: 'music-queue-remove', entryId, byName };
}

export function queueReorderMessage({ entryId, lamport, byName }) {
  return { type: 'music-queue-reorder', entryId, lamport, byName };
}

export function playbackMessage(playback) {
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

export function commandMessage({ entryId, action, positionSec = null }) {
  return { type: 'music-command', entryId, action, positionSec };
}

export function snapshotMessage(snapshot) {
  return { type: 'music-snapshot', ...snapshot };
}

// ---------------------------------------------------------------- sanitização

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function name(value) {
  return str(value, 40).trim() || 'Participante';
}

/**
 * Valida e normaliza uma mensagem recebida. Devolve `null` para qualquer coisa
 * malformada — campo faltando, tipo trocado, `kind` desconhecido, `sourceRef`
 * com esquema `javascript:` — sem lançar e sem tocar no estado.
 */
export function sanitizeMusicMessage(payload, { fromPeerId } = {}) {
  if (!isMusicMessage(payload)) return null;
  if (typeof fromPeerId !== 'string' || !fromPeerId) return null;

  switch (payload.type) {
    case 'music-vote-open': {
      const voteId = str(payload.voteId, 80);
      if (!voteId) return null;
      const kind = VOTE_KINDS.has(payload.kind) ? payload.kind : 'enable';
      const electorate = Array.isArray(payload.electorate)
        ? payload.electorate.filter((id) => typeof id === 'string' && id).slice(0, 12)
        : [];
      if (electorate.length === 0) return null;
      const durationMs =
        Number.isFinite(payload.durationMs) && payload.durationMs > 0 && payload.durationMs <= 120_000
          ? payload.durationMs
          : VOTE_DURATION_MS;
      return {
        type: payload.type,
        voteId,
        kind,
        lamport: Number.isFinite(payload.lamport) ? Math.floor(payload.lamport) : 0,
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
      return { type: payload.type, voteId, voterId: fromPeerId, vote: payload.vote };
    }

    case 'music-vote-result': {
      const voteId = str(payload.voteId, 80);
      if (!voteId) return null;
      return {
        type: payload.type,
        voteId,
        arbiterId: fromPeerId,
        kind: VOTE_KINDS.has(payload.kind) ? payload.kind : 'enable',
        approved: !!payload.approved,
        yes: Number.isFinite(payload.yes) ? Math.max(0, Math.floor(payload.yes)) : 0,
        no: Number.isFinite(payload.no) ? Math.max(0, Math.floor(payload.no)) : 0,
        target: sanitizeTarget(payload.target),
      };
    }

    case 'music-queue-add': {
      const entry = sanitizeEntry(payload.entry, { addedBy: fromPeerId });
      if (!entry) return null;
      return { type: payload.type, entry };
    }

    case 'music-queue-remove': {
      const entryId = str(payload.entryId, 80);
      if (!entryId) return null;
      return { type: payload.type, entryId, byId: fromPeerId, byName: name(payload.byName) };
    }

    case 'music-queue-reorder': {
      const entryId = str(payload.entryId, 80);
      if (!entryId) return null;
      if (!Number.isFinite(payload.lamport)) return null;
      return {
        type: payload.type,
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
      return { type: payload.type, playback };
    }

    case 'music-command': {
      const entryId = str(payload.entryId, 80);
      if (!COMMAND_ACTIONS.has(payload.action)) return null;
      if (payload.action !== 'play-entry' && !entryId) return null;
      return {
        type: payload.type,
        entryId: entryId || null,
        action: payload.action,
        positionSec:
          Number.isFinite(payload.positionSec) && payload.positionSec >= 0 ? payload.positionSec : null,
        byId: fromPeerId,
      };
    }

    case 'music-snapshot': {
      const entries = Array.isArray(payload.entries) ? payload.entries.slice(0, 200) : [];
      const tombstones = Array.isArray(payload.tombstones)
        ? payload.tombstones.filter((id) => typeof id === 'string' && id).slice(0, 400)
        : [];
      return {
        type: payload.type,
        fromPeerId,
        snapshot: {
          enabled: !!payload.enabled,
          lamport: Number.isFinite(payload.lamport) ? Math.floor(payload.lamport) : 0,
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

function sanitizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const entryId = typeof raw.entryId === 'string' ? raw.entryId.slice(0, 80) : '';
  const title = typeof raw.title === 'string' ? raw.title.slice(0, 120) : '';
  const direction = raw.direction === 'previous' ? 'previous' : 'next';
  return { entryId: entryId || null, title, direction };
}
