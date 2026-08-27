/**
 * QA da WTK-MEET-13 — a **fiação** entre o erro do YouTube e a fila da sala.
 *
 * `youtubePlayer.test.ts` já cobre as duas pontas isoladas: o envelope emite
 * `{ reason, code, videoId }`, e `planYouTubeError` decide retentar/pular/avisar.
 * O que não tinha teste era o meio — `handlePlayerError`, em `useMusicRoom.js` —
 * e o meio é exatamente onde o bug morava: o envelope emitia
 * `('youtube-error', 150)` num handler `(code, entryId)`, o `150` reprovava na
 * guarda de string, caía no fallback e o código era descartado. Uma fiação
 * errada de novo (ler `payload.errorCode`, esquecer o `isOwner`, retentar em
 * laço) deixa **todos** os testes puros verdes. Estes aqui é que quebram.
 *
 * Por isso nada aqui chama `planYouTubeError`: o caminho exercitado vai do
 * `onError` do player da Google até a fila que a sala enxerga. O que se afirma é
 * só o que o hook devolve (`queue`, `notice`) e o que ele manda para o mesh —
 * a mesma superfície que o `Room` e os outros participantes veem.
 *
 * Duas costuras para isso rodar em `node --test` puro, sem DOM e sem renderer,
 * ambas com precedente no projeto:
 *
 * 1. **Dublê de DOM e de `window.YT`**, como em `youtubePlayer.test.ts`. O
 *    envelope sob teste é o de verdade; quem é falso é a Google.
 * 2. **Render de hook com dispatcher próprio**, como o de `settingsNoiseToggle`,
 *    só que com `useEffect` rodando de verdade (com deps e cleanup) — sem os
 *    efeitos não existe reconciliação, e sem reconciliação o player nunca é
 *    construído. `useCallback`/`useMemo` memorizam pelas deps de propósito: com
 *    identidade nova a cada render, o efeito de reconciliação dispararia em
 *    todo tique de posição e o teste mediria um laço que o React não tem.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// ------------------------------------------------------------- dublês do DOM

/**
 * Os dublês daqui formam uma árvore de verdade com só o que o envelope usa. Os
 * `as unknown as` estão na fronteira com `document`/`window`, comentados.
 */
interface NoFalso {
  tagName: string;
  children: NoFalso[];
  parent: NoFalso | null;
  readonly firstChild: NoFalso | null;
  appendChild(child: NoFalso): NoFalso;
  removeChild(child: NoFalso): NoFalso;
}

function makeNode(tag: string): NoFalso {
  return {
    tagName: String(tag).toUpperCase(),
    children: [] as NoFalso[],
    parent: null as NoFalso | null,
    get firstChild() {
      return this.children[0] || null;
    },
    appendChild(child: NoFalso) {
      child.parent?.removeChild(child);
      child.parent = this;
      this.children.push(child);
      return child;
    },
    removeChild(child: NoFalso) {
      const index = this.children.indexOf(child);
      if (index >= 0) this.children.splice(index, 1);
      child.parent = null;
      return child;
    },
  };
}

// A fronteira com o navegador: o envelope toca três coisas do `document`.
globalThis.document = {
  head: { appendChild: () => {} },
  createElement: (tag: string) => makeNode(tag),
  querySelector: () => null,
} as unknown as Document;

/**
 * Um `YT` só para o arquivo inteiro, e não um por caso: `loadYouTubeApi` guarda
 * a promessa no módulo, então o segundo teste receberia o `YT` do primeiro de
 * qualquer forma. Os casos se isolam contando players a partir do que já existia.
 */
/** As opções que o envelope passa ao `YT.Player`. */
interface OpcoesDoPlayer {
  videoId: string;
  events: {
    onReady?: (event: { target: unknown }) => void;
    onStateChange?: (event: { data: number; target?: unknown }) => void;
    onError?: (event: { data: number }) => void;
  };
  [campo: string]: unknown;
}

class FakePlayer {
  options: OpcoesDoPlayer;
  videoId: string;
  destroyed: boolean;
  state: number;
  iframe: NoFalso;

  constructor(mount: NoFalso, options: OpcoesDoPlayer) {
    this.options = options;
    this.videoId = options.videoId;
    this.destroyed = false;
    this.state = 2;

    // O player real troca o elemento recebido por um `<iframe>`.
    const parent = mount.parent;
    // O `createElement` dublê devolve um `NoFalso`; a assinatura promete um
    // `HTMLIFrameElement`.
    this.iframe = document.createElement('iframe') as unknown as NoFalso;
    parent?.appendChild(this.iframe);
    if (mount.parent === parent) parent?.removeChild(mount);

    YT.players.push(this);
    setTimeout(() => {
      if (!this.destroyed) this.options.events.onReady?.({ target: this });
    }, 0);
  }

  /** O erro chega por aqui — é o evento cru da IFrame API, com o código em `data`. */
  fail(code: number) {
    this.options.events.onError?.({ data: code });
  }

  playVideo() {
    this.state = 1;
  }

  pauseVideo() {
    this.state = 2;
  }

  stopVideo() {}
  seekTo() {}
  setVolume() {}
  getDuration() {
    return 240;
  }

  getVideoData() {
    return { title: 'Faixa do YouTube' };
  }

  getCurrentTime() {
    return 0;
  }

  getPlayerState() {
    return this.state;
  }

  destroy() {
    this.destroyed = true;
    this.iframe.parent?.removeChild(this.iframe);
  }
}

const YT: {
  PlayerState: { ENDED: number; PLAYING: number; BUFFERING: number };
  players: FakePlayer[];
  Player: typeof FakePlayer;
} = { PlayerState: { ENDED: 0, PLAYING: 1, BUFFERING: 3 }, players: [], Player: FakePlayer };

// A fronteira: o dublê tem o `Player` e três dos seis `PlayerState`, que é o
// que o envelope usa.
globalThis.window = { YT } as unknown as Window & typeof globalThis;

const React = await import('react');
/**
 * O dispatcher de hooks do React não tem tipo público — é por isso que o campo
 * se chama assim. O cast é a fronteira: daqui para baixo quem manda é o
 * dispatcher deste arquivo.
 */
const internals = (
  React.default as unknown as {
    __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: {
      ReactCurrentDispatcher: { current: unknown };
    };
  }
).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
const { useMusicRoom } = await import('../src/lib/useMusicRoom.js');

import type { QueueEntry } from '../src/lib/musicSession.js';
import type { MusicMessage } from '../src/lib/musicProtocol.js';

// ------------------------------------------------------------ render de hook

const sameDeps = (a: unknown, b: unknown) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));

/**
 * Roda um hook fora do React: dispatcher próprio, render síncrono a cada
 * `setState` e efeitos executados na ordem, com comparação de deps e cleanup.
 *
 * O laço de render tem trava (`guard`): um efeito que muda estado a cada
 * execução é um bug de verdade, e aqui ele falha alto em vez de travar a suíte.
 */
/** Uma casa do dispatcher: cada hook guarda o que precisa aqui. */
interface Slot {
  value?: unknown;
  current?: unknown;
  deps?: unknown;
  cleanup?: (() => void) | null;
  first?: boolean;
}

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
  // O React chama os dois; aqui eles são o mesmo, e é isso que a linha diz.
  const dispatcherCompleto = { ...dispatcher, useLayoutEffect: dispatcher.useEffect };

  function renderOnce() {
    cursor = 0;
    const previous = internals.ReactCurrentDispatcher.current;
    internals.ReactCurrentDispatcher.current = dispatcherCompleto;
    try {
      result = hook(props);
    } finally {
      internals.ReactCurrentDispatcher.current = previous;
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
      return result;
    },
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}

// ------------------------------------------------------------------ cenário

const SELF = 'peer-eu';
const OTHER = 'peer-outro';

/** Deixa correr o que estiver pendente — o `load()` do envelope tem awaits no meio. */
async function settle(turns = 4) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Espera a condição virar verdadeira, sem prender a suíte se ela nunca virar. */
async function waitFor(predicate: () => boolean, { timeout = 2_500, label = 'condição' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`tempo esgotado esperando: ${label}`);
  return false;
}

/** A retentativa espera 700ms; 1s cobre a espera e sobra margem para o load. */
const AFTER_RETRY_MS = 1_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function ytEntry({
  id,
  sourceRef,
  title,
  lamport = 1,
  addedBy = OTHER,
}: {
  id: string;
  sourceRef: string;
  title: string;
  lamport?: number;
  addedBy?: string;
}): QueueEntry {
  return { id, kind: 'youtube', title, sourceRef, durationSec: 240, addedBy, addedByName: 'Outro', lamport };
}

function snapshotMessage({ entries, playback }: { entries: QueueEntry[]; playback: unknown }) {
  return { type: 'music-snapshot', enabled: true, lamport: 9, entries, tombstones: [], playback };
}

/**
 * Sala com uma fila de YouTube tocando, do ponto de vista deste participante.
 * `ownerId` é o que separa "sou eu quem manda na fila" de "só assisto": é o
 * mesmo hook, o mesmo erro, e a diferença de comportamento tem que sair daí.
 */
async function mountRoom({
  ownerId,
  entries,
  entryId,
  version = 1,
}: {
  ownerId: string;
  entries: QueueEntry[];
  entryId: string;
  version?: number;
}) {
  const sent: MusicMessage[] = [];
  const props = {
    meshRef: {
      current: {
        sendMusicMessage: (payload: MusicMessage) => sent.push(payload),
        setMusicTrack: async () => {},
      },
    },
    participants: new Map([
      [SELF, {}],
      [OTHER, {}],
    ]),
    getSelfId: () => SELF,
    displayName: 'Eu',
    pushToast: () => {},
  };

  // O cast das props: o hook pede o `meshRef` do `WebRTCMesh`, e o dublê tem
  // os dois métodos que este roteiro exercita.
  const room = renderHook(useMusicRoom, props as unknown as Parameters<typeof useMusicRoom>[0]);
  // O host é do React na vida real; aqui o nó falso faz o mesmo papel.
  room.result!.youtubeHostRef.current = makeNode('div') as unknown as HTMLDivElement;

  const before = YT.players.length;
  room.result!.meshCallbacks.onMusicMessage!(
    OTHER,
    snapshotMessage({
      entries,
      playback: { version, ownerId, entryId, positionSec: 0, playing: true, delivery: 'local' },
    }) as MusicMessage,
  );
  await waitFor(() => YT.players.length > before, { label: 'o player da faixa corrente subir' });
  await settle();

  return {
    room,
    sent,
    /** O player que está no ar agora — o que recebe o erro da Google. */
    player: () => YT.players.at(-1)!,
    queueIds: () => room.result!.queue.map((entry) => entry.id),
    notice: () => room.result!.notice,
    /** Quantos players a Google construiu desde um marco — a recarga é um a mais. */
    playersSince: (mark: number) => YT.players.length - mark,
    /** Quantas vezes **este vídeo** subiu de novo desde o marco. */
    reloadsSince: (mark: number, videoId: string) => YT.players.slice(mark).filter((player) => player.videoId === videoId).length,
    mark: () => YT.players.length,
    unmount: () => room.unmount(),
  };
}

const removals = (sent: MusicMessage[]) => sent.filter((message) => message.type === 'music-queue-remove');

const TRACK_A = ytEntry({ id: 'entry-a', sourceRef: 'aaaaaaaaaaa', title: 'Faixa A', lamport: 1 });
const TRACK_B = ytEntry({ id: 'entry-b', sourceRef: 'bbbbbbbbbbb', title: 'Faixa B', lamport: 2 });

// ------------------------------------------------- o código chega ao handler

test('AC1. o código do erro chega ao handler: cada classe produz um aviso diferente na sala', async () => {
  // O bug era este e só este: o código existia no evento e não era lido. Se
  // voltar a ser descartado, os três avisos abaixo viram o mesmo texto.
  const notices: string[] = [];
  for (const code of [2, 100, 101]) {
    const room = await mountRoom({ ownerId: SELF, entries: [TRACK_A, TRACK_B], entryId: 'entry-a' });
    try {
      room.player().fail(code);
      notices.push(room.notice()!);
    } finally {
      room.unmount();
    }
  }

  assert.match(notices[0], /não é um vídeo válido/i); // 2
  assert.match(notices[1], /removido ou privado/i); // 100
  assert.match(notices[2], /só dá para ouvir lá/i); // 101
  assert.equal(new Set(notices).size, 3, 'três códigos, três avisos — nada de mensagem genérica para tudo');
  for (const notice of notices) assert.match(notice, /Faixa A/, 'o aviso nomeia a faixa que falhou');
});

// -------------------------------------------------------- erro permanente

test('AC2. erro permanente com o dono: a faixa sai da fila na hora, sem recarga nenhuma', async () => {
  for (const code of [2, 100, 101, 150]) {
    const room = await mountRoom({ ownerId: SELF, entries: [TRACK_A, TRACK_B], entryId: 'entry-a' });
    const mark = room.mark();
    try {
      room.player().fail(code);

      assert.deepEqual(room.queueIds(), ['entry-b'], `código ${code}: a faixa que falhou sai da fila`);
      assert.deepEqual(
        removals(room.sent).map((message) => message.entryId),
        ['entry-a'],
        `código ${code}: a sala inteira fica sabendo`,
      );

      // Pular é imediato: nada de esperar 700ms por uma recarga que não vem.
      // (A faixa B não sobe aqui, e é o correto: quem publica a faixa seguinte é
      // o dono dela, que neste cenário é o outro participante.)
      await sleep(AFTER_RETRY_MS);
      assert.equal(room.reloadsSince(mark, 'aaaaaaaaaaa'), 0, `código ${code}: a faixa que falhou não é recarregada`);
    } finally {
      room.unmount();
    }
  }
});

// ------------------------------------------------------- erro transitório

test('AC3. erro transitório recarrega o player uma vez e não tira a faixa da sala', async () => {
  for (const code of [5, 153]) {
    const room = await mountRoom({ ownerId: SELF, entries: [TRACK_A, TRACK_B], entryId: 'entry-a' });
    const mark = room.mark();
    try {
      room.player().fail(code);

      assert.match(room.notice()!, /Tentando de novo/i, `código ${code}: o aviso diz que ainda há esperança`);
      assert.deepEqual(room.queueIds(), ['entry-a', 'entry-b'], `código ${code}: a fila continua inteira`);
      assert.deepEqual(removals(room.sent), [], `código ${code}: nada de pular a faixa da sala`);

      await waitFor(() => room.playersSince(mark) === 1, { label: `a recarga do código ${code}` });
      assert.equal(room.player().videoId, 'aaaaaaaaaaa', 'a recarga é da mesma faixa');
      assert.deepEqual(room.queueIds(), ['entry-a', 'entry-b'], 'e a faixa continua na fila depois dela');
    } finally {
      room.unmount();
    }
  }
});

test('AC4. a recarga que também falha pula (dono) — e não abre uma terceira tentativa', async () => {
  const room = await mountRoom({ ownerId: SELF, entries: [TRACK_A, TRACK_B], entryId: 'entry-a' });
  const mark = room.mark();
  try {
    room.player().fail(5);
    await waitFor(() => room.playersSince(mark) === 1, { label: 'a primeira recarga' });

    const afterRetry = room.mark();
    room.player().fail(5); // a mesma faixa falhando de novo

    assert.match(room.notice()!, /Não consegui tocar/i, 'a segunda falha não promete outra tentativa');
    assert.deepEqual(room.queueIds(), ['entry-b'], 'esgotada a retentativa, o dono pula');
    assert.deepEqual(
      removals(room.sent).map((message) => message.entryId),
      ['entry-a'],
    );

    await sleep(AFTER_RETRY_MS);
    assert.equal(room.reloadsSince(afterRetry, 'aaaaaaaaaaa'), 0, 'nenhuma terceira tentativa da faixa A');
  } finally {
    room.unmount();
  }
});

test('AC4. sem laço infinito: dez falhas seguidas na mesma faixa não geram dez recargas', async () => {
  // O peer que não é dono é o caso perigoso: ele não pode pular, então é nele
  // que um contador mal zerado viraria recarga eterna — 5 a cada 700ms, para
  // sempre, sem nada na tela denunciando.
  const room = await mountRoom({ ownerId: OTHER, entries: [TRACK_A, TRACK_B], entryId: 'entry-a' });
  const mark = room.mark();
  try {
    for (let i = 0; i < 10; i += 1) {
      room.player().fail(5);
      await settle();
    }
    await sleep(AFTER_RETRY_MS);

    assert.equal(room.playersSince(mark), 1, 'uma recarga ao todo, não uma por falha');
    assert.deepEqual(room.queueIds(), ['entry-a', 'entry-b'], 'e a fila da sala segue intacta');
  } finally {
    room.unmount();
  }
});

// ------------------------------------------------ a fila é da sala, não do peer

test('AC5. peer que não é dono nunca mexe na fila da sala, com nenhum código', async () => {
  for (const code of [2, 5, 100, 101, 150, 153, 999]) {
    const room = await mountRoom({ ownerId: OTHER, entries: [TRACK_A, TRACK_B], entryId: 'entry-a' });
    try {
      room.player().fail(code);
      await sleep(code === 5 || code === 153 ? AFTER_RETRY_MS : 0);
      room.player().fail(code); // e a segunda falha, que no dono seria o pulo

      assert.deepEqual(room.queueIds(), ['entry-a', 'entry-b'], `código ${code}: a fila é da sala`);
      assert.deepEqual(room.sent, [], `código ${code}: nem uma mensagem sai deste peer`);
      assert.ok(room.notice(), `código ${code}: quem errou fica sabendo, ainda que só localmente`);
    } finally {
      room.unmount();
    }
  }
});

test('AC5. a retentativa do peer não-dono é local: recarrega o player e não publica nada', async () => {
  const room = await mountRoom({ ownerId: OTHER, entries: [TRACK_A, TRACK_B], entryId: 'entry-a' });
  const mark = room.mark();
  try {
    room.player().fail(153);
    await waitFor(() => room.playersSince(mark) === 1, { label: 'a recarga local do peer' });

    assert.equal(room.player().videoId, 'aaaaaaaaaaa');
    assert.deepEqual(room.sent, [], 'a recuperação de quem não é dono não trafega');
  } finally {
    room.unmount();
  }
});

// ------------------------------------------------------- contador por faixa

test('AC6. o contador zera ao trocar de faixa: a faixa nova ganha a retentativa dela', async () => {
  const room = await mountRoom({ ownerId: OTHER, entries: [TRACK_A, TRACK_B], entryId: 'entry-a' });
  const markA = room.mark();
  try {
    room.player().fail(5); // faixa A gasta a retentativa dela
    await waitFor(() => room.playersSince(markA) === 1, { label: 'a recarga da faixa A' });

    // A sala troca para a faixa B.
    room.room.result!.meshCallbacks.onMusicMessage(
      OTHER,
      snapshotMessage({
        entries: [TRACK_A, TRACK_B],
        playback: { version: 5, ownerId: OTHER, entryId: 'entry-b', positionSec: 0, playing: true, delivery: 'local' },
      }),
    );
    await waitFor(() => room.player()?.videoId === 'bbbbbbbbbbb', { label: 'a faixa B subir' });

    const markB = room.mark();
    room.player().fail(5);

    assert.match(room.notice()!, /Tentando de novo/i, 'a faixa B não herda a tentativa gasta pela A');
    await waitFor(() => room.playersSince(markB) === 1, { label: 'a recarga da faixa B' });
    assert.equal(room.player().videoId, 'bbbbbbbbbbb');
  } finally {
    room.unmount();
  }
});

test('AC6. trocar de faixa cancela a retentativa pendente da anterior', async () => {
  // A retentativa da A carregando por cima da B é o mesmo gênero de bug
  // intermitente que a `generation` do envelope existe para conter.
  const room = await mountRoom({ ownerId: OTHER, entries: [TRACK_A, TRACK_B], entryId: 'entry-a' });
  try {
    room.player().fail(5);
    room.room.result!.meshCallbacks.onMusicMessage(
      OTHER,
      snapshotMessage({
        entries: [TRACK_A, TRACK_B],
        playback: { version: 5, ownerId: OTHER, entryId: 'entry-b', positionSec: 0, playing: true, delivery: 'local' },
      }),
    );
    await waitFor(() => room.player()?.videoId === 'bbbbbbbbbbb', { label: 'a faixa B subir' });

    const markB = room.mark();
    await sleep(AFTER_RETRY_MS);

    assert.equal(room.playersSince(markB), 0, 'nenhuma recarga depois da troca');
    assert.equal(room.player().videoId, 'bbbbbbbbbbb', 'a faixa A não volta por cima da B');
  } finally {
    room.unmount();
  }
});

// --------------------------------------------- erro de faixa que já não toca

test('AC7. erro de um vídeo que já não é a faixa corrente não avisa nem mexe na fila', async () => {
  // A corrida real: a sala já trocou para a faixa B e o iframe da A, que ainda
  // não foi derrubado, cospe o erro dele. Agir sobre a faixa corrente por causa
  // do erro de outra é a segunda metade da causa raiz — e tiraria da fila uma
  // faixa que nunca falhou.
  const room = await mountRoom({ ownerId: SELF, entries: [TRACK_A, TRACK_B], entryId: 'entry-a' });
  const playerA = room.player();
  try {
    room.room.result!.meshCallbacks.onMusicMessage(
      OTHER,
      snapshotMessage({
        entries: [TRACK_A, TRACK_B],
        playback: { version: 5, ownerId: SELF, entryId: 'entry-b', positionSec: 0, playing: true, delivery: 'local' },
      }),
    );
    playerA.fail(100); // no mesmo turno: a troca já valeu, o iframe da A ainda está lá

    assert.equal(room.notice(), null, 'a sala não vê aviso de uma faixa que já saiu de cena');
    await waitFor(() => room.player()?.videoId === 'bbbbbbbbbbb', { label: 'a faixa B subir' });
    assert.deepEqual(room.queueIds(), ['entry-a', 'entry-b'], 'e nenhuma faixa é removida da fila');
    assert.deepEqual(removals(room.sent), [], 'nada de anunciar remoção para a sala');
  } finally {
    room.unmount();
  }
});
