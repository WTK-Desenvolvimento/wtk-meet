/**
 * Caracterização do `pages/Room.jsx` — redirect, máquina de fases, nascimento
 * de participante e desmontagem.
 *
 * É a peça mais cara da rede de segurança da migração para TypeScript, e a mais
 * necessária: `Room.jsx` tem 1600 linhas, 24 imports e é o único arquivo do
 * produto sem nenhum teste unitário. Tudo que ele faz de errado aparece dez
 * minutos depois, no E2E, como "a sala não abriu" — sem dizer qual das quatro
 * camadas falhou.
 *
 * O que está congelado aqui são as decisões que os comentários do próprio
 * arquivo descrevem como caras de reaprender:
 *
 * - **Redirect sempre `replace`.** Um `push` no path sem `#` deixa no histórico
 *   um endereço sem chave, e o botão Voltar gera uma chave nova a cada volta,
 *   em laço.
 * - **Nada acontece enquanto o redirect está pendente.** Sem o early-return a
 *   câmera acende duas vezes e dois sockets entram na mesma sala.
 * - **Todo participante nasce com a forma de `DEFAULT_PARTICIPANT`.** São três
 *   os pontos que criam registro; um deles esquecer `cameraOff: true` faz um
 *   retângulo preto (ou o vídeo de quem pediu para não aparecer) piscar na
 *   grade de todo mundo.
 * - **A desmontagem apaga o LED da webcam.** É a diferença entre sair da sala e
 *   deixar a câmera ligada até fechar a aba.
 *
 * Como isto roda sem navegador: `Room` é executado como função, com um
 * dispatcher de hooks próprio (o mesmo padrão de `musicRoomPlayerError` e
 * `settingsNoiseToggle`, com `useEffect` de verdade — deps, cleanup e ordem), e
 * com os módulos de efeito colateral substituídos por `mock.module`. O que é
 * real é o `Room`; o que é dublê é tudo que ele chama. Consequência declarada:
 * nada aqui prova que o HTML sai certo — isso continua sendo do E2E.
 */
import assert from 'node:assert/strict';
import { register } from 'node:module';
import test, { mock } from 'node:test';

register('./jsxLoader.mjs', import.meta.url);

// ------------------------------------------------- ambiente mínimo de browser

function makeStorage() {
  const data = new Map();
  return {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
    clear: () => data.clear(),
  };
}

globalThis.sessionStorage = makeStorage();
globalThis.localStorage = makeStorage();

/** Track dublê que sabe dizer se foi parada — é o LED da webcam, em booleano. */
function fakeTrack(kind, id = `${kind}-1`) {
  return {
    kind,
    id,
    enabled: true,
    readyState: 'live',
    stopped: false,
    contentHint: '',
    getSettings: () => ({ deviceId: `${kind}-device` }),
    stop() {
      this.stopped = true;
      this.readyState = 'ended';
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = [...tracks];
  }
  addTrack(t) {
    if (!this.tracks.includes(t)) this.tracks.push(t);
  }
  removeTrack(t) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addEventListener() {}
  removeEventListener() {}
}

globalThis.MediaStream = FakeMediaStream;

/** Quantas vezes a câmera/mic foi aberta, e com quais tracks — o cenário controla. */
const media = {
  chamadas: [],
  concedidas: [],
  proximo: () => new FakeMediaStream([fakeTrack('audio'), fakeTrack('video')]),
};

/**
 * Atribuição direta não serve aqui: o Node moderno define `navigator` como
 * acessor só-getter, e `globalThis.navigator = x` lança. Mesma solução de
 * `micPipeline.test.mjs`.
 */
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        media.chamadas.push(constraints);
        const stream = media.proximo();
        media.concedidas.push(stream);
        return stream;
      },
      enumerateDevices: async () => [],
      addEventListener() {},
      removeEventListener() {},
    },
  },
});

globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  location: { origin: 'http://localhost:5173', protocol: 'http:' },
  isSecureContext: true,
};
globalThis.document = {
  head: { appendChild: () => {} },
  createElement: () => ({ appendChild: () => {}, removeChild: () => {} }),
  querySelector: () => null,
  addEventListener() {},
  removeEventListener() {},
};

// ------------------------------------------------------------------- dublês

/** O que o cenário corrente vê e controla. Zerado a cada `montarSala`. */
let cena;

function novaCena() {
  cena = {
    navegacoes: [],
    location: { pathname: '/daily', hash: '#chave-de-teste', search: '' },
    signaling: null,
    mesh: null,
    /** Argumentos com que `useMusicRoom` foi chamado — é daqui que sai o mapa
     *  de participantes, sem precisar inspecionar o HTML. */
    musicProps: [],
    iceServers: [{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' }],
    monitorFechado: 0,
    contextoFechado: 0,
    pipelineParado: 0,
  };
  return cena;
}

novaCena();

/**
 * Socket dublê, com o mesmo `on`/`emit` que o `Room` usa.
 *
 * `emitirDoServidor` é o que um teste chama para simular o servidor: é a única
 * porta de entrada de evento neste arquivo.
 */
class FakeSignaling {
  constructor() {
    this.handlers = new Map();
    this.conectado = false;
    this.pedidos = [];
    this.saiuDaSala = 0;
    this.desconectou = 0;
    this.enviados = [];
    this.socket = {
      id: null,
      on: (evento, handler) => {
        if (!this.handlers.has(evento)) this.handlers.set(evento, []);
        this.handlers.get(evento).push(handler);
      },
      off: () => {},
      emit: (evento, payload) => this.enviados.push([evento, payload]),
    };
  }
  connect() {
    this.conectado = true;
  }
  requestJoin(roomId, displayName) {
    this.pedidos.push([roomId, displayName]);
  }
  leaveRoom() {
    this.saiuDaSala += 1;
  }
  disconnect() {
    this.desconectou += 1;
  }
  sendSignal() {}
  /** O servidor falando. Sem isto, a sala fica em `connecting` para sempre. */
  emitirDoServidor(evento, payload) {
    for (const handler of this.handlers.get(evento) || []) handler(payload);
  }
}

class FakeMesh {
  constructor(options) {
    this.options = options;
    this.pares = [];
    this.removidos = [];
    this.fechado = 0;
    this.localState = {};
    cena.mesh = this;
  }
  addPeer(peerId) {
    this.pares.push(peerId);
  }
  removePeer(peerId) {
    this.removidos.push(peerId);
  }
  handleSignal() {}
  setLocalState(patch) {
    this.localState = { ...this.localState, ...patch };
  }
  broadcast() {}
  closeAll() {
    this.fechado += 1;
  }
  replaceCameraTrack() {}
  replaceAudioTrack() {}
  setScreenTrack() {}
  setMusicTrack() {}
}

/**
 * Os módulos reais são carregados **antes** dos dublês porque `mock.module`
 * troca o namespace inteiro: um export esquecido aqui vira
 * `SyntaxError: does not provide an export named ...` num arquivo que não tem
 * nada a ver com o que se testa (foi o `createLevelMeter` do `SettingsModal`).
 * Espalhar o real e sobrescrever só o que interessa elimina a classe.
 *
 * Duas exceções, e pelo mesmo motivo: `config.js` lê `import.meta.env`, que não
 * existe fora do Vite, e `signaling.js` importa `config.js`. Os dois são
 * dublados por inteiro — cada um exporta pouca coisa, e nada dela é usada aqui.
 * `micPipeline.js` é a terceira: ele importa o worklet com o sufixo `?url` do
 * Vite, que só o `viteUrlLoader` sabe resolver, e os dois exports dele estão
 * cobertos pelo dublê.
 */
const realMesh = await import('../src/lib/webrtcMesh.js');
const realAudioLevels = await import('../src/lib/audioLevels.js');
const realAudioContext = await import('../src/lib/audioContext.js');
const realMusicRoom = await import('../src/lib/useMusicRoom.js');

mock.module('react-router-dom', {
  exports: {
    useLocation: () => cena.location,
    useNavigate: () => (to, options) => cena.navegacoes.push([to, options]),
  },
});

mock.module('../src/lib/signaling.js', {
  exports: {
    createSignalingClient: () => {
      cena.signaling = new FakeSignaling();
      return cena.signaling;
    },
  },
});

mock.module('../src/lib/webrtcMesh.js', { exports: { ...realMesh, WebRTCMesh: FakeMesh } });

mock.module('../src/lib/audioLevels.js', {
  exports: {
    ...realAudioLevels,
    /** Superfície completa do monitor real; nenhum método faz nada. */
    AudioLevelMonitor: class {
      constructor(options) {
        this.options = options;
        this.anexados = new Map();
      }
      ensureContext() {
        return { state: 'running', sampleRate: 48000, close: async () => {} };
      }
      resumeOnGesture() {
        return () => {};
      }
      attach(id, stream) {
        this.anexados.set(id, stream);
      }
      detach(id) {
        this.anexados.delete(id);
      }
      retainOnly(validIds) {
        // O `Room` passa um Set; aceitar array também deixa o dublê imune à
        // forma exata do argumento, que não é o que está sob teste aqui.
        const vivos = new Set(validIds);
        for (const id of [...this.anexados.keys()]) {
          if (!vivos.has(id)) this.anexados.delete(id);
        }
      }
      playBeep() {}
      close() {
        cena.monitorFechado += 1;
      }
    },
  },
});

mock.module('../src/lib/audioContext.js', {
  exports: {
    ...realAudioContext,
    getAudioContext: () => ({ state: 'running', sampleRate: 48000 }),
    closeAudioContext: () => {
      cena.contextoFechado += 1;
    },
    resumeAudioContextOnGesture: () => () => {},
  },
});

mock.module('../src/lib/micPipeline.js', {
  exports: {
    createMicPipeline: async ({ rawTrack }) => ({
      track: rawTrack,
      mode: 'passthrough',
      setEnabled() {},
      stop() {
        cena.pipelineParado += 1;
      },
    }),
    detectNoiseMode: async () => 'worklet',
  },
});

mock.module('../src/config.js', {
  exports: {
    fetchIceServers: async () => cena.iceServers,
    MAX_PARTICIPANTS: 6,
    SIGNALING_URL: 'http://localhost:4000',
    YOUTUBE_ENABLED: false,
  },
});

/**
 * `useMusicRoom` dublê. Devolve uma superfície inerte, mas **completa**: o
 * `Room` lê ~20 campos dela durante o render, e um `undefined` no meio derruba
 * a árvore inteira por um motivo que não tem nada a ver com o que se testa.
 */
mock.module('../src/lib/useMusicRoom.js', {
  exports: {
    ...realMusicRoom,
    useMusicRoom: (props) => {
      cena.musicProps.push(props);
      return {
        enabled: false,
        youtubeEnabled: false,
        queue: [],
        currentEntry: null,
        playback: { playing: false, positionSec: 0 },
        position: 0,
        isOwner: false,
        myVote: null,
        volume: 1,
        notice: null,
        audioBlocked: false,
        musicStreams: new Map(),
        youtubeHostRef: { current: null },
        meshCallbacks: {},
        actions: {
          add: () => {},
          remove: () => {},
          play: () => {},
          pause: () => {},
          skip: () => {},
          seek: () => {},
        },
        vote: () => {},
        setVolume: () => {},
        dismissNotice: () => {},
        reportBlocked: () => {},
        unlockAudio: () => {},
      };
    },
  },
});

const React = await import('react');
const internals = React.default.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
const { default: Room } = await import('../src/pages/Room.jsx');

// ------------------------------------------------------------ render de hook

const sameDeps = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

/**
 * Roda um componente como função, fora do React: dispatcher próprio, render
 * síncrono a cada `setState`, efeitos na ordem com deps e cleanup.
 *
 * O laço tem trava: um efeito que muda estado a cada execução é bug de verdade,
 * e aqui ele falha alto em vez de travar a suíte inteira.
 */
function renderComponent(Component) {
  const slots = [];
  let cursor = 0;
  let result = null;
  let pending = [];
  let dirty = false;
  let busy = false;

  const dispatcher = {
    useState(initial) {
      const slot = cursor++;
      if (!slots[slot]) slots[slot] = { value: typeof initial === 'function' ? initial() : initial };
      const cell = slots[slot];
      return [
        cell.value,
        (value) => {
          const next = typeof value === 'function' ? value(cell.value) : value;
          if (Object.is(next, cell.value)) return;
          cell.value = next;
          schedule();
        },
      ];
    },
    useRef(initial) {
      const slot = cursor++;
      if (!slots[slot]) slots[slot] = { current: initial };
      return slots[slot];
    },
    useMemo(factory, deps) {
      const slot = cursor++;
      if (!slots[slot] || !sameDeps(slots[slot].deps, deps)) slots[slot] = { deps, value: factory() };
      return slots[slot].value;
    },
    useCallback(fn, deps) {
      const slot = cursor++;
      if (!slots[slot] || !sameDeps(slots[slot].deps, deps)) slots[slot] = { deps, value: fn };
      return slots[slot].value;
    },
    useEffect(create, deps) {
      const slot = cursor++;
      if (!slots[slot]) slots[slot] = { deps: null, cleanup: null, first: true };
      const cell = slots[slot];
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
  dispatcher.useLayoutEffect = dispatcher.useEffect;

  function renderOnce() {
    cursor = 0;
    const previous = internals.ReactCurrentDispatcher.current;
    internals.ReactCurrentDispatcher.current = dispatcher;
    try {
      result = Component();
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
          cell.cleanup = typeof cleanup === 'function' ? cleanup : null;
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
    rerender: schedule,
    unmount() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}

/** Deixa correr o que estiver pendente — `setup()` tem awaits no meio. */
async function settle(turns = 8) {
  for (let i = 0; i < turns; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Monta a sala num cenário limpo.
 *
 * `displayName` na `sessionStorage` é o que destrava o efeito de setup: sem
 * nome, o `Room` fica no lobby (`PreJoin`) e nada de rede acontece — que é
 * exatamente o caso do teste do lobby, e por isso é parametrizável.
 */
async function montarSala({ pathname = '/daily', hash = '#chave-de-teste', displayName = 'Alice' } = {}) {
  novaCena();
  cena.location = { pathname, hash, search: '' };
  media.chamadas = [];
  media.concedidas = [];
  sessionStorage.clear();
  localStorage.clear();
  if (displayName) sessionStorage.setItem('displayName', displayName);

  const view = renderComponent(Room);
  await settle();
  return view;
}

/** O último mapa de participantes que o `Room` entregou ao hook de música. */
function participantesAtuais() {
  return cena.musicProps.at(-1).participants;
}

/**
 * Caminha a árvore de elementos que o render devolveu.
 *
 * Ler o resultado por `JSON.stringify` não serve: o `type` de um componente é
 * uma função, e função não sobrevive à serialização — `PreJoin` e `VideoGrid`
 * sumiriam do texto. Percorrer os elementos custa vinte linhas e responde
 * exatamente o que se quer perguntar.
 */
function percorrer(node, visitar) {
  if (node == null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const filho of node) percorrer(filho, visitar);
    return;
  }
  if (!('type' in node)) return;
  visitar(node);
  percorrer(node.props?.children, visitar);
}

function elementos(view) {
  const encontrados = [];
  percorrer(view.result, (node) => encontrados.push(node));
  return encontrados;
}

const nomeDe = (node) => (typeof node.type === 'string' ? node.type : node.type?.name || '');

/** O primeiro elemento daquele componente, ou null. */
function acharComponente(view, nome) {
  return elementos(view).find((node) => nomeDe(node) === nome) || null;
}

/** Todo o texto renderizado, concatenado — para afirmar mensagens de tela. */
function textoDe(view) {
  let texto = '';
  percorrer(view.result, (node) => {
    const filhos = node.props?.children;
    const juntar = (filho) => {
      if (typeof filho === 'string' || typeof filho === 'number') texto += `${filho} `;
    };
    if (Array.isArray(filhos)) filhos.forEach(juntar);
    else juntar(filhos);
  });
  return texto;
}

/** Os pedidos de entrada que o modal está exibindo agora. */
function pedidosNaTela(view) {
  return acharComponente(view, 'JoinRequestModal')?.props?.requests || [];
}

/** A fase corrente, lida pela classe do <main> — é o que o E2E também observa. */
function faseAtual(view) {
  if (acharComponente(view, 'PreJoin')) return 'lobby';
  const main = elementos(view).find((node) => node.type === 'main');
  const classe = main?.props?.className || '';
  if (classe.includes('denied')) return 'denied';
  if (classe.includes('waiting')) return 'waiting';
  if (classe.includes('in-call')) return 'in-call';
  return `desconhecida (<main class="${classe}">)`;
}

// ------------------------------------------------------------ 1. redirect

test('path que não é sala volta para a Home, sempre com replace', async () => {
  for (const pathname of ['/a/b', '/!!!', '/']) {
    const view = await montarSala({ pathname, hash: '#x' });
    assert.deepEqual(
      cena.navegacoes,
      [['/', { replace: true }]],
      `"${pathname}" devia voltar para a Home`,
    );
    view.unmount();
  }
});

test('path não canônico é redirecionado para o slug, preservando o hash', async () => {
  // Entrar por `/Daily` e por `/daily` seriam duas salas diferentes, cada uma
  // parecendo vazia, e sem nenhum erro na tela.
  const view = await montarSala({ pathname: '/Daily', hash: '#minha-chave' });
  assert.deepEqual(cena.navegacoes, [['/daily#minha-chave', { replace: true }]]);
  view.unmount();
});

test('path sem hash ganha uma passphrase gerada, e o redirect é replace', async () => {
  // `replace` e não `push`: um `push` deixaria no histórico um path sem chave, e
  // o botão Voltar geraria outra chave a cada volta, em laço.
  const view = await montarSala({ pathname: '/daily', hash: '' });

  assert.equal(cena.navegacoes.length, 1);
  const [destino, options] = cena.navegacoes[0];
  assert.deepEqual(options, { replace: true });
  assert.match(destino, /^\/daily#.+/, 'a chave vai para o fragmento, não para a query');
  assert.ok(destino.split('#')[1].length >= 8, 'a passphrase não é vazia nem simbólica');
  view.unmount();
});

test('duas montagens do mesmo path sem hash geram chaves diferentes', async () => {
  // Consequência conhecida e documentada no README: quem abre `/daily` sem `#`
  // cria uma sala nova. Está aqui para que a mudança seja deliberada se algum
  // dia alguém quiser torná-la determinística.
  const a = await montarSala({ pathname: '/daily', hash: '' });
  const primeira = cena.navegacoes[0][0];
  a.unmount();

  const b = await montarSala({ pathname: '/daily', hash: '' });
  const segunda = cena.navegacoes[0][0];
  b.unmount();

  assert.notEqual(primeira, segunda);
});

test('path canônico com hash não redireciona nada', async () => {
  const view = await montarSala({ pathname: '/daily', hash: '#chave-de-teste' });
  assert.deepEqual(cena.navegacoes, []);
  view.unmount();
});

test('enquanto o redirect está pendente não há getUserMedia nem socket', async () => {
  // Sem o early-return do efeito de setup, a câmera acende duas vezes e dois
  // sockets entram na mesma sala com o mesmo nome — um deles com o path errado.
  for (const cenario of [
    { pathname: '/Daily', hash: '#chave' },
    { pathname: '/daily', hash: '' },
    { pathname: '/a/b', hash: '#chave' },
  ]) {
    const view = await montarSala(cenario);
    assert.deepEqual(media.chamadas, [], `${cenario.pathname}: pediu mídia antes da hora`);
    assert.equal(cena.signaling, null, `${cenario.pathname}: abriu socket antes da hora`);
    assert.equal(cena.mesh, null, `${cenario.pathname}: criou mesh antes da hora`);
    view.unmount();
  }
});

test('sem nome escolhido a sala fica no lobby, sem rede nenhuma', async () => {
  // O lobby (`PreJoin`) é onde a pessoa escolhe nome e estado da câmera. Nada
  // de sala acontece antes disso.
  const view = await montarSala({ displayName: '' });

  assert.equal(faseAtual(view), 'lobby');
  assert.deepEqual(media.chamadas, []);
  assert.equal(cena.signaling, null);
  view.unmount();
});

// ------------------------------------------------------- 2. máquina de fases

test('a sala nasce conectando e vira waiting-approval quando o socket conecta', async () => {
  const view = await montarSala();

  assert.equal(faseAtual(view), 'waiting', 'connecting e waiting-approval usam o mesmo <main>');
  assert.ok(cena.signaling, 'o socket foi criado');
  assert.equal(cena.signaling.conectado, true);

  cena.signaling.emitirDoServidor('connect');
  await settle();

  assert.deepEqual(cena.signaling.pedidos, [['daily', 'Alice']], 'o pedido leva sala e nome');
  view.unmount();
});

test('join-approved leva a sala para in-call e registra quem já estava', async () => {
  const view = await montarSala();
  cena.signaling.emitirDoServidor('connect');
  await settle();

  cena.signaling.emitirDoServidor('join-approved', {
    selfId: 'eu',
    members: [{ id: 'bob', displayName: 'Bob' }],
  });
  await settle();

  assert.equal(faseAtual(view), 'in-call');
  assert.deepEqual(cena.mesh.pares, ['bob'], 'o mesh abre conexão com quem já estava');
  view.unmount();
});

test('join-denied leva a denied e propaga o motivo', async () => {
  for (const reason of ['room-full', 'denied', 'invalid-room']) {
    const view = await montarSala();
    cena.signaling.emitirDoServidor('connect');
    await settle();

    cena.signaling.emitirDoServidor('join-denied', { reason });
    await settle();

    assert.equal(faseAtual(view), 'denied', `reason=${reason}`);
    const esperado = {
      'room-full': 'A sala já está com 6 participantes.',
      denied: 'Seu pedido de entrada foi negado.',
      'invalid-room': 'Esse endereço de sala não é válido',
    }[reason];
    assert.ok(textoDe(view).includes(esperado), `a tela de ${reason} explica o motivo`);
    view.unmount();
  }
});

test('uma vez em in-call, um join-denied atrasado ainda derruba a sala', async () => {
  // Caracterização, não aprovação: hoje não há guarda de fase no handler. Se
  // algum dia isso virar um problema, esta linha é o registro de que era assim.
  const view = await montarSala();
  cena.signaling.emitirDoServidor('connect');
  cena.signaling.emitirDoServidor('join-approved', { selfId: 'eu', members: [] });
  await settle();
  assert.equal(faseAtual(view), 'in-call');

  cena.signaling.emitirDoServidor('join-denied', { reason: 'denied' });
  await settle();
  assert.equal(faseAtual(view), 'denied');
  view.unmount();
});

// --------------------------------------- 3. a forma de todo participante novo

const FORMA_PADRAO = {
  displayName: '',
  stream: null,
  screenStream: null,
  cameraOff: true,
  micOff: false,
};

test('participante vindo da lista de members nasce com a forma padrão', async () => {
  const view = await montarSala();
  cena.signaling.emitirDoServidor('connect');
  cena.signaling.emitirDoServidor('join-approved', {
    selfId: 'eu',
    members: [{ id: 'bob', displayName: 'Bob' }],
  });
  await settle();

  assert.deepEqual(participantesAtuais().get('bob'), { ...FORMA_PADRAO, displayName: 'Bob' });
  view.unmount();
});

test('participante vindo de peer-joined nasce com a forma padrão', async () => {
  const view = await montarSala();
  cena.signaling.emitirDoServidor('connect');
  cena.signaling.emitirDoServidor('join-approved', { selfId: 'eu', members: [] });
  await settle();

  cena.signaling.emitirDoServidor('peer-joined', { peerId: 'carol', displayName: 'Carol' });
  await settle();

  assert.deepEqual(participantesAtuais().get('carol'), { ...FORMA_PADRAO, displayName: 'Carol' });
  assert.deepEqual(cena.mesh.pares, ['carol']);
  view.unmount();
});

test('participante criado por um stream de peer desconhecido nasce com a forma padrão', async () => {
  // É o terceiro ponto que cria registro, e o mais fácil de esquecer: o
  // `ontrack` pode chegar antes do `peer-joined`. `cameraOff: true` aqui é o
  // que impede um frame de alguém que pediu para não aparecer.
  const view = await montarSala();
  cena.signaling.emitirDoServidor('connect');
  cena.signaling.emitirDoServidor('join-approved', { selfId: 'eu', members: [] });
  await settle();

  const stream = new FakeMediaStream([fakeTrack('audio', 'remoto')]);
  cena.mesh.options.onRemoteStream('dave', stream);
  await settle();

  assert.deepEqual(participantesAtuais().get('dave'), { ...FORMA_PADRAO, stream });
  view.unmount();
});

test('um registro que já existe não é reiniciado por um evento posterior', async () => {
  // `{ ...DEFAULT_PARTICIPANT, ...(anterior) }`: a ordem do espalhamento é o que
  // preserva o stream já recebido quando o `peer-joined` chega depois.
  const view = await montarSala();
  cena.signaling.emitirDoServidor('connect');
  cena.signaling.emitirDoServidor('join-approved', { selfId: 'eu', members: [] });
  await settle();

  const stream = new FakeMediaStream([fakeTrack('audio', 'remoto')]);
  cena.mesh.options.onRemoteStream('dave', stream);
  cena.signaling.emitirDoServidor('peer-joined', { peerId: 'dave', displayName: 'Dave' });
  await settle();

  assert.deepEqual(participantesAtuais().get('dave'), {
    ...FORMA_PADRAO,
    displayName: 'Dave',
    stream,
  });
  view.unmount();
});

test('peer-left tira o participante do mapa e fecha a conexão dele', async () => {
  const view = await montarSala();
  cena.signaling.emitirDoServidor('connect');
  cena.signaling.emitirDoServidor('join-approved', {
    selfId: 'eu',
    members: [{ id: 'bob', displayName: 'Bob' }],
  });
  await settle();

  cena.signaling.emitirDoServidor('peer-left', { peerId: 'bob' });
  await settle();

  assert.equal(participantesAtuais().has('bob'), false);
  assert.deepEqual(cena.mesh.removidos, ['bob']);
  view.unmount();
});

// --------------------------------------------------- 4. fila de aprovação

test('o mesmo pedido reenviado não vira duas linhas no modal', async () => {
  // Aprovar resolve o id: uma segunda linha ficaria pendente para sempre, atrás
  // de um backdrop que não fecha por Esc nem por clique.
  const view = await montarSala();
  cena.signaling.emitirDoServidor('connect');
  cena.signaling.emitirDoServidor('join-approved', { selfId: 'eu', members: [] });
  await settle();

  cena.signaling.emitirDoServidor('join-request', { requesterId: 'carol', displayName: 'Carol' });
  cena.signaling.emitirDoServidor('join-request', { requesterId: 'carol', displayName: 'Carol' });
  await settle();

  assert.deepEqual(pedidosNaTela(view), [{ requesterId: 'carol', displayName: 'Carol' }]);
  view.unmount();
});

test('o pedido some quando o servidor o cancela, e quando o peer entra por outro caminho', async () => {
  const view = await montarSala();
  cena.signaling.emitirDoServidor('connect');
  cena.signaling.emitirDoServidor('join-approved', { selfId: 'eu', members: [] });
  await settle();

  cena.signaling.emitirDoServidor('join-request', { requesterId: 'carol', displayName: 'Carol' });
  await settle();
  assert.deepEqual(pedidosNaTela(view).map((r) => r.requesterId), ['carol']);

  cena.signaling.emitirDoServidor('join-request-cancelled', { requesterId: 'carol' });
  await settle();
  assert.deepEqual(pedidosNaTela(view), [], 'o servidor retirou o pedido');

  // E o outro caminho: outro participante aprovou primeiro, e o peer chegou.
  cena.signaling.emitirDoServidor('join-request', { requesterId: 'dave', displayName: 'Dave' });
  await settle();
  cena.signaling.emitirDoServidor('peer-joined', { peerId: 'dave', displayName: 'Dave' });
  await settle();
  assert.deepEqual(pedidosNaTela(view), [], 'outro participante já tinha aprovado');
  view.unmount();
});

// ------------------------------------------------------------ 5. desmontagem

test('sair da sala para as tracks locais — é o LED da webcam apagando', async () => {
  const view = await montarSala();
  cena.signaling.emitirDoServidor('connect');
  cena.signaling.emitirDoServidor('join-approved', { selfId: 'eu', members: [] });
  await settle();

  const concedido = media.concedidas.at(-1);
  assert.ok(concedido, 'a sala pediu mídia');
  assert.equal(concedido.getTracks().every((t) => !t.stopped), true, 'ainda vivas dentro da sala');

  view.unmount();

  assert.equal(concedido.getTracks().every((t) => t.stopped), true, 'nenhuma track sobrevive à saída');
});

test('sair da sala fecha o mesh, o socket, o monitor, o pipeline e o contexto', async () => {
  const view = await montarSala();
  cena.signaling.emitirDoServidor('connect');
  cena.signaling.emitirDoServidor('join-approved', { selfId: 'eu', members: [] });
  await settle();

  const { signaling, mesh } = cena;
  view.unmount();

  assert.equal(mesh.fechado, 1, 'closeAll uma vez');
  assert.equal(signaling.saiuDaSala, 1, 'leave-room antes de desconectar');
  assert.equal(signaling.desconectou, 1);
  assert.equal(cena.monitorFechado, 1);
  assert.equal(cena.pipelineParado, 1, 'sem isto o getUserMedia cru fica vivo por trás do worklet');
  assert.equal(cena.contextoFechado, 1);
});

test('sair da sala cancela os timers de aviso pendentes', async () => {
  // Um timer sobrevivente dispara `setState` num componente desmontado — no
  // React real, aviso no console; aqui, estado mudando depois do fim.
  const cancelados = [];
  const clearOriginal = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => {
    cancelados.push(id);
    return clearOriginal(id);
  };
  try {
    const view = await montarSala();
    cena.signaling.emitirDoServidor('connect');
    cena.signaling.emitirDoServidor('join-approved', { selfId: 'eu', members: [] });
    await settle();

    // Cada entrada/saída empurra um aviso, e cada aviso agenda o próprio timer.
    cena.signaling.emitirDoServidor('peer-joined', { peerId: 'carol', displayName: 'Carol' });
    cena.signaling.emitirDoServidor('peer-joined', { peerId: 'dave', displayName: 'Dave' });
    await settle();

    const antes = cancelados.length;
    view.unmount();
    assert.ok(
      cancelados.length >= antes + 2,
      `os dois timers de aviso deviam ser cancelados na saída (cancelados: ${cancelados.length - antes})`,
    );
  } finally {
    globalThis.clearTimeout = clearOriginal;
  }
});

test('desmontar antes de a mídia voltar não deixa track viva', async () => {
  // A janela existe: `setup()` espera `getUserMedia` e `fetchIceServers`, e quem
  // fecha a aba nesse meio tempo cai no caminho do `cancelled`.
  novaCena();
  media.chamadas = [];
  media.concedidas = [];
  sessionStorage.clear();
  localStorage.clear();
  sessionStorage.setItem('displayName', 'Alice');

  let liberar;
  const espera = new Promise((resolve) => {
    liberar = resolve;
  });
  const original = media.proximo;
  media.proximo = () => new FakeMediaStream([fakeTrack('audio'), fakeTrack('video')]);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    media.chamadas.push(constraints);
    await espera;
    const stream = media.proximo();
    media.concedidas.push(stream);
    return stream;
  };

  try {
    const view = renderComponent(Room);
    await settle(2);
    view.unmount();
    liberar();
    await settle();

    const concedido = media.concedidas.at(-1);
    if (concedido) {
      assert.equal(
        concedido.getTracks().every((t) => t.stopped),
        true,
        'o stream que chegou depois da saída é parado na hora',
      );
    }
    assert.equal(cena.signaling, null, 'nenhum socket abre depois da desmontagem');
  } finally {
    media.proximo = original;
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      media.chamadas.push(constraints);
      const stream = media.proximo();
      media.concedidas.push(stream);
      return stream;
    };
  }
});
