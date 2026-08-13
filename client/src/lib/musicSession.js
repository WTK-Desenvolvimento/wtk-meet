/**
 * Estado musical da sala — fila colaborativa e reprodução.
 *
 * Módulo **puro**: sem DOM, sem WebAudio, sem timers, sem `Date.now()`. É o
 * núcleo de corretude do recurso, e é puro exatamente para poder ser fixado em
 * `node:test` antes de existir qualquer UI: divergência de fila é a classe de bug
 * mais barata de prevenir com teste e mais cara de depurar em produção.
 *
 * Não há servidor, não há relógio autoritativo e não há eleição — então cada
 * pedaço do estado tem uma regra que **converge sozinha**:
 *
 * 1. **Fila: conjunto append-only com tombstones, sem líder.** Cada entrada tem
 *    `id`, um relógio lógico `lamport` e o autor. A ordem é `(lamport, addedBy,
 *    id)`: total, determinística e independente da ordem de chegada. Remover é
 *    publicar um tombstone — sem ele, o snapshot de quem não viu a remoção
 *    **ressuscita** a entrada.
 * 2. **Reprodução: escritor único, o dono da faixa corrente.** Só ele publica
 *    `music-playback`, com `version` monotônico. Quem aperta pausar sem ser o
 *    dono manda um pedido; o dono aplica e publica. Isso alinha autoridade com
 *    capacidade física — o áudio nasce na máquina dele.
 * 3. **Limites são aplicados por regra determinística, não por ordem de
 *    chegada.** Passando do teto, sobrevivem as entradas de menor chave — assim
 *    dois clients que receberam as mesmas adições em ordens diferentes ficam com
 *    exatamente a mesma fila.
 */

import { MAX_SOURCE_REF, MAX_TITLE, SOURCE_KINDS } from './musicSources.js';

/** Entradas vivas na sala inteira. */
export const MAX_QUEUE = 100;
/** Entradas vivas por participante — trava de flood, irmã do `MAX_HISTORY` do chat. */
export const MAX_PER_PEER = 10;
/** Tombstones guardados; os mais antigos caem primeiro. */
export const MAX_TOMBSTONES = 200;

export const DELIVERY = new Set(['stream', 'local']);

export function emptyPlayback() {
  return {
    version: 0,
    ownerId: '',
    entryId: null,
    positionSec: 0,
    playing: false,
    delivery: 'stream',
    endedReason: null,
    /** Instante **local** (monótono) em que este estado foi aplicado aqui. */
    receivedAt: 0,
  };
}

export function createSession() {
  return {
    enabled: false,
    lamport: 0,
    entries: {},
    tombstones: [],
    playback: emptyPlayback(),
  };
}

// --------------------------------------------------------------- relógio lógico

/** Emissão: o relógio anda um passo e o valor novo vai na mensagem. */
export function bumpLamport(session) {
  const lamport = session.lamport + 1;
  return { session: { ...session, lamport }, lamport };
}

/** Recepção: `local = max(local, recebido) + 1`. */
export function observeLamport(session, received) {
  const value = Number.isFinite(received) ? Math.floor(received) : 0;
  return { ...session, lamport: Math.max(session.lamport, value) + 1 };
}

// ----------------------------------------------------------------------- fila

function isPlainString(value) {
  return typeof value === 'string';
}

/**
 * Normaliza uma entrada vinda do data channel. Nada do payload é confiável, com
 * uma exceção deliberada: o `id` é **preservado** (é a identidade compartilhada
 * da entrada, ao contrário do chat, onde o id é regerado). O autor, esse sim, é
 * sobrescrito pelo peer da conexão — aceitar um `addedBy` declarado deixaria
 * qualquer um adicionar faixa em nome de outro.
 */
export function sanitizeEntry(raw, { addedBy } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (!isPlainString(raw.id) || !raw.id || raw.id.length > 80) return null;
  if (!isPlainString(raw.kind) || !SOURCE_KINDS.has(raw.kind)) return null;

  const sourceRef = isPlainString(raw.sourceRef) ? raw.sourceRef.slice(0, MAX_SOURCE_REF) : '';
  if (raw.kind === 'youtube' && !/^[A-Za-z0-9_-]{11}$/.test(sourceRef)) return null;
  if (raw.kind === 'url') {
    let url;
    try {
      url = new URL(sourceRef);
    } catch {
      return null;
    }
    // `javascript:`, `data:`, `blob:`, `file:` — descarte imediato.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  }
  if (raw.kind === 'file' && sourceRef !== '') return null;

  const title = isPlainString(raw.title) ? raw.title.trim().slice(0, MAX_TITLE) : '';
  if (!title) return null;

  const owner = isPlainString(addedBy) && addedBy ? addedBy : null;
  if (!owner) return null;

  const durationSec =
    Number.isFinite(raw.durationSec) && raw.durationSec > 0 ? Math.min(raw.durationSec, 24 * 3600) : null;

  return {
    id: raw.id,
    kind: raw.kind,
    title,
    sourceRef,
    durationSec,
    addedBy: owner,
    addedByName: (isPlainString(raw.addedByName) ? raw.addedByName.trim().slice(0, 40) : '') || 'Participante',
    lamport: Number.isFinite(raw.lamport) ? Math.max(0, Math.floor(raw.lamport)) : 0,
  };
}

/** Ordem total: `(lamport, addedBy, id)`. Nunca por relógio de parede. */
export function compareEntries(a, b) {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.addedBy !== b.addedBy) return a.addedBy < b.addedBy ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function orderedQueue(session) {
  return Object.values(session.entries).sort(compareEntries);
}

export function entryById(session, entryId) {
  return (entryId && session.entries[entryId]) || null;
}

export function countByPeer(session, peerId) {
  return Object.values(session.entries).filter((entry) => entry.addedBy === peerId).length;
}

/** Já existe uma entrada viva com a mesma origem? (checagem local, pré-envio) */
export function hasSameSource(session, kind, sourceRef) {
  if (kind === 'file') return false;
  return Object.values(session.entries).some(
    (entry) => entry.kind === kind && entry.sourceRef === sourceRef,
  );
}

function trimTombstones(list) {
  return list.length > MAX_TOMBSTONES ? list.slice(list.length - MAX_TOMBSTONES) : list;
}

/**
 * Aplica os tetos de forma determinística: sobrevivem as entradas de menor
 * chave. Dois clients com o mesmo conjunto ficam com a mesma fila,
 * independentemente da ordem em que as adições chegaram.
 */
function enforceLimits(entries) {
  const ordered = Object.values(entries).sort(compareEntries);
  const perPeer = new Map();
  const kept = [];
  const dropped = [];

  for (const entry of ordered) {
    const used = perPeer.get(entry.addedBy) || 0;
    if (used >= MAX_PER_PEER || kept.length >= MAX_QUEUE) {
      dropped.push(entry.id);
      continue;
    }
    perPeer.set(entry.addedBy, used + 1);
    kept.push(entry);
  }

  if (dropped.length === 0) return { entries, dropped };
  const next = {};
  for (const entry of kept) next[entry.id] = entry;
  return { entries: next, dropped };
}

/**
 * Insere uma entrada. Ignora id já conhecido (*first-write-wins*) e id
 * tombstoneado (uma remoção não pode ser desfeita por um snapshot velho).
 */
export function addEntry(session, entry) {
  if (!entry) return { session, ok: false, reason: 'invalid' };
  if (session.entries[entry.id]) return { session, ok: false, reason: 'duplicate' };
  if (session.tombstones.includes(entry.id)) return { session, ok: false, reason: 'removed' };

  const merged = { ...session.entries, [entry.id]: entry };
  const { entries, dropped } = enforceLimits(merged);

  if (dropped.includes(entry.id)) {
    const reason = countByPeer(session, entry.addedBy) >= MAX_PER_PEER ? 'peer-limit' : 'queue-full';
    return { session: { ...session, entries }, ok: false, reason };
  }
  return { session: { ...session, entries }, ok: true, reason: null };
}

export function removeEntry(session, entryId) {
  if (!entryId) return session;
  const entries = { ...session.entries };
  delete entries[entryId];
  const tombstones = session.tombstones.includes(entryId)
    ? session.tombstones
    : trimTombstones([...session.tombstones, entryId]);
  return { ...session, entries, tombstones };
}

/** Remove todas as entradas de um peer (usado quando ele sai da sala). */
export function removeEntriesBy(session, peerId, { kinds = null } = {}) {
  const victims = Object.values(session.entries).filter(
    (entry) => entry.addedBy === peerId && (!kinds || kinds.includes(entry.kind)),
  );
  return victims.reduce((acc, entry) => removeEntry(acc, entry.id), session);
}

/**
 * Reordenar é reposicionar a entrada no relógio lógico, mantendo id e dono. Só
 * anda para frente (`max` vence), o que faz duas reordenações concorrentes
 * convergirem sem coordenação — e mantém a faixa com quem tem o arquivo.
 */
export function applyReorder(session, entryId, lamport) {
  const entry = session.entries[entryId];
  if (!entry) return session;
  const value = Number.isFinite(lamport) ? Math.floor(lamport) : 0;
  if (value <= entry.lamport) return session;
  return {
    ...session,
    entries: { ...session.entries, [entryId]: { ...entry, lamport: value } },
  };
}

/** Anota a duração descoberta ao carregar a mídia (não afeta a ordem). */
export function applyDuration(session, entryId, durationSec) {
  const entry = session.entries[entryId];
  if (!entry || !Number.isFinite(durationSec) || durationSec <= 0) return session;
  if (entry.durationSec === durationSec) return session;
  return {
    ...session,
    entries: { ...session.entries, [entryId]: { ...entry, durationSec } },
  };
}

// ----------------------------------------------------------------- navegação

export function nextEntry(session, entryId) {
  const queue = orderedQueue(session);
  if (!entryId) return queue[0] || null;
  const index = queue.findIndex((entry) => entry.id === entryId);
  if (index < 0) return null;
  return queue[index + 1] || null;
}

export function previousEntry(session, entryId) {
  const queue = orderedQueue(session);
  if (!entryId) return null;
  const index = queue.findIndex((entry) => entry.id === entryId);
  if (index <= 0) return null;
  return queue[index - 1];
}

/**
 * Primeira entrada **depois** de uma chave que pode nem existir mais na fila —
 * é o que permite avançar corretamente quando a faixa corrente foi removida
 * (por exemplo, porque quem a transmitia fechou a aba).
 */
export function nextEntryAfterKey(session, key) {
  if (!key) return orderedQueue(session)[0] || null;
  return orderedQueue(session).find((entry) => compareEntries(entry, key) > 0) || null;
}

// --------------------------------------------------------------- reprodução

export function sanitizePlayback(raw, { ownerId } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  if (!Number.isFinite(raw.version) || raw.version < 0) return null;
  const owner = typeof ownerId === 'string' && ownerId ? ownerId : null;
  if (!owner) return null;
  const entryId = typeof raw.entryId === 'string' && raw.entryId ? raw.entryId : null;
  const positionSec = Number.isFinite(raw.positionSec) && raw.positionSec >= 0 ? raw.positionSec : 0;
  const delivery = DELIVERY.has(raw.delivery) ? raw.delivery : 'stream';
  return {
    version: Math.floor(raw.version),
    ownerId: owner,
    entryId,
    positionSec,
    playing: !!raw.playing && !!entryId,
    delivery,
    endedReason: typeof raw.endedReason === 'string' ? raw.endedReason.slice(0, 40) : null,
    receivedAt: 0,
  };
}

/** `(version, ownerId)` — par lexicográfico, comparação total. */
export function isNewerPlayback(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.version !== current.version) return candidate.version > current.version;
  return candidate.ownerId > current.ownerId;
}

export function applyPlayback(session, playback, now = 0) {
  if (!isNewerPlayback(playback, session.playback)) return session;
  return { ...session, playback: { ...playback, receivedAt: now } };
}

/**
 * Posição estimada agora, a partir do último estado recebido. Usa **apenas**
 * relógio local a partir do instante de recepção: `Date.now()` de máquinas
 * diferentes pode divergir minutos, e nada aqui precisa saber a hora do outro.
 */
export function estimatePosition(playback, now) {
  if (!playback || !playback.entryId) return 0;
  if (!playback.playing) return playback.positionSec;
  const elapsed = Math.max(0, (now - playback.receivedAt) / 1000);
  return playback.positionSec + elapsed;
}

// ------------------------------------------------------------------ snapshot

export function buildSnapshot(session) {
  return {
    enabled: session.enabled,
    lamport: session.lamport,
    entries: orderedQueue(session),
    tombstones: [...session.tombstones],
    playback: {
      version: session.playback.version,
      ownerId: session.playback.ownerId,
      entryId: session.playback.entryId,
      positionSec: session.playback.positionSec,
      playing: session.playback.playing,
      delivery: session.playback.delivery,
    },
  };
}

/**
 * Funde um snapshot recebido. **União**, nunca substituição: um snapshot mais
 * velho substituindo a fila local apagaria adições recentes. Tombstones dos dois
 * lados se somam e vencem as entradas — é o que impede a ressurreição de uma
 * faixa removida por alguém que o remetente não viu remover.
 *
 * `entryOwner` mapeia a entrada para o autor confiável quando o snapshot vem
 * pelo canal: entradas de terceiros mantêm o `addedBy` declarado (o remetente
 * está só repassando o que viu), mas nada além de id/kind/título sobrevive à
 * sanitização.
 */
export function mergeSnapshot(session, snapshot, now = 0) {
  if (!snapshot || typeof snapshot !== 'object') return session;

  let next = { ...session };

  if (Number.isFinite(snapshot.lamport)) {
    next.lamport = Math.max(next.lamport, Math.floor(snapshot.lamport));
  }
  if (snapshot.enabled) next.enabled = true; // habilitar é monotônico

  const tombstones = new Set(next.tombstones);
  for (const id of Array.isArray(snapshot.tombstones) ? snapshot.tombstones : []) {
    if (typeof id === 'string' && id) tombstones.add(id);
  }
  next.tombstones = trimTombstones([...tombstones]);

  const entries = { ...next.entries };
  for (const raw of Array.isArray(snapshot.entries) ? snapshot.entries : []) {
    const entry = sanitizeEntry(raw, { addedBy: raw?.addedBy });
    if (!entry) continue;
    if (entries[entry.id]) continue;
    if (next.tombstones.includes(entry.id)) continue;
    entries[entry.id] = entry;
  }
  // Tombstone recém-chegado também mata entrada que já estava aqui.
  for (const id of next.tombstones) delete entries[id];

  next.entries = enforceLimits(entries).entries;

  if (snapshot.playback) {
    const playback = sanitizePlayback(snapshot.playback, { ownerId: snapshot.playback.ownerId });
    if (playback) next = applyPlayback(next, playback, now);
  }

  return next;
}

/**
 * Quem assume quando o dono da faixa cai: o participante presente de menor id.
 * O mesmo critério lexicográfico determinístico do polite/impolite — todos
 * chegam à mesma conclusão sem trocar mensagem, então exatamente um publica.
 */
export function successorOwner(presentIds) {
  const ids = (Array.isArray(presentIds) ? presentIds : []).filter((id) => typeof id === 'string' && id);
  if (ids.length === 0) return null;
  return ids.sort()[0];
}
