/**
 * QA da WTK-MEET-23 — a **fiação** do soundboard dentro de `useMusicRoom`.
 *
 * `soundboard.test.ts` já cobre o que é puro: parsing, favoritos, storage
 * corrompido e a tabela do rate limit. O que não tem como sair dali é o meio —
 * quem consulta o mute do ouvinte, quem descarta o anúncio excedente, em que
 * ordem o anúncio e o som saem, e se o disparo mexe (ou não) no track do canal
 * de música. É exatamente onde os bugs desta entrega moram, e todos eles são
 * silenciosos: um soundboard que rouba o canal do player não lança nada, e um
 * mute que chega depois do áudio também não.
 *
 * Mesmas duas costuras de `musicRoomPlayerError.test.ts`, e pelo mesmo motivo:
 * dublês mínimos de WebAudio/`fetch` e um render de hook com dispatcher próprio,
 * com `useEffect` rodando de verdade. Sem DOM, sem jsdom, sem navegador.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// --------------------------------------------------------- dublês de WebAudio

class FakeNode {
  label: string;
  connections: unknown[];
  disconnectCalls = 0;
  stream?: { getAudioTracks: () => { id: string; stop(): void }[] };
  gain?: { value: number };

  constructor(label: string) {
    this.label = label;
    this.connections = [];
  }

  connect(target: unknown) {
    this.connections.push(target);
    return target;
  }

  disconnect() {
    this.disconnectCalls += 1;
  }
}

/** Um `AudioBufferSourceNode`: de uso único, com corte de duração no `start`. */
class FakeSource extends FakeNode {
  buffer: { duration: number } | null = null;
  startArgs: unknown[] | null = null;
  stopCalls = 0;
  onended: (() => void) | null = null;

  constructor() {
    super('buffer-source');
  }

  start(...args: unknown[]) {
    this.startArgs = args;
    startOrder.push('audio');
  }

  stop() {
    this.stopCalls += 1;
  }
}

/** O `<audio>` da faixa do player — só o que o motor lê e escreve nele. */
class FakeAudioElement {
  listeners = new Map<string, Set<() => void>>();
  readyState = 1;
  currentTime = 0;
  duration = 180;
  paused = true;
  ended = false;
  pauseCalls = 0;
  src = '';
  crossOrigin: string | null = null;
  preload = '';
  volume = 1;

  addEventListener(type: string, handler: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  removeEventListener(type: string, handler: () => void) {
    this.listeners.get(type)?.delete(handler);
  }

  async play() {
    this.paused = false;
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  load() {}
  removeAttribute() {}
}

const audioElements: FakeAudioElement[] = [];
globalThis.Audio = class {
  constructor() {
    const element = new FakeAudioElement();
    audioElements.push(element);
    return element as unknown as HTMLAudioElement;
  }
} as unknown as typeof Audio;

const sources: FakeSource[] = [];
/** A ordem em que o anúncio e o áudio saíram: é o que o teste da corrida lê. */
let startOrder: string[] = [];
let decodedDurationSec = 1.2;

class FakeAudioContext {
  state = 'running';
  destination = new FakeNode('speakers');
  createdDestinations = 0;

  async resume() {}
  async close() {}

  createMediaStreamDestination() {
    this.createdDestinations += 1;
    const id = `music-track-${this.createdDestinations}`;
    const track = { id, stop() {} };
    const node = new FakeNode('mesh');
    node.stream = { getAudioTracks: () => [track] };
    return node;
  }

  createGain() {
    const node = new FakeNode('gain');
    node.gain = { value: 1 };
    return node;
  }

  createDynamicsCompressor() {
    return new FakeNode('compressor');
  }

  createBufferSource() {
    const node = new FakeSource();
    sources.push(node);
    return node;
  }

  createMediaElementSource() {
    return new FakeNode('element-source');
  }

  async decodeAudioData() {
    return { duration: decodedDurationSec } as unknown as AudioBuffer;
  }
}

// A fronteira com o navegador: o acessor de `lib/audioContext.js` lê o
// construtor de `window`, e o tocador de efeitos usa `fetch`.
globalThis.window = { AudioContext: FakeAudioContext } as unknown as Window & typeof globalThis;

interface RespostaFalsa {
  ok: boolean;
  status: number;
  arrayBuffer?: () => Promise<ArrayBuffer>;
}

let fetchCalls: { url: string; init: Record<string, unknown> }[] = [];
let fetchImpl: (url: string, init: Record<string, unknown>) => Promise<RespostaFalsa> = async (
  _url,
  init,
) =>
  // A sonda pede um byte; o download completo não manda `Range`.
  init?.headers
    ? { ok: false, status: 206 }
    : { ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) };

globalThis.fetch = ((url: string, init: Record<string, unknown>) => {
  fetchCalls.push({ url, init });
  return fetchImpl(url, init);
}) as unknown as typeof fetch;

const React = await import('react');
const internals = (
  React.default as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: { H: unknown };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

const { useMusicRoom } = await import('../src/lib/useMusicRoom.js');
const { BURST_LIMIT } = await import('../src/lib/soundboardRate.js');

import type { Favorite } from '../src/lib/soundboard.js';
import type { MusicMessage } from '../src/lib/musicProtocol.js';

// ------------------------------------------------------------ render de hook

const sameDeps = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/** Uma casa do dispatcher: cada hook guarda o que precisa aqui. */
interface Slot {
  value?: unknown;
  current?: unknown;
  deps?: unknown;
  cleanup?: (() => void) | null;
  first?: boolean;
}

/**
 * Roda um hook fora do React: dispatcher próprio, render síncrono a cada
 * `setState` e efeitos executados na ordem, com deps e cleanup. Cópia do
 * harness de `musicRoomPlayerError.test.ts` — deixá-lo aqui é o que mantém
 * aquele arquivo intocado por esta entrega.
 */
function renderHook<P, R>(hook: (props: P) => R, props: P) {
  const slots: Slot[] = [];
  let cursor = 0;
  let result: R | null = null;
  let pending: { cell: Slot; create: () => unknown }[] = [];
  let dirty = false;
  let busy = false;

  const dispatcher = {
    useState(initial: unknown) {
      const slot = cursor++;
      if (!slots[slot]) slots[slot] = { value: typeof initial === 'function' ? initial() : initial };
      const cell = slots[slot]!;
      return [
        cell.value,
        (value: unknown) => {
          const next = typeof value === 'function' ? value(cell.value) : value;
          if (Object.is(next, cell.value)) return;
          cell.value = next;
          schedule();
        },
      ];
    },
    useRef(initial: unknown) {
      const slot = cursor++;
      if (!slots[slot]) slots[slot] = { current: initial };
      return slots[slot];
    },
    useMemo(factory: () => unknown, deps: unknown) {
      const slot = cursor++;
      if (!slots[slot] || !sameDeps(slots[slot]!.deps, deps)) slots[slot] = { deps, value: factory() };
      return slots[slot]!.value;
    },
    useCallback(fn: unknown, deps: unknown) {
      const slot = cursor++;
      if (!slots[slot] || !sameDeps(slots[slot]!.deps, deps)) slots[slot] = { deps, value: fn };
      return slots[slot]!.value;
    },
    useEffect(create: () => unknown, deps: unknown) {
      const slot = cursor++;
      if (!slots[slot]) slots[slot] = { deps: null, cleanup: null, first: true };
      const cell = slots[slot]!;
      if (cell.first || !sameDeps(cell.deps, deps)) {
        cell.first = false;
        cell.deps = deps;
        pending.push({ cell, create });
      }
    },
    useContext: () => undefined,
    useDebugValue: () => {},
    useId: () => 'test-id',
  };
  const dispatcherCompleto = { ...dispatcher, useLayoutEffect: dispatcher.useEffect };

  function renderOnce() {
    cursor = 0;
    const previous = internals.H;
    internals.H = dispatcherCompleto;
    try {
      result = hook(props);
    } finally {
      internals.H = previous;
    }
  }

  function schedule() {
    dirty = true;
    if (busy) return;
    busy = true;
    try {
      let guard = 0;
      while (dirty) {
        assert.ok((guard += 1) < 100, 'render em laço: um efeito muda estado a cada execução');
        dirty = false;
        renderOnce();
        const list = pending;
        pending = [];
        for (const { cell, create } of list) {
          cell.cleanup?.();
          const cleanup = create();
          cell.cleanup = typeof cleanup === 'function' ? (cleanup as () => void) : null;
        }
      }
    } finally {
      busy = false;
    }
  }

  schedule();

  return {
    get result() {
      return result!;
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}

// ------------------------------------------------------------------ cenário

const SELF = 'peer-eu';
const ALICE = 'peer-alice';
const BOB = 'peer-bob';

const settle = async (turns = 3) => {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function favorite(over: Partial<Favorite> = {}): Favorite {
  return {
    id: 'fav-1',
    title: 'Bruh',
    sourceRef: 'https://cdn.exemplo.com/media/sounds/bruh.mp3',
    addedAt: 1,
    ...over,
  };
}

/** O mesh que o hook enxerga: guarda o que foi ao fio e o track do canal. */
function fakeMesh() {
  return {
    sent: [] as MusicMessage[],
    trackCalls: [] as (MediaStreamTrack | null)[],
    localMusicTrack: null as MediaStreamTrack | null,
    sendMusicMessage(payload: MusicMessage) {
      this.sent.push(payload);
      startOrder.push(`anuncio:${payload.type}`);
      return 1;
    },
    async setMusicTrack(track: MediaStreamTrack | null) {
      this.trackCalls.push(track);
      this.localMusicTrack = track;
    },
  };
}

function mountRoom({ muted = () => false }: { muted?: (peerId: string) => boolean } = {}) {
  sources.length = 0;
  audioElements.length = 0;
  startOrder = [];
  fetchCalls = [];
  const mesh = fakeMesh();
  const props = {
    meshRef: { current: mesh },
    participants: new Map([
      [SELF, {}],
      [ALICE, {}],
      [BOB, {}],
    ]),
    getSelfId: () => SELF,
    displayName: 'Eu',
    pushToast: () => {},
    isSoundboardMuted: muted,
  };
  const room = renderHook(useMusicRoom, props as unknown as Parameters<typeof useMusicRoom>[0]);
  return { room, mesh };
}

/** Um anúncio como ele chega do data channel — sem campo de autoria. */
function anuncio(over: Record<string, unknown> = {}) {
  return { type: 'soundboard-play', soundId: 'fav-1', title: 'Bruh', durationMs: 1200, ...over } as MusicMessage;
}

// ------------------------------------------------- recepção e mute do ouvinte

test('anúncio de peer silenciado abre a janela de mute; de peer não silenciado, não', () => {
  const { room } = mountRoom({ muted: (peerId) => peerId === ALICE });
  const receber = room.result.meshCallbacks.onMusicMessage!;

  receber(BOB, anuncio());
  assert.deepEqual(
    room.result.soundboard.silencedPeerIds,
    [],
    'peer não silenciado: nada é emudecido, e o efeito dele é ouvido',
  );

  receber(ALICE, anuncio({ soundId: 'fav-2' }));
  assert.deepEqual(
    room.result.soundboard.silencedPeerIds,
    [ALICE],
    'peer silenciado: o <audio> daquele peer é emudecido pela duração do efeito',
  );

  // Os dois aparecem na atribuição: silenciar é não ouvir, não é deixar de ver.
  assert.deepEqual(
    room.result.soundboard.activity.map((item) => item.peerId),
    [ALICE, BOB],
  );
  room.unmount();
});

test('o mute do ouvinte não vira mensagem nem toca no volume da sala', () => {
  const { room, mesh } = mountRoom({ muted: () => true });
  const volumeAntes = room.result.volume;
  room.result.meshCallbacks.onMusicMessage!(ALICE, anuncio());
  assert.deepEqual(mesh.sent, [], 'nenhuma mensagem sai do lado de quem silencia');
  assert.equal(room.result.volume, volumeAntes, 'o volume da música não é tocado');
  room.unmount();
});

test('a janela de mute fecha sozinha depois da duração anunciada', async () => {
  const { room } = mountRoom({ muted: () => true });
  // 1ms de efeito + a cauda de guarda de 1,5s.
  room.result.meshCallbacks.onMusicMessage!(ALICE, anuncio({ durationMs: 1 }));
  assert.deepEqual(room.result.soundboard.silencedPeerIds, [ALICE]);
  await new Promise((resolve) => setTimeout(resolve, 1_700));
  assert.deepEqual(room.result.soundboard.silencedPeerIds, []);
  room.unmount();
});

test('acima do limite, o anúncio excedente é descartado antes de qualquer efeito', () => {
  const { room } = mountRoom({ muted: () => true });
  const receber = room.result.meshCallbacks.onMusicMessage!;
  for (let i = 0; i < BURST_LIMIT + 2; i += 1) receber(ALICE, anuncio({ soundId: `s${i}` }));

  assert.equal(room.result.soundboard.activity.length, BURST_LIMIT, 'só os que couberam na janela');
  assert.deepEqual(
    room.result.soundboard.floodingPeerIds,
    [ALICE],
    'a UI precisa saber quem estourou, para oferecer o mute em um clique',
  );
  // O balde é por peer: o excesso de um não atrapalha o outro.
  receber(BOB, anuncio({ soundId: 'de-bob' }));
  assert.equal(room.result.soundboard.activity[0]!.peerId, BOB);
  room.unmount();
});

test('a autoria é a conexão: um `from` no payload não muda quem é silenciado', () => {
  const { room } = mountRoom({ muted: (peerId) => peerId === ALICE });
  room.result.meshCallbacks.onMusicMessage!(BOB, anuncio({ from: ALICE }));
  assert.deepEqual(room.result.soundboard.silencedPeerIds, []);
  assert.equal(room.result.soundboard.activity[0]!.peerId, BOB);
  room.unmount();
});

// --------------------------------------------------------------- disparo

test('disparar anuncia antes de tocar e mixa no destination do canal de música', async () => {
  const { room, mesh } = mountRoom();
  const resultado = await room.result.soundboard.fire(favorite());
  assert.deepEqual(resultado, { ok: true });

  const anunciadas = mesh.sent.filter((m) => m.type === 'soundboard-play');
  assert.equal(anunciadas.length, 1);
  assert.equal(anunciadas[0]!.durationMs, 1200, 'a duração vem do buffer decodificado');
  assert.equal(anunciadas[0]!.soundId, 'fav-1');
  assert.ok(!('from' in anunciadas[0]!), 'nenhum campo de autoria no payload');

  // A corrida: o anúncio (SCTP) sai antes do áudio (SRTP), no mesmo tique.
  assert.deepEqual(startOrder, ['anuncio:soundboard-play', 'audio']);

  // O efeito vai parar no mesmo `MediaStreamDestination` do canal de música…
  const source = sources.at(-1)!;
  const ganho = source.connections.find((n) => (n as FakeNode).label === 'gain') as FakeNode;
  const compressor = ganho.connections[0] as FakeNode;
  assert.equal((compressor as FakeNode).label, 'compressor');
  assert.equal((compressor.connections[0] as FakeNode).label, 'mesh');
  // …e num ramo de monitoração, sem o qual quem dispara não ouve o próprio efeito.
  assert.ok(source.connections.some((n) => (n as FakeNode).label === 'gain'));

  // A sonda de CORS roda antes do download completo.
  assert.equal(fetchCalls.length, 2);
  assert.deepEqual((fetchCalls[0]!.init as { headers: unknown }).headers, { Range: 'bytes=0-0' });
  room.unmount();
});

test('o segundo disparo não substitui o track do sender de música', async () => {
  const { room, mesh } = mountRoom();
  await room.result.soundboard.fire(favorite());
  const chamadasDepoisDoPrimeiro = mesh.trackCalls.length;
  const track = mesh.localMusicTrack;
  assert.ok(track, 'o canal foi atado uma vez, no primeiro disparo');

  await room.result.soundboard.fire(favorite({ id: 'fav-2' }));
  assert.equal(mesh.trackCalls.length, chamadasDepoisDoPrimeiro, 'nenhum replaceTrack novo');
  assert.equal(mesh.localMusicTrack, track, 'o mesmo objeto de track');
  room.unmount();
});

test('um disparo novo corta o efeito anterior: um efeito por vez', async () => {
  const { room } = mountRoom();
  await room.result.soundboard.fire(favorite());
  const primeiro = sources.at(-1)!;
  await room.result.soundboard.fire(favorite({ id: 'fav-2' }));
  assert.equal(primeiro.stopCalls, 1);
  assert.equal(sources.length, 2, 'um nó novo por disparo — o anterior não é reusado');
  room.unmount();
});

test('efeito mais longo que a janela é cortado em MAX_SOUND_MS', async () => {
  decodedDurationSec = 40;
  try {
    const { room, mesh } = mountRoom();
    await room.result.soundboard.fire(favorite());
    assert.equal(mesh.sent.at(-1)!.durationMs, 15_000);
    // O terceiro argumento de `start` é o corte de duração, em segundos.
    assert.deepEqual(sources.at(-1)!.startArgs, [0, 0, 15]);
    room.unmount();
  } finally {
    decodedDurationSec = 1.2;
  }
});

test('URL sem CORS não vira silêncio: recusa com mensagem e nada vai ao fio', async () => {
  const anterior = fetchImpl;
  // O que o MyInstants faz hoje: 200 sem `Access-Control-Allow-Origin`, o que
  // no navegador é uma rejeição do `fetch`.
  fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  try {
    const { room, mesh } = mountRoom();
    const resultado = await room.result.soundboard.fire(favorite());
    assert.deepEqual(resultado, { ok: false, reason: 'cors' });
    assert.deepEqual(mesh.sent, [], 'sem anúncio: ninguém é avisado de um som que não existe');
    assert.equal(sources.length, 0, 'nenhum nó de áudio foi criado');
    room.unmount();
  } finally {
    fetchImpl = anterior;
  }
});

test(`o disparo ${BURST_LIMIT + 1} em 5s é recusado, e não vai ao fio`, async () => {
  const { room, mesh } = mountRoom();
  for (let i = 0; i < BURST_LIMIT; i += 1) {
    const ok = await room.result.soundboard.fire(favorite({ id: `f${i}` }));
    assert.deepEqual(ok, { ok: true }, `disparo ${i + 1} deveria passar`);
  }
  const excedente = await room.result.soundboard.fire(favorite({ id: 'demais' }));
  assert.deepEqual(excedente, { ok: false, reason: 'rate-limited' });
  assert.equal(mesh.sent.filter((m) => m.type === 'soundboard-play').length, BURST_LIMIT);
  assert.equal(sources.length, BURST_LIMIT, 'nenhum áudio do disparo recusado');
  assert.ok(room.result.soundboard.cooldownMs > 0, 'o botão mostra quanto falta');
  room.unmount();
});

test('disparar por cima de uma faixa tocando não a interrompe nem troca o track', async () => {
  const { room, mesh } = mountRoom();
  // A sala está tocando uma URL, e quem transmite sou eu.
  room.result.meshCallbacks.onMusicMessage!(ALICE, {
    type: 'music-snapshot',
    enabled: true,
    lamport: 9,
    tombstones: [],
    entries: [
      {
        id: 'faixa-1',
        kind: 'url',
        title: 'Disco',
        sourceRef: 'https://cdn.exemplo.com/disco.mp3',
        durationSec: 180,
        addedBy: SELF,
        addedByName: 'Eu',
        lamport: 3,
      },
    ],
    playback: {
      version: 4,
      ownerId: SELF,
      entryId: 'faixa-1',
      positionSec: 0,
      playing: true,
      delivery: 'stream',
    },
  } as MusicMessage);
  await settle(6);

  const elemento = audioElements.at(-1)!;
  assert.ok(elemento, 'a faixa foi carregada num <audio>');
  assert.equal(elemento.paused, false, 'a faixa está tocando');
  const trackDaFaixa = mesh.localMusicTrack;
  assert.ok(trackDaFaixa, 'o canal de música está no ar por causa da faixa');
  const chamadasAntes = mesh.trackCalls.length;
  elemento.currentTime = 12.5;

  const resultado = await room.result.soundboard.fire(favorite());
  assert.deepEqual(resultado, { ok: true });

  assert.equal(elemento.pauseCalls, 0, 'a faixa não é pausada');
  assert.equal(elemento.currentTime, 12.5, 'a posição da faixa não é tocada');
  assert.equal(elemento.paused, false, 'a faixa continua tocando');
  assert.equal(audioElements.at(-1), elemento, 'nenhum <audio> novo por disparo');
  assert.equal(mesh.trackCalls.length, chamadasAntes, 'nenhum replaceTrack novo');
  assert.equal(mesh.localMusicTrack, trackDaFaixa, 'o mesmo track do sender');
  // Os dois sinais somam no mesmo destino: é isso que faz a sala ouvir os dois.
  const compressor = (
    sources.at(-1)!.connections.find((n) => (n as FakeNode).label === 'gain') as FakeNode
  ).connections[0] as FakeNode;
  assert.equal((compressor.connections[0] as FakeNode).label, 'mesh');
  room.unmount();
});

test('abrir o painel ata o canal antes do primeiro clique; fechar não o solta na hora', async () => {
  const { room, mesh } = mountRoom();
  room.result.soundboard.setPanelOpen(true);
  await settle();
  assert.ok(mesh.localMusicTrack, 'quem vai disparar abriu o painel: o canal já está no ar');

  room.result.soundboard.setPanelOpen(false);
  await settle();
  assert.ok(mesh.localMusicTrack, 'a cauda de 5s evita perder o ataque do efeito seguinte');
  room.unmount();
});
