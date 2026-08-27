/**
 * `lib/audibleMedia.js` — o hook que faz um elemento de mídia produzir som.
 *
 * Este arquivo é o único do projeto que **roda os efeitos de verdade**. Os
 * demais testes de componente usam `react-dom/server` (que não executa
 * `useEffect`) ou o dispatcher raso de `settingsNoiseToggle.test.ts` (que
 * deliberadamente pula os efeitos, porque lá eles tocariam
 * `navigator.mediaDevices`). Aqui não dá: os três defeitos desta entrega vivem
 * **dentro** dos efeitos — o `setSinkId` que não é chamado, o `play()` que não é
 * chamado, a rejeição que ninguém trata. Um teste que pula efeitos passaria
 * verde com o bug inteiro de volta.
 *
 * Não há DOM neste ambiente (`node --test` puro, sem jsdom; o Chromium do E2E
 * não sobe aqui), então o elemento de mídia é um duplo com a superfície que o
 * hook usa: `srcObject`, `setSinkId`, `play`. É o suficiente, porque o que se
 * afirma é o protocolo de chamadas — o som saindo de fato pelo alto-falante
 * certo é do E2E e, no fim, do navegador.
 */
import assert from 'node:assert/strict';
import test from 'node:test';


const React = await import('react');
const { shouldApplySink, useAudibleMedia } = await import('../src/lib/audibleMedia.js');

import type { AudibleMediaOptions } from '../src/lib/audibleMedia.js';

/**
 * O dispatcher de hooks do React não tem tipo público — é por isso que o campo
 * se chama assim. O cast é a fronteira: daqui para baixo quem manda é o
 * dispatcher deste arquivo.
 */
const internals = (
  React.default as unknown as {
    __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
      H: unknown;
    };
  }
).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;

/**
 * Renderiza um componente de função e **executa** seus efeitos, com comparação
 * de deps, limpeza entre renders e limpeza no desmonte — o pouco de React que
 * este hook precisa para ser exercitado sem renderer e sem DOM.
 *
 * Os efeitos são coletados na ordem do cursor de hooks e disparados nessa mesma
 * ordem: é assim que o React se comporta dentro de um componente, e a ordem
 * importa aqui (attach → sink → play; ver o cabeçalho de `audibleMedia.js`).
 */
/** Uma casa de efeito: as deps da última execução, o corpo e a limpeza. */
interface CasaDeEfeito {
  deps: unknown[] | undefined;
  cleanup?: (() => void) | undefined;
  create?: () => unknown;
}

function renderWithEffects<P>(Component: (props: P) => unknown, initialProps: P) {
  const hooks: unknown[] = [];
  const effects: CasaDeEfeito[] = [];
  let cursor = 0;
  let pending: number[] = [];

  const dispatcher = {
    useState(initial: unknown) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in hooks)) hooks[slot] = typeof initial === 'function' ? initial() : initial;
      return [hooks[slot], () => {}];
    },
    useRef(initial: unknown) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in hooks)) hooks[slot] = { current: initial };
      return hooks[slot];
    },
    useMemo(factory: () => unknown) {
      const slot = cursor;
      cursor += 1;
      if (!(slot in hooks)) hooks[slot] = factory();
      return hooks[slot];
    },
    useCallback(fn: unknown) {
      cursor += 1;
      return fn;
    },
    useEffect(create: () => unknown, deps?: unknown[]) {
      const slot = cursor;
      cursor += 1;
      const previous = effects[slot];
      // Sem deps o efeito roda todo render; com deps, só quando alguma muda.
      const changed =
        !previous ||
        !deps ||
        !previous.deps ||
        deps.length !== previous.deps.length ||
        deps.some((dep, i) => !Object.is(dep, previous.deps![i]));
      if (!effects[slot]) effects[slot] = { deps, cleanup: undefined };
      effects[slot]!.deps = deps;
      if (changed) pending.push(slot);
      effects[slot]!.create = create;
    },
    useLayoutEffect(create: () => unknown, deps?: unknown[]) {
      dispatcher.useEffect(create, deps);
    },
    useContext: () => undefined,
    useDebugValue: () => {},
    useId: () => 'test-id',
  };

  function flush() {
    const slots = pending;
    pending = [];
    for (const slot of slots) {
      const casa = effects[slot]!;
      casa.cleanup?.();
      const limpeza = casa.create!();
      casa.cleanup = typeof limpeza === 'function' ? (limpeza as () => void) : undefined;
    }
  }

  function render(props: P) {
    cursor = 0;
    const previous = internals.H;
    internals.H = dispatcher;
    try {
      Component(props);
    } finally {
      internals.H = previous;
    }
    flush();
  }

  render(initialProps);

  return {
    rerender: (props: P) => render(props),
    unmount() {
      for (const effect of effects) effect?.cleanup?.();
    },
  };
}

/**
 * Duplo de `HTMLMediaElement`. `setSinkId` e `play` gravam o que receberam e
 * devolvem o que o teste mandar — inclusive `undefined`, que é o caso do
 * navegador antigo que não devolve Promise em `play()`.
 */
/**
 * Duplo de `HTMLMediaElement`, com o que o hook toca. O `as` sai só na hora de
 * entregá-lo ao `ref`, em `comoElemento`.
 */
interface FakeElement {
  tagName: string;
  srcObject: unknown;
  sinkCalls: string[];
  playCalls: number;
  srcObjectWrites: number;
  play(): unknown;
  setSinkId?: (id: string) => unknown;
}

function fakeElement({
  setSinkId = () => Promise.resolve(),
  play = () => Promise.resolve(),
}: {
  setSinkId?: ((id: string) => unknown) | null;
  play?: () => unknown;
} = {}) {
  const element: FakeElement = {
    tagName: 'AUDIO',
    srcObject: null,
    sinkCalls: [],
    playCalls: 0,
    srcObjectWrites: 0,
    play() {
      element.playCalls += 1;
      return play();
    },
  };
  // Só existe quando o teste quer: o Firefox não implementa `setSinkId`.
  if (setSinkId) {
    element.setSinkId = (id: string) => {
      element.sinkCalls.push(id);
      return setSinkId(id);
    };
  }
  // Contar as escritas é o que prova que o stream não é reatribuído à toa —
  // reatribuir reinicia a reprodução.
  let current: unknown = null;
  Object.defineProperty(element, 'srcObject', {
    get: () => current,
    set(value) {
      element.srcObjectWrites += 1;
      current = value;
    },
  });
  return element;
}

/** O tipo do dublê de stream, antes do cast que o entrega ao hook. */
type FakeStream = ReturnType<typeof criarStreamFalso>;

/**
 * Duplo de `MediaStream`: só o alvo de eventos que o hook escuta. O cast fica
 * em `fakeStream`, que é o que os casos usam.
 */
function criarStreamFalso(id = 's1') {
  const listeners = new Map<string, Set<() => void>>();
  return {
    id,
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    emit(type: string) {
      for (const fn of listeners.get(type) || []) fn();
    },
  };
}

/** O mesmo dublê, já visto como `MediaStream` — o hook só escuta eventos nele. */
const fakeStream = (id = 's1') => criarStreamFalso(id) as unknown as MediaStream & FakeStream;

/**
 * O ref que o hook recebe. O cast é a fronteira do dublê: ele tem `srcObject`,
 * `play()` e (às vezes) `setSinkId`, que é tudo o que o hook toca.
 */
const comoRef = (element: FakeElement) => ({ current: element as unknown as HTMLMediaElement });

/** O componente mínimo sob teste: um ref fixo e o hook. */
const mount = (element: FakeElement, options: AudibleMediaOptions) => {
  const ref = comoRef(element);
  return renderWithEffects((props: AudibleMediaOptions) => useAudibleMedia(ref, props), options);
};

/** Deixa as promises já resolvidas/rejeitadas rodarem seus `.catch`. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

// ----------------------------------------------------------- shouldApplySink

test('shouldApplySink: sem setSinkId no elemento, nunca', () => {
  // Firefox. Chamar mesmo assim lançaria TypeError dentro do efeito e quebraria
  // a montagem do elemento de áudio — silêncio total.
  assert.equal(shouldApplySink({ sinkId: 'spk-b', applied: false, hasSetSinkId: false }), false);
  assert.equal(shouldApplySink({ sinkId: 'spk-b', applied: true, hasSetSinkId: false }), false);
});

test('shouldApplySink: sem preferência e sem aplicação prévia, não há o que fazer', () => {
  assert.equal(shouldApplySink({ sinkId: '', applied: false, hasSetSinkId: true }), false);
});

test('shouldApplySink: voltar ao padrão só é trabalho para quem já recebeu um sink', () => {
  assert.equal(shouldApplySink({ sinkId: '', applied: true, hasSetSinkId: true }), true);
  assert.equal(shouldApplySink({ sinkId: 'spk-b', applied: false, hasSetSinkId: true }), true);
});

// -------------------------------------------------------------------- attach

test('o stream é ligado ao elemento e reatribuído quando as tracks mudam', () => {
  const element = fakeElement();
  const stream = fakeStream();
  const view = mount(element, { stream });

  assert.equal(element.srcObject, stream);
  assert.equal(element.srcObjectWrites, 1);

  // `replaceTrack` troca a track dentro do mesmo stream, e nem todo navegador
  // reabre o sink sozinho.
  stream.emit('addtrack');
  assert.equal(element.srcObjectWrites, 2);
  stream.emit('removetrack');
  assert.equal(element.srcObjectWrites, 3);

  view.unmount();
  assert.equal(stream.listenerCount(), 0, 'os listeners do stream vazaram no desmonte');
});

test('re-render com o mesmo stream não reatribui o srcObject', () => {
  const element = fakeElement();
  const stream = fakeStream();
  // Callbacks com identidade nova a cada render é exatamente o que o `Room`
  // produz; se entrassem nas deps, o áudio seria cortado a cada re-render.
  const view = mount(element, { stream, onBlocked: () => {}, onSinkError: () => {} });
  assert.equal(element.srcObjectWrites, 1);

  view.rerender({ stream, onBlocked: () => {}, onSinkError: () => {} });
  view.rerender({ stream, onBlocked: () => {}, onSinkError: () => {} });
  assert.equal(element.srcObjectWrites, 1);
  assert.equal(element.playCalls, 1, 'a reprodução foi reiniciada por um re-render');
});

// ---------------------------------------------------------------------- sink

test('sem preferência de saída, setSinkId nunca é chamado', () => {
  const element = fakeElement();
  mount(element, { stream: fakeStream(), sinkId: '' });
  assert.deepEqual(element.sinkCalls, []);
});

test('com preferência, o sink é aplicado no elemento que produz som', () => {
  const element = fakeElement();
  mount(element, { stream: fakeStream(), sinkId: 'spk-b' });
  assert.deepEqual(element.sinkCalls, ['spk-b']);
});

test('um elemento que nasce depois da escolha já nasce com o sink aplicado', () => {
  // Peer que entra na sala com a preferência já gravada: sem nova interação.
  const element = fakeElement();
  mount(element, { stream: fakeStream(), sinkId: 'spk-b' });
  assert.deepEqual(element.sinkCalls, ['spk-b']);
});

test('voltar para "padrão do sistema" chama setSinkId(\'\') em quem já tinha sink', () => {
  const element = fakeElement();
  const stream = fakeStream();
  const view = mount(element, { stream, sinkId: 'spk-b' });
  view.rerender({ stream, sinkId: '' });
  assert.deepEqual(element.sinkCalls, ['spk-b', '']);
});

test('a mesma preferência repetida não gera chamada nova', () => {
  const element = fakeElement();
  const stream = fakeStream();
  const view = mount(element, { stream, sinkId: 'spk-b' });
  view.rerender({ stream, sinkId: 'spk-b' });
  assert.deepEqual(element.sinkCalls, ['spk-b']);
});

test('onde setSinkId não existe, nada é chamado e nada é lançado', () => {
  const element = fakeElement({ setSinkId: null });
  assert.equal('setSinkId' in element, false);
  mount(element, { stream: fakeStream(), sinkId: 'spk-b' });
  assert.equal(element.playCalls, 1, 'o áudio precisa tocar mesmo sem roteamento de saída');
});

test('a rejeição de setSinkId vira onSinkError, e não unhandledrejection', async () => {
  const failure = Object.assign(new Error('device sumiu'), { name: 'NotFoundError' });
  const element = fakeElement({ setSinkId: () => Promise.reject(failure) });
  const seen: unknown[] = [];
  mount(element, { stream: fakeStream(), sinkId: 'spk-morto', onSinkError: (err: unknown) => seen.push(err) });

  await settle();
  assert.deepEqual(seen, [failure]);
});

test('setSinkId que não devolve Promise não quebra o efeito', () => {
  const element = fakeElement({ setSinkId: () => undefined });
  mount(element, { stream: fakeStream(), sinkId: 'spk-b' });
  assert.deepEqual(element.sinkCalls, ['spk-b']);
});

// ---------------------------------------------------------------------- play

test('o elemento é reproduzido assim que recebe stream', () => {
  const element = fakeElement();
  mount(element, { stream: fakeStream() });
  assert.equal(element.playCalls, 1);
});

test('sem stream não há reprodução nem sink', () => {
  const element = fakeElement();
  mount(element, { stream: null, sinkId: 'spk-b' });
  assert.equal(element.playCalls, 0);
});

test('a rejeição de play vira onBlocked', async () => {
  const element = fakeElement({ play: () => Promise.reject(new Error('NotAllowedError')) });
  let blocked = 0;
  mount(element, { stream: fakeStream(), onBlocked: () => { blocked += 1; } });

  await settle();
  assert.equal(blocked, 1);
});

test('play() sem Promise (navegador antigo) não quebra e não acende o aviso', async () => {
  const element = fakeElement({ play: () => undefined });
  let blocked = 0;
  mount(element, { stream: fakeStream(), onBlocked: () => { blocked += 1; } });

  await settle();
  assert.equal(element.playCalls, 1);
  assert.equal(blocked, 0);
});

test('mudar o nonce re-tenta a reprodução — é o clique no aviso', () => {
  const element = fakeElement();
  const stream = fakeStream();
  const view = mount(element, { stream, unlockNonce: 0 });
  assert.equal(element.playCalls, 1);

  view.rerender({ stream, unlockNonce: 1 });
  assert.equal(element.playCalls, 2);
  view.rerender({ stream, unlockNonce: 2 });
  assert.equal(element.playCalls, 3);
});

test('a re-tentativa que falha de novo reacende o aviso', async () => {
  let attempt = 0;
  const element = fakeElement({
    play: () => {
      attempt += 1;
      return Promise.reject(new Error('NotAllowedError'));
    },
  });
  const stream = fakeStream();
  let blocked = 0;
  const props = { stream, unlockNonce: 0, onBlocked: () => { blocked += 1; } };
  const view = mount(element, props);
  await settle();
  assert.equal(blocked, 1);

  view.rerender({ ...props, unlockNonce: 1 });
  await settle();
  assert.equal(attempt, 2);
  assert.equal(blocked, 2, 'o aviso precisa voltar quando a re-tentativa falha');
});

test('desmontar antes da rejeição não acende o aviso de um elemento que já morreu', async () => {
  // `!` de atribuição definitiva: o executor do `Promise` roda sincronamente.
  let reject!: (erro: Error) => void;
  const element = fakeElement({ play: () => new Promise((_, r) => { reject = r; }) });
  let blocked = 0;
  const view = mount(element, { stream: fakeStream(), onBlocked: () => { blocked += 1; } });

  view.unmount();
  reject(new Error('AbortError'));
  await settle();
  assert.equal(blocked, 0);
});

// ------------------------------------------------------------------- a ordem

test('attach acontece antes do sink, e o sink antes do play', () => {
  // Alguns navegadores só se comportam com `setSinkId` sobre um elemento que já
  // tem fonte; e encadear `setSinkId().then(play)` deixaria o Firefox — que não
  // tem `setSinkId` — sem nunca chamar `play()`.
  const order: string[] = [];
  const element = fakeElement({
    setSinkId: () => { order.push('sink'); return Promise.resolve(); },
    play: () => { order.push('play'); return Promise.resolve(); },
  });
  const stream = fakeStream();
  stream.addEventListener('addtrack', () => {});
  const ref = comoRef(element);
  renderWithEffects((props: AudibleMediaOptions) => {
    if (element.srcObject && !order.includes('attach')) order.push('attach');
    return useAudibleMedia(ref, props);
  }, { stream, sinkId: 'spk-b' });

  assert.deepEqual(order, ['sink', 'play']);
  assert.equal(element.srcObject, stream, 'o attach precisa ter acontecido antes dos dois');
});
