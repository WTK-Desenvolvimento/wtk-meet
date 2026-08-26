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

import { MAX_SOURCE_REF, MAX_TITLE, SOURCE_KINDS, type SourceKind } from './musicSources.js';

/** Entradas vivas na sala inteira. */
export const MAX_QUEUE = 100;
/** Entradas vivas por participante — trava de flood, irmã do `MAX_HISTORY` do chat. */
export const MAX_PER_PEER = 10;
/** Tombstones guardados; os mais antigos caem primeiro. */
export const MAX_TOMBSTONES = 200;

export const DELIVERY: ReadonlySet<string> = new Set(['stream', 'local']);

/** Como a faixa chega aos outros: transmitida no mesh, ou tocada localmente. */
export type Delivery = 'stream' | 'local';

/**
 * Um objeto cru vindo do data channel: as chaves existem ou não, e cada valor é
 * `unknown` até ser checado. Existe para que este arquivo leia payload hostil
 * **sem um único cast** — o item 12 do DoD proíbe cast de contorno aqui, e com
 * razão: um `as` sobre um payload de outro browser é exatamente a afirmação que
 * ninguém pode fazer.
 */
interface Cru {
  [campo: string]: unknown;
}

/** Guard, não cast: "se é objeto não nulo, leia como um saco de campos crus". */
const ehObjeto = (valor: unknown): valor is Cru => !!valor && typeof valor === 'object';

/** Discrimina sem cast — usado por `sanitizePlayback` e `planAdvance`. */
const isDelivery = (valor: unknown): valor is Delivery => valor === 'stream' || valor === 'local';

/** Uma faixa na fila, já sanitizada. */
export interface QueueEntry {
  id: string;
  kind: SourceKind;
  title: string;
  sourceRef: string;
  durationSec: number | null;
  addedBy: string;
  addedByName: string;
  lamport: number;
}

/** O estado de reprodução da sala — um por sala, com dono. */
export interface Playback {
  version: number;
  ownerId: string;
  entryId: string | null;
  positionSec: number;
  playing: boolean;
  delivery: Delivery;
  endedReason: string | null;
  /** Instante **local** (monótono) em que este estado foi aplicado aqui. */
  receivedAt: number;
}

/** Tudo que a sala sabe sobre música. Imutável: cada função devolve um novo. */
export interface MusicSession {
  enabled: boolean;
  lamport: number;
  entries: Record<string, QueueEntry>;
  tombstones: string[];
  playback: Playback;
}

/** O que viaja no `music-snapshot`. */
export interface SessionSnapshot {
  enabled: boolean;
  lamport: number;
  entries: QueueEntry[];
  tombstones: string[];
  playback: Omit<Playback, 'endedReason' | 'receivedAt'>;
}

/** O que `planAdvance` manda publicar, quando manda. */
export interface AdvancePublish {
  entryId: string | null;
  playing: boolean;
  positionSec: number;
  delivery?: Delivery;
  endedReason: string | null;
}

export interface AdvancePlan {
  removedEntryId: string | null;
  broadcastRemove: boolean;
  publish: AdvancePublish | null;
}

/** O que o heartbeat lê do player. Só três campos — nada mais é olhado. */
export interface PlayerProbe {
  positionSec?: number;
  playing?: boolean;
  loading?: boolean;
  buffering?: boolean;
}

export function emptyPlayback(): Playback {
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

export function createSession(): MusicSession {
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
export function bumpLamport(session: MusicSession): { session: MusicSession; lamport: number } {
  const lamport = session.lamport + 1;
  return { session: { ...session, lamport }, lamport };
}

/** Recepção: `local = max(local, recebido) + 1`. */
export function observeLamport(session: MusicSession, received: unknown): MusicSession {
  const value = typeof received === 'number' && Number.isFinite(received) ? Math.floor(received) : 0;
  return { ...session, lamport: Math.max(session.lamport, value) + 1 };
}

// ----------------------------------------------------------------------- fila

function isPlainString(value: unknown): value is string {
  return typeof value === 'string';
}

/**
 * Normaliza uma entrada vinda do data channel. Nada do payload é confiável, com
 * uma exceção deliberada: o `id` é **preservado** (é a identidade compartilhada
 * da entrada, ao contrário do chat, onde o id é regerado). O autor, esse sim, é
 * sobrescrito pelo peer da conexão — aceitar um `addedBy` declarado deixaria
 * qualquer um adicionar faixa em nome de outro.
 */
export function sanitizeEntry(
  bruto: unknown,
  { addedBy }: { addedBy?: unknown } = {},
): QueueEntry | null {
  // Vem do data channel: nada da forma é confiável, então é lido campo a campo.
  if (!ehObjeto(bruto)) return null;
  const raw = bruto;
  if (!isPlainString(raw.id) || !raw.id || raw.id.length > 80) return null;
  if (!isPlainString(raw.kind) || !SOURCE_KINDS.has(raw.kind)) return null;
  const kind: SourceKind = raw.kind === 'youtube' ? 'youtube' : raw.kind === 'file' ? 'file' : 'url';

  const sourceRef = isPlainString(raw.sourceRef) ? raw.sourceRef.slice(0, MAX_SOURCE_REF) : '';
  if (kind === 'youtube' && !/^[A-Za-z0-9_-]{11}$/.test(sourceRef)) return null;
  if (kind === 'url') {
    let url: URL;
    try {
      url = new URL(sourceRef);
    } catch {
      return null;
    }
    // `javascript:`, `data:`, `blob:`, `file:` — descarte imediato.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  }
  if (kind === 'file' && sourceRef !== '') return null;

  const title = isPlainString(raw.title) ? raw.title.trim().slice(0, MAX_TITLE) : '';
  if (!title) return null;

  const owner = isPlainString(addedBy) && addedBy ? addedBy : null;
  if (!owner) return null;

  const durationSec =
    typeof raw.durationSec === 'number' && Number.isFinite(raw.durationSec) && raw.durationSec > 0
      ? Math.min(raw.durationSec, 24 * 3600)
      : null;

  return {
    id: raw.id,
    kind,
    title,
    sourceRef,
    durationSec,
    addedBy: owner,
    addedByName: (isPlainString(raw.addedByName) ? raw.addedByName.trim().slice(0, 40) : '') || 'Participante',
    lamport:
      typeof raw.lamport === 'number' && Number.isFinite(raw.lamport)
        ? Math.max(0, Math.floor(raw.lamport))
        : 0,
  };
}

/** Ordem total: `(lamport, addedBy, id)`. Nunca por relógio de parede. */
export function compareEntries(a: QueueEntry, b: QueueEntry): number {
  if (a.lamport !== b.lamport) return a.lamport - b.lamport;
  if (a.addedBy !== b.addedBy) return a.addedBy < b.addedBy ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

export function orderedQueue(session: MusicSession): QueueEntry[] {
  return Object.values(session.entries).sort(compareEntries);
}

export function entryById(session: MusicSession, entryId?: string | null): QueueEntry | null {
  return (entryId && session.entries[entryId]) || null;
}

export function countByPeer(session: MusicSession, peerId: string): number {
  return Object.values(session.entries).filter((entry) => entry.addedBy === peerId).length;
}

/** Já existe uma entrada viva com a mesma origem? (checagem local, pré-envio) */
export function hasSameSource(session: MusicSession, kind: string, sourceRef: string): boolean {
  if (kind === 'file') return false;
  return Object.values(session.entries).some(
    (entry) => entry.kind === kind && entry.sourceRef === sourceRef,
  );
}

function trimTombstones(list: string[]): string[] {
  return list.length > MAX_TOMBSTONES ? list.slice(list.length - MAX_TOMBSTONES) : list;
}

/**
 * Aplica os tetos de forma determinística: sobrevivem as entradas de menor
 * chave. Dois clients com o mesmo conjunto ficam com a mesma fila,
 * independentemente da ordem em que as adições chegaram.
 */
function enforceLimits(entries: Record<string, QueueEntry>): {
  entries: Record<string, QueueEntry>;
  dropped: string[];
} {
  const ordered = Object.values(entries).sort(compareEntries);
  const perPeer = new Map<string, number>();
  const kept: QueueEntry[] = [];
  const dropped: string[] = [];

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
  const next: Record<string, QueueEntry> = {};
  for (const entry of kept) next[entry.id] = entry;
  return { entries: next, dropped };
}

/**
 * Insere uma entrada. Ignora id já conhecido (*first-write-wins*) e id
 * tombstoneado (uma remoção não pode ser desfeita por um snapshot velho).
 */
export function addEntry(
  session: MusicSession,
  entry: QueueEntry | null,
): { session: MusicSession; ok: boolean; reason: string | null } {
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

export function removeEntry(session: MusicSession, entryId?: string | null): MusicSession {
  if (!entryId) return session;
  const entries = { ...session.entries };
  delete entries[entryId];
  const tombstones = session.tombstones.includes(entryId)
    ? session.tombstones
    : trimTombstones([...session.tombstones, entryId]);
  return { ...session, entries, tombstones };
}

/** Remove todas as entradas de um peer (usado quando ele sai da sala). */
export function removeEntriesBy(
  session: MusicSession,
  peerId: string,
  { kinds = null }: { kinds?: readonly string[] | null } = {},
): MusicSession {
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
export function applyReorder(session: MusicSession, entryId: string, lamport: unknown): MusicSession {
  const entry = session.entries[entryId];
  if (!entry) return session;
  const value = typeof lamport === 'number' && Number.isFinite(lamport) ? Math.floor(lamport) : 0;
  if (value <= entry.lamport) return session;
  return {
    ...session,
    entries: { ...session.entries, [entryId]: { ...entry, lamport: value } },
  };
}

/** Anota a duração descoberta ao carregar a mídia (não afeta a ordem). */
export function applyDuration(session: MusicSession, entryId: string, durationSec: unknown): MusicSession {
  const entry = session.entries[entryId];
  if (!entry || typeof durationSec !== 'number' || !Number.isFinite(durationSec) || durationSec <= 0) {
    return session;
  }
  if (entry.durationSec === durationSec) return session;
  return {
    ...session,
    entries: { ...session.entries, [entryId]: { ...entry, durationSec } },
  };
}

// ----------------------------------------------------------------- navegação

export function nextEntry(session: MusicSession, entryId?: string | null): QueueEntry | null {
  const queue = orderedQueue(session);
  if (!entryId) return queue[0] || null;
  const index = queue.findIndex((entry) => entry.id === entryId);
  if (index < 0) return null;
  return queue[index + 1] || null;
}

export function previousEntry(session: MusicSession, entryId?: string | null): QueueEntry | null {
  const queue = orderedQueue(session);
  if (!entryId) return null;
  const index = queue.findIndex((entry) => entry.id === entryId);
  if (index <= 0) return null;
  return queue[index - 1] ?? null;
}

/**
 * Primeira entrada **depois** de uma chave que pode nem existir mais na fila —
 * é o que permite avançar corretamente quando a faixa corrente foi removida
 * (por exemplo, porque quem a transmitia fechou a aba).
 */
export function nextEntryAfterKey(session: MusicSession, key?: QueueEntry | null): QueueEntry | null {
  if (!key) return orderedQueue(session)[0] || null;
  return orderedQueue(session).find((entry) => compareEntries(entry, key) > 0) || null;
}

// --------------------------------------------------------------- reprodução

export function sanitizePlayback(
  bruto: unknown,
  { ownerId }: { ownerId?: unknown } = {},
): Playback | null {
  // Também vem do canal: lido campo a campo, sem assumir forma.
  if (!ehObjeto(bruto)) return null;
  const raw = bruto;
  if (typeof raw.version !== 'number' || !Number.isFinite(raw.version) || raw.version < 0) return null;
  const owner = typeof ownerId === 'string' && ownerId ? ownerId : null;
  if (!owner) return null;
  const entryId = typeof raw.entryId === 'string' && raw.entryId ? raw.entryId : null;
  const positionSec =
    typeof raw.positionSec === 'number' && Number.isFinite(raw.positionSec) && raw.positionSec >= 0
      ? raw.positionSec
      : 0;
  const delivery: Delivery = isDelivery(raw.delivery) ? raw.delivery : 'stream';
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
// Predicado, e não `boolean`: a primeira linha do corpo já recusa `candidate`
// nulo, então quem passa pela guarda tem um `Playback` de verdade em mãos.
export function isNewerPlayback(
  candidate?: Playback | null,
  current?: Playback | null,
): candidate is Playback {
  if (!candidate) return false;
  if (!current) return true;
  if (candidate.version !== current.version) return candidate.version > current.version;
  return candidate.ownerId > current.ownerId;
}

export function applyPlayback(session: MusicSession, playback: Playback | null, now = 0): MusicSession {
  if (!isNewerPlayback(playback, session.playback)) return session;
  return { ...session, playback: { ...playback, receivedAt: now } };
}

/**
 * Posição estimada agora, a partir do último estado recebido. Usa **apenas**
 * relógio local a partir do instante de recepção: `Date.now()` de máquinas
 * diferentes pode divergir minutos, e nada aqui precisa saber a hora do outro.
 */
export function estimatePosition(playback: Playback | null | undefined, now: number): number {
  if (!playback || !playback.entryId) return 0;
  if (!playback.playing) return playback.positionSec;
  const elapsed = Math.max(0, (now - playback.receivedAt) / 1000);
  return playback.positionSec + elapsed;
}

// ------------------------------------------------------------------ snapshot

export function buildSnapshot(session: MusicSession): SessionSnapshot {
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
export function mergeSnapshot(session: MusicSession, bruto: unknown, now = 0): MusicSession {
  // Vem do canal, como tudo mais neste arquivo.
  if (!ehObjeto(bruto)) return session;
  const snapshot = bruto;

  let next: MusicSession = { ...session };

  if (typeof snapshot.lamport === 'number' && Number.isFinite(snapshot.lamport)) {
    next.lamport = Math.max(next.lamport, Math.floor(snapshot.lamport));
  }
  if (snapshot.enabled) next.enabled = true; // habilitar é monotônico

  const tombstones = new Set<string>(next.tombstones);
  for (const id of Array.isArray(snapshot.tombstones) ? snapshot.tombstones : []) {
    if (typeof id === 'string' && id) tombstones.add(id);
  }
  next.tombstones = trimTombstones([...tombstones]);

  const entries = { ...next.entries };
  const recebidas: unknown[] = Array.isArray(snapshot.entries) ? snapshot.entries : [];
  for (const raw of recebidas) {
    const entry = sanitizeEntry(raw, { addedBy: ehObjeto(raw) ? raw.addedBy : undefined });
    if (!entry) continue;
    if (entries[entry.id]) continue;
    if (next.tombstones.includes(entry.id)) continue;
    entries[entry.id] = entry;
  }
  // Tombstone recém-chegado também mata entrada que já estava aqui.
  for (const id of next.tombstones) delete entries[id];

  next.entries = enforceLimits(entries).entries;

  if (ehObjeto(snapshot.playback)) {
    const recebido = snapshot.playback;
    const playback = sanitizePlayback(recebido, { ownerId: recebido.ownerId });
    if (playback) next = applyPlayback(next, playback, now);
  }

  return next;
}

/**
 * Quem assume quando o dono da faixa cai: o participante presente de menor id.
 * O mesmo critério lexicográfico determinístico do polite/impolite — todos
 * chegam à mesma conclusão sem trocar mensagem, então exatamente um publica.
 */
export function successorOwner(presentIds: unknown): string | null {
  const brutos: unknown[] = Array.isArray(presentIds) ? presentIds : [];
  const ids = brutos.filter(
    (id): id is string => typeof id === 'string' && !!id,
  );
  if (ids.length === 0) return null;
  return ids.sort()[0] ?? null;
}

/**
 * Quem responde pela faixa: quem a adicionou, se ainda estiver na sala; senão o
 * presente de menor id. Determinístico e calculado por todos ao mesmo tempo, que
 * é o que faz exatamente um cliente agir — "quem descobrir primeiro assume" faria
 * dois assumirem, dois publicarem, e o estado oscilar.
 */
export function ownerFor(entry: QueueEntry | null | undefined, presentIds: unknown): string | null {
  const ids: readonly string[] = Array.isArray(presentIds) ? presentIds : [];
  if (!entry) return null;
  if (ids.includes(entry.addedBy)) return entry.addedBy;
  return successorOwner(ids);
}

/**
 * Decide o avanço de faixa. **Pura**: recebe o estado e devolve o que fazer —
 * quem age é o hook.
 *
 * Existe separada por dois motivos. O primeiro é testabilidade: `skipped`,
 * `ended`, `error` e `owner-left` são quatro caminhos que precisam produzir o
 * **mesmo** estado saudável, e provar isso dentro de um hook React exigiria um
 * renderer que este projeto não tem. O segundo é que a regra é de convergência,
 * e neste arquivo estão todas as outras.
 *
 * Três invariantes que a ordem das linhas abaixo carrega:
 *
 * 1. **A chave da faixa que acabou é capturada antes da remoção.** Depois de
 *    remover, `nextEntryAfterKey` não teria de onde partir.
 * 2. **A busca é por chave, não por id.** Quando a faixa corrente já virou
 *    tombstone (`owner-left`, skip que chegou pelo canal), procurar pelo id na
 *    fila não acharia nada e a fila pararia.
 * 3. **Quem publica é o dono da faixa *seguinte*** — nunca o da que acabou. Um
 *    escritor por transição, sempre. Se a fila esvaziou, quem estava tocando
 *    declara o silêncio.
 *
 * `reason` não altera decisão nenhuma: ele só viaja para `endedReason`. É
 * exatamente por isso que os quatro motivos convergem para o mesmo lugar.
 *
 * `delivery` é injetado (função `(entry) => 'stream' | 'local'` ou valor fixo)
 * porque a decisão vem da sonda de CORS, que é rede — e rede não entra aqui.
 */
export function planAdvance({
  session,
  finishedEntryId = null,
  reason = null,
  presentIds = [],
  selfId = '',
  delivery = 'stream',
}: {
  session?: MusicSession | null;
  finishedEntryId?: string | null;
  reason?: string | null;
  presentIds?: readonly string[];
  selfId?: string;
  /** Valor fixo, ou uma função da faixa — a decisão vem da sonda de CORS. */
  delivery?: Delivery | ((entry: QueueEntry) => string);
} = {}): AdvancePlan {
  const idle: AdvancePlan = { removedEntryId: null, broadcastRemove: false, publish: null };
  if (!session) return idle;

  const finished = entryById(session, finishedEntryId);
  const key = finished || null;

  // A faixa que acabou sai da fila (o player é uma fila, não uma playlist). O
  // tombstone vale mesmo para uma entrada que já não está aqui: é ele que impede
  // a ressurreição por um snapshot velho.
  const after = finishedEntryId ? removeEntry(session, finishedEntryId) : session;
  const removedEntryId = finishedEntryId || null;
  const broadcastRemove = !!(finishedEntryId && finished);

  const next = key ? nextEntryAfterKey(after, key) : orderedQueue(after)[0] || null;

  if (!next) {
    // Ninguém para assumir: quem estava tocando declara o silêncio.
    const mine = after.playback.ownerId === selfId || !after.playback.ownerId;
    return {
      removedEntryId,
      broadcastRemove,
      publish: mine ? { entryId: null, playing: false, positionSec: 0, endedReason: reason || null } : null,
    };
  }

  // Se o dono da próxima for outro, ele publica sozinho: o efeito de "nada
  // tocando e a fila tem faixa" roda em todos e só ele satisfaz.
  if (ownerFor(next, presentIds) !== selfId) {
    return { removedEntryId, broadcastRemove, publish: null };
  }

  const how = typeof delivery === 'function' ? delivery(next) : delivery;
  return {
    removedEntryId,
    broadcastRemove,
    publish: {
      entryId: next.id,
      playing: true,
      positionSec: 0,
      delivery: isDelivery(how) ? how : 'stream',
      endedReason: reason || null,
    },
  };
}


/**
 * Decide o tique de 5s do dono — o heartbeat de **posição**. **Pura**: recebe o
 * estado e devolve o que publicar; quem age é o hook.
 *
 * A regra que dá nome à função: o `playing` publicado é a **intenção corrente
 * da sala** (`playback.playing`), nunca uma leitura do player. `player.playing`
 * responde "está soando neste milissegundo?" — pergunta legítima para a UI,
 * resposta errada para "qual é o estado autoritativo da sala". Durante um
 * engasgo de rede, o `YouTubeTrackPlayer` está no estado 3 (BUFFERING) e o
 * getter devolve `false`; um tique caído aí anunciava `playing: false` para
 * todos, e a sala inteira obedecia a uma pausa que ninguém pediu e que ninguém
 * desfazia. Estados intermediários do iframe e autoplay bloqueado divergem do
 * mesmo jeito — buffering só é o caso mais frequente.
 *
 * As transições reais de play/pause têm publicadores próprios e síncronos
 * (pausa e retomada do dono, pedido de um peer, `planAdvance`). O heartbeat
 * nunca foi a fonte de nenhuma delas; ele só ecoava — e um eco que só erra não
 * vale a pena manter.
 *
 * Buffering **não** interrompe a publicação de posição: `positionSec` continua
 * correta durante o engasgo (`element.currentTime` no `MusicEngine`; no YouTube,
 * a posição em que a reprodução vai retomar). Silenciar o tique aqui trocaria um
 * bug audível por um silencioso — no `MusicEngine`, `buffering` é
 * `readyState < 3`, verdadeiro em situações banais, e quem está em modo `local`
 * ficaria sem referência para corrigir deriva por minutos.
 *
 * A única leitura que não é do player é a de quem está `loading` (troca de
 * faixa) — e a janela curta entre `onReady` e o primeiro frame, em que o iframe
 * pode responder `0` sem saber de nada. Publicar esse `0` mandaria a sala
 * inteira para o começo da faixa.
 */
export function planPositionHeartbeat({
  playback,
  player,
}: { playback?: Playback | null; player?: PlayerProbe | null } = {}): {
  publish: { positionSec: number; playing: boolean } | null;
} {
  const idle = { publish: null };
  if (!player || !playback) return idle;

  // O heartbeat só existe enquanto a sala toca. Com a sala pausada não há
  // posição a republicar — e é isto que mantém a função segura de chamar em
  // qualquer contexto, sem nunca produzir um `playing: false`.
  if (!playback.playing) return idle;

  // Trocando de faixa: o player ainda não sabe nada de si.
  if (player.loading) return idle;

  const positionSec = player.positionSec ?? NaN;
  const known = Number.isFinite(positionSec) && positionSec > 0;

  // Entre `onReady` (que já zerou `loading`) e o primeiro frame, o iframe pode
  // responder `0`. Com a sala já em posição maior que zero, publicar isso é
  // rebobinar todo mundo.
  if (player.buffering && !known && playback.positionSec > 0) return idle;

  return { publish: { positionSec, playing: playback.playing } };
}
