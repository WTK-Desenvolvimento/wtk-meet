/**
 * Motor de reprodução de uma faixa. É a única parte do player que toca em DOM e
 * WebAudio, e as três armadilhas que o arquivo de produção documenta —
 * `createMediaElementSource` desconectando o dono da própria saída, `crossOrigin`
 * definido depois do `src`, e mídia sem CORS virando silêncio digital — têm em
 * comum o fato de **não** lançarem erro nenhum. Nenhuma delas apareceria num
 * teste que só verificasse "tocou". Daí este arquivo verificar a forma do grafo
 * e a ordem das atribuições, e não só o resultado.
 *
 * O navegador é substituído por dublês mínimos (`Audio`, `AudioContext`,
 * `URL.createObjectURL`, `fetch`): o que está sob teste é a decisão do motor,
 * não a implementação de mídia de ninguém.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// --------------------------------------------------------------- dublês do DOM

/** Elementos criados por `new Audio()`, na ordem — o motor não os devolve. */
const created: FakeAudioElement[] = [];

/**
 * Os dublês daqui implementam **o que o motor chama**, e não a interface do
 * navegador inteira. Os `as unknown as` estão na fronteira (`globalThis.Audio`,
 * `fetch` e o contexto de áudio), cada um comentado onde está.
 */
class FakeAudioElement {
  ops: string[];
  listeners: Map<string, Set<(event: { type: string }) => void>>;
  readyState: number;
  currentTime: number;
  duration: number;
  paused: boolean;
  ended: boolean;
  playCalls: number;
  pauseCalls: number;
  loadCalls: number;
  removedAttributes: string[];
  playRejection: Error | null;
  _src: string;
  _crossOrigin: string | null;
  _preload: string;
  _volume: number;

  constructor() {
    this.ops = []; // ordem das atribuições: é o que revela crossOrigin tardio
    this.listeners = new Map();
    this.readyState = 1; // metadados prontos: `load()` resolve na hora
    this.currentTime = 0;
    this.duration = NaN;
    this.paused = true;
    this.ended = false;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
    this.removedAttributes = [];
    this.playRejection = null;
    this._src = '';
    this._crossOrigin = null;
    this._preload = '';
    this._volume = 1;
    created.push(this);
  }

  set src(value: string) {
    this.ops.push('src');
    this._src = value;
  }

  get src() {
    return this._src;
  }

  set crossOrigin(value: string | null) {
    this.ops.push('crossOrigin');
    this._crossOrigin = value;
  }

  get crossOrigin() {
    return this._crossOrigin;
  }

  set preload(value: string) {
    this.ops.push('preload');
    this._preload = value;
  }

  get preload() {
    return this._preload;
  }

  set volume(value: number) {
    this.ops.push('volume');
    this._volume = value;
  }

  get volume() {
    return this._volume;
  }

  addEventListener(type: string, handler: (event: { type: string }) => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(handler);
  }

  removeEventListener(type: string, handler: (event: { type: string }) => void) {
    this.listeners.get(type)?.delete(handler);
  }

  emit(type: string) {
    for (const handler of [...(this.listeners.get(type) || [])]) handler({ type });
  }

  async play() {
    this.playCalls += 1;
    if (this.playRejection) throw this.playRejection;
    this.paused = false;
    return undefined;
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
  }

  load() {
    this.loadCalls += 1;
  }

  removeAttribute(name: string) {
    this.removedAttributes.push(name);
  }
}

class FakeNode {
  label: string;
  connections: unknown[];
  disconnectCalls: number;
  /** Preenchidos só por alguns tipos de nó — o motor lê cada um no seu caminho. */
  stream?: { getAudioTracks: () => { id: string; stopped: boolean; stop(): void }[] };
  gain?: { value: number };
  element?: unknown;

  constructor(label: string) {
    this.label = label;
    this.connections = [];
    this.disconnectCalls = 0;
  }

  connect(target: unknown) {
    this.connections.push(target);
    return target;
  }

  disconnect() {
    this.disconnectCalls += 1;
  }
}

function fakeContext({ state = 'running' } = {}) {
  const ctx: {
    state: string;
    resumeCalls: number;
    destination: FakeNode;
    createdDestinations: number;
    lastSource?: FakeNode;
    resume(): Promise<void>;
    createMediaStreamDestination(): FakeNode;
    createGain(): FakeNode;
    createMediaElementSource(element: unknown): FakeNode;
  } = {
    state,
    resumeCalls: 0,
    destination: new FakeNode('speakers'),
    createdDestinations: 0,
    async resume() {
      ctx!.resumeCalls += 1;
      ctx!.state = 'running';
    },
    createMediaStreamDestination() {
      ctx!.createdDestinations += 1;
      const track = { id: `music-track-${ctx!.createdDestinations}`, stopped: false, stop() { this.stopped = true; } };
      const node = new FakeNode('mesh');
      node.stream = { getAudioTracks: () => [track] };
      return node;
    },
    createGain() {
      const node = new FakeNode('gain');
      node.gain = { value: 1 };
      return node;
    },
    createMediaElementSource(element: unknown) {
      const node = new FakeNode('source');
      node.element = element;
      ctx!.lastSource! = node;
      return node;
    },
  };
  return ctx;
}

const objectUrls: { created: string[]; revoked: string[] } = { created: [], revoked: [] };
let nextObjectUrl = 0;
URL.createObjectURL = () => {
  nextObjectUrl += 1;
  const url = `blob:fake-${nextObjectUrl}`;
  objectUrls.created.push(url);
  return url;
};
URL.revokeObjectURL = (url: string) => objectUrls.revoked.push(url);

// A fronteira: o motor faz `new Audio()` e um `fetch` de sonda, e lê pouca
// coisa dos dois — nenhum dos dois dublês cabe na interface completa.
globalThis.Audio = FakeAudioElement as unknown as typeof Audio;

let fetchCalls: unknown[][] = [];
let fetchImpl: (...args: unknown[]) => Promise<unknown> = async () => ({ ok: true, status: 200 });
globalThis.fetch = ((...args: unknown[]) => {
  fetchCalls.push(args);
  return fetchImpl(...args);
}) as unknown as typeof fetch;

const { MusicEngine } = await import('../src/lib/musicEngine.js');

import type { MusicEngineError } from '../src/lib/musicEngine.js';
import type { QueueEntry } from '../src/lib/musicSession.js';

// ------------------------------------------------------------------ auxiliares

/**
 * Os nós que o motor guarda são os dublês do `fakeContext` — um lugar só para
 * o cast, em vez de um por asserção.
 */
const monitorDe = (engine: InstanceType<typeof MusicEngine>) =>
  engine.monitorGain as unknown as FakeNode & { gain: { value: number } };
const destinoDe = (engine: InstanceType<typeof MusicEngine>) =>
  engine.destination as unknown as FakeNode & {
    stream: { getAudioTracks: () => { id: string; stopped: boolean }[] };
  };

/** Um arquivo local dublê: o motor lê o nome e o entrega ao `createObjectURL`. */
const arquivo = (name: string) => ({ name }) as unknown as File;

function entry(overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: 'e1',
    kind: 'url',
    title: 'Faixa',
    sourceRef: 'https://cdn.example.com/a.mp3',
    durationSec: null,
    addedBy: 'peer-a',
    addedByName: 'Ana',
    lamport: 1,
    ...overrides,
  } as QueueEntry;
}

function makeEngine(overrides: { context?: ReturnType<typeof fakeContext> | null } = {}) {
  const events: {
    ended: string[];
    durations: [string, number][];
    errors: MusicEngineError[];
    blocked: number;
  } = { ended: [], durations: [], errors: [], blocked: 0 };
  const ctx = overrides.context === null ? null : overrides.context || fakeContext();
  const engine = new MusicEngine({
    // O cast do contexto: o dublê tem os quatro métodos que o motor usa.
    getContext: () => ctx as unknown as AudioContext | null,
    onEnded: (id: string) => events.ended.push(id),
    onDurationKnown: (id: string, value: number) => events.durations.push([id, value]),
    // O evento de erro é um objeto: campo nomeado, sem ordem posicional para
    // errar (foi exatamente esse erro de posição que descartava o código do
    // YouTube do outro lado).
    onError: (payload: MusicEngineError) => events.errors.push(payload),
    onBlocked: () => {
      events.blocked += 1;
    },
  });
  return { engine, events, ctx };
}

function reset() {
  created.length = 0;
  objectUrls.created.length = 0;
  objectUrls.revoked.length = 0;
  fetchCalls = [];
  fetchImpl = async () => ({ ok: true, status: 200 });
}

// ----------------------------------------------------------- sonda de entrega

test('sonda de CORS: arquivo local só tem um caminho e não vira requisição', async () => {
  reset();
  const { engine } = makeEngine();
  assert.equal(await engine.probeDelivery(entry({ kind: 'file', sourceRef: '' })), 'stream');
  assert.equal(fetchCalls.length, 0, 'arquivo local não deve gerar tráfego de sonda');
});

test('sonda de CORS: resposta boa libera a captura e baixa um byte só', async () => {
  reset();
  const { engine } = makeEngine();
  assert.equal(await engine.probeDelivery(entry()), 'stream');

  const [url, init] = fetchCalls[0]! as [string, { headers: Record<string, string>; mode: string; cache: string }];
  assert.equal(url, 'https://cdn.example.com/a.mp3');
  assert.equal(init.headers.Range, 'bytes=0-0', 'a sonda não pode baixar a faixa inteira');
  assert.equal(init.mode, 'cors');
  assert.equal(init.cache, 'no-store');
});

test('sonda de CORS: 206 também é sucesso; recusa e falha de rede caem para local', async () => {
  reset();
  const { engine } = makeEngine();

  fetchImpl = async () => ({ ok: false, status: 206 });
  assert.equal(await engine.probeDelivery(entry()), 'stream');

  fetchImpl = async () => ({ ok: false, status: 403 });
  assert.equal(await engine.probeDelivery(entry()), 'local');

  // Erro de CORS chega como exceção: tocar local é melhor que tocar silêncio.
  fetchImpl = async () => {
    throw new TypeError('Failed to fetch');
  };
  assert.equal(await engine.probeDelivery(entry()), 'local');
});

test('sonda de CORS: YouTube nunca é retransmitido, e sem entrada nada quebra', async () => {
  reset();
  const { engine } = makeEngine();
  assert.equal(await engine.probeDelivery(entry({ kind: 'youtube', sourceRef: 'dQw4w9WgXcQ' })), 'local');
  assert.equal(await engine.probeDelivery(null), 'stream');
  assert.equal(fetchCalls.length, 0);
});

// -------------------------------------------------------------- grafo de áudio

test('o dono ouve a própria música: a fonte vai para a rede E para o alto-falante', async () => {
  reset();
  const { engine, ctx } = makeEngine();
  const track = await engine.load(entry({ kind: 'file', sourceRef: '' }), { file: arquivo('a.mp3') });

  const source = ctx!.lastSource!;
  assert.equal(source.connections.length, 2, 'faltando um ramo do grafo');
  assert.ok(source.connections.includes(destinoDe(engine)), 'a rede não recebe o áudio');
  assert.ok(
    source.connections.includes(monitorDe(engine)),
    'sem o ramo de monitoração o dono é o único que não escuta',
  );
  // E o ramo de monitoração termina no alto-falante, não em lugar nenhum.
  assert.ok(monitorDe(engine).connections.includes(ctx!.destination));
  assert.equal(track, destinoDe(engine).stream.getAudioTracks()[0]);
});

test('crossOrigin é definido antes do src — depois não tem efeito e vira silêncio', async () => {
  reset();
  const { engine } = makeEngine();
  await engine.load(entry(), { delivery: 'stream' });

  const element = created[0];
  assert.equal(element.crossOrigin, 'anonymous');
  assert.ok(
    element.ops.indexOf('crossOrigin') < element.ops.indexOf('src'),
    'crossOrigin depois do src não surte efeito e o grafo fica mudo, sem erro',
  );
});

test('arquivo local é same-origin: nada de pedir CORS num blob', async () => {
  reset();
  const { engine } = makeEngine();
  await engine.load(entry({ kind: 'file', sourceRef: '' }), { file: arquivo('a.mp3') });

  const element = created[0];
  assert.equal(element.crossOrigin, null);
  assert.ok(element.src.startsWith('blob:'));
});

test('modo local não passa por WebAudio: é o caminho que o taint de CORS quebraria', async () => {
  reset();
  const { engine, ctx } = makeEngine();
  engine.setMonitorVolume(0.4);
  await engine.load(entry(), { delivery: 'local', asOwner: false });

  assert.equal(ctx!.lastSource!, undefined, 'modo local não pode criar MediaElementSource');
  assert.equal(created[0].crossOrigin, null);
  assert.equal(created[0].volume, 0.4, 'no modo local o volume é do elemento');
});

test('sem contexto de áudio o motor avisa em vez de tocar no vazio', async () => {
  reset();
  const { engine, events } = makeEngine({ context: null });
  const track = await engine.load(entry({ kind: 'file', sourceRef: '' }), { file: arquivo('a.mp3') });

  assert.equal(track, null);
  assert.deepEqual(events.errors, [{ reason: 'no-audio-context', entryId: 'e1' }]);
});

test('origem sem suporte e arquivo ausente viram erro nomeado, não exceção', async () => {
  reset();
  const { engine, events } = makeEngine();

  assert.equal(await engine.load(entry({ kind: 'file', sourceRef: '' }), { file: null }), null);
  assert.equal(await engine.load(entry({ kind: 'youtube', sourceRef: 'dQw4w9WgXcQ' })), null);
  assert.deepEqual(
    events.errors.map((error) => error.reason),
    ['missing-file', 'unsupported-kind'],
  );
  assert.equal(created.length, 0, 'nenhum elemento deve ser criado para origem inválida');
});

test('o track que vai para o mesh é o mesmo entre faixas: trocar não renegocia', async () => {
  reset();
  const { engine, ctx } = makeEngine();
  const first = await engine.load(entry({ kind: 'file', sourceRef: '' }), { file: arquivo('a.mp3') });
  const second = await engine.load(entry({ id: 'e2', kind: 'file', sourceRef: '' }), { file: arquivo('b.mp3') });

  assert.equal(first, second);
  assert.equal(ctx!.createdDestinations, 1, 'o destino de rede nasce uma vez e vive com o motor');
});

test('objectURL é revogado ao trocar de faixa, ao parar e no destroy', async () => {
  reset();
  const { engine } = makeEngine();
  await engine.load(entry({ kind: 'file', sourceRef: '' }), { file: arquivo('a.mp3') });
  assert.deepEqual(objectUrls.revoked, []);

  await engine.load(entry({ id: 'e2', kind: 'file', sourceRef: '' }), { file: arquivo('b.mp3') });
  assert.deepEqual(
    objectUrls.revoked,
    [objectUrls.created[0]],
    'trocar de faixa tem que soltar o blob anterior',
  );

  engine.destroy();
  assert.deepEqual(objectUrls.revoked, objectUrls.created);
});

// ------------------------------------------------------------------- comandos

test('autoplay bloqueado vira aviso clicável, não um player mudo sem explicação', async () => {
  reset();
  const { engine, events } = makeEngine();
  await engine.load(entry());
  created[0].playRejection = Object.assign(new Error('bloqueado'), { name: 'NotAllowedError' });

  assert.equal(await engine.play(), false);
  assert.equal(events.blocked, 1);
});

test('play acorda o contexto suspenso antes de tentar tocar', async () => {
  reset();
  const ctx = fakeContext({ state: 'suspended' });
  const { engine } = makeEngine({ context: ctx });
  await engine.load(entry());

  assert.equal(await engine.play(), true);
  assert.equal(ctx!.resumeCalls, 1);
  assert.equal(created[0].playCalls, 1);
});

test('play sem faixa carregada não lança e não inventa reprodução', async () => {
  reset();
  const { engine, events } = makeEngine();
  assert.equal(await engine.play(), false);
  assert.equal(events.blocked, 0);
});

test('volume do dono é local: clamp, ganho de monitoração e elemento em modo local', async () => {
  reset();
  const { engine } = makeEngine();
  await engine.load(entry({ kind: 'file', sourceRef: '' }), { file: arquivo('a.mp3') });

  engine.setMonitorVolume(2);
  assert.equal(monitorDe(engine).gain.value, 1);
  engine.setMonitorVolume(-1);
  assert.equal(monitorDe(engine).gain.value, 0);
  engine.setMonitorVolume('alto');
  assert.equal(monitorDe(engine).gain.value, 1, 'valor não numérico volta ao padrão');

  // Em `stream` o volume do elemento não é tocado (o ganho é que manda).
  engine.setMonitorVolume(0.5);
  assert.equal(created[0].volume, 1);

  await engine.load(entry({ id: 'e2' }), { delivery: 'local', asOwner: false });
  engine.setMonitorVolume(0.25);
  assert.equal(created[1].volume, 0.25);
});

test('seek ignora valor inválido, nunca vai a negativo e engole erro de mídia crua', async () => {
  reset();
  const { engine } = makeEngine();
  await engine.load(entry());
  const element = created[0];

  engine.seek(12.5);
  assert.equal(element.currentTime, 12.5);
  engine.seek(-3);
  assert.equal(element.currentTime, 0);
  engine.seek(Number.NaN);
  assert.equal(element.currentTime, 0);

  // Alguns navegadores lançam ao ajustar posição antes dos metadados.
  Object.defineProperty(element, 'currentTime', {
    set() {
      throw new Error('InvalidStateError');
    },
    get() {
      return 0;
    },
    configurable: true,
  });
  assert.doesNotThrow(() => engine.seek(5));
});

// -------------------------------------------------------------------- eventos

test('fim e duração são anunciados, e a faixa antiga não fala pela corrente', async () => {
  reset();
  const { engine, events } = makeEngine();
  await engine.load(entry());
  const first = created[0];

  first.duration = 210;
  first.emit('durationchange');
  assert.deepEqual(events.durations, [['e1', 210]]);

  await engine.load(entry({ id: 'e2' }));
  // Um `ended` atrasado do elemento anterior não pode pular a faixa nova.
  first.emit('ended');
  assert.deepEqual(events.ended, []);

  created[1].emit('ended');
  assert.deepEqual(events.ended, ['e2']);
});

test('duração inválida não é anunciada e erro de mídia é nomeado', async () => {
  reset();
  const { engine, events } = makeEngine();
  await engine.load(entry());
  const element = created[0];

  element.duration = Number.POSITIVE_INFINITY; // stream ao vivo
  element.emit('durationchange');
  element.duration = 0;
  element.emit('durationchange');
  assert.deepEqual(events.durations, []);

  element.emit('error');
  assert.deepEqual(events.errors, [{ reason: 'media-error', entryId: 'e1' }]);
});

test('getters de estado refletem o elemento, e sem faixa devolvem o neutro', async () => {
  reset();
  const { engine } = makeEngine();
  assert.equal(engine.positionSec, 0);
  assert.equal(engine.durationSec, null);
  assert.equal(engine.playing, false);
  assert.equal(engine.buffering, false);

  await engine.load(entry());
  const element = created[0];
  element.currentTime = 30;
  element.duration = 180;
  element.paused = false;
  element.readyState = 4;

  assert.equal(engine.positionSec, 30);
  assert.equal(engine.durationSec, 180);
  assert.equal(engine.playing, true);
  assert.equal(engine.buffering, false);

  element.readyState = 2; // engasgou: corrigir posição agora só piora a deriva
  assert.equal(engine.buffering, true);
});

// ------------------------------------------------------------------- teardown

test('parar solta o elemento e o download, mas mantém o track do mesh de pé', async () => {
  reset();
  const { engine, ctx } = makeEngine();
  await engine.load(entry());
  const element = created[0];
  const track = engine.track;

  engine.stop();
  assert.equal(element.pauseCalls > 0, true);
  assert.deepEqual(element.removedAttributes, ['src']);
  assert.equal(element.loadCalls, 1, 'sem load() o download continua em segundo plano');
  assert.equal(ctx!.lastSource!.disconnectCalls, 1);
  assert.equal(engine.track, track, 'o canal de música não pode cair ao trocar de faixa');
});

test('destroy encerra o track e o motor não volta a tocar depois disso', async () => {
  reset();
  const { engine } = makeEngine();
  await engine.load(entry());
  // O cast: a track que o motor publica é a do `createMediaStreamDestination`
  // dublê, e é ela que sabe dizer se foi parada.
  const track = engine.track as unknown as { stopped: boolean };

  engine.destroy();
  assert.equal(track.stopped, true);
  assert.equal(engine.track, null);
  assert.equal(await engine.load(entry({ id: 'e3' })), null);
});
