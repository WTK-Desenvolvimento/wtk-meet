/**
 * Recuperação de conexão, verificação da segunda rodada e reafirmação de estado.
 *
 * Três comportamentos que só existem quando algo dá errado — e é por isso que
 * eles precisam de teste unitário: no caminho feliz, nenhum deles roda, e um
 * defeito aqui só aparece no relato de um usuário, semanas depois, como
 * "às vezes ele não escuta a gente".
 *
 * O que estes testes protegem, em uma frase cada:
 *
 * - **A ordem da recuperação.** `restartIce()` reusa a configuração congelada no
 *   construtor da `RTCPeerConnection`. Contra credencial de TURN vencida — o
 *   modo de falha mais provável deste produto, que roda `relay`-only — ele
 *   regenera candidatos com a mesma credencial morta e falha idêntico. Se algum
 *   refactor futuro trocar a ordem `renovar → setConfiguration → restartIce`, ou
 *   remover o passo do meio, **o fix inteiro vira decoração** e nada aqui fora
 *   quebra. Daí o teste ser sobre a sequência, não sobre o resultado.
 * - **Uma offer por vez.** Recuperação e verificação disparam no mesmo instante,
 *   por construção: uma conexão que recuperou volta a `stable` com transceivers
 *   possivelmente não associados. Duas offers concorrentes viram glare
 *   artificial e, no pior caso, um laço.
 * - **Timer que não sobrevive ao dono.** O backoff vive até 30s — tempo de sobra
 *   para alguém sair da sala e ser ressuscitado por um `setTimeout`.
 *
 * `RTCPeerConnection` e os timers são dublês. O que está sob teste é a política
 * do mesh, não a pilha WebRTC do navegador nem a precisão do relógio.
 */
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';

import { WebRTCMesh } from '../src/lib/webrtcMesh.js';

const TURN = [{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' }];
const SO_STUN = [{ urls: ['stun:stun.cloudflare.com:3478'] }];

// ------------------------------------------------------------ dublês de WebRTC

function fakeTrack(kind, id = `${kind}-track`) {
  return {
    kind,
    id,
    contentHint: '',
    stop() {},
    addEventListener() {},
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
}

class FakeDataChannel {
  constructor() {
    this.readyState = 'open';
    this.sent = [];
  }
  send(raw) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = 'closed';
  }
  types() {
    return this.sent.map((p) => p.type);
  }
}

/**
 * `RTCPeerConnection` dublê.
 *
 * `trace` é compartilhado entre todas as instâncias de um teste: é nele que a
 * **ordem** entre `setConfiguration` e `restartIce` fica registrada, que é o que
 * mais importa aqui.
 */
class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.signalingState = 'stable';
    this.localDescription = { type: 'offer', sdp: 'v=0' };
    this.transceivers = [];
    this.closed = false;
    this.trace = FakePeerConnection.trace;
    FakePeerConnection.instances.push(this);
    this.trace.push(['construct', config?.iceServers, config?.iceTransportPolicy]);
  }

  static reset() {
    FakePeerConnection.instances = [];
    FakePeerConnection.trace = [];
  }

  addTransceiver(kind, { direction } = {}) {
    // `mid` nasce nulo, como no navegador: só a negociação associa a m-line.
    const t = { mid: null, direction, kind, sender: { replaceTrack: async () => {}, getParameters: null } };
    this.transceivers.push(t);
    return t;
  }

  getTransceivers() {
    return [...this.transceivers];
  }

  createDataChannel() {
    this.channel = new FakeDataChannel();
    return this.channel;
  }

  getConfiguration() {
    return this.config;
  }

  setConfiguration(config) {
    if (this.setConfigurationThrows) throw new Error('InvalidModificationError');
    this.config = config;
    this.trace.push(['setConfiguration', config?.iceServers, config?.iceTransportPolicy]);
  }

  restartIce() {
    this.trace.push(['restartIce']);
  }

  async setLocalDescription() {
    this.trace.push(['setLocalDescription']);
  }

  close() {
    this.closed = true;
    this.signalingState = 'closed';
  }

  /** Move o estado e dispara os handlers, como o navegador faria. */
  emitConnection(state) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }

  emitIce(state) {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.();
  }

  emitSignaling(state) {
    this.signalingState = state;
    this.onsignalingstatechange?.();
  }

  /** Simula o que a negociação faz: associar as m-lines dos nossos transceivers. */
  associateAll() {
    this.transceivers.forEach((t, i) => {
      t.mid = String(i);
    });
  }
}

FakePeerConnection.reset();

// ------------------------------------------------------------------- fixtures

function installGlobals() {
  globalThis.RTCPeerConnection = FakePeerConnection;
  globalThis.MediaStream = FakeMediaStream;
}

/**
 * Um mesh com um par, com tudo o que os testes precisam observar.
 *
 * `iceQueue` é a sequência de respostas do provedor: cada renovação consome a
 * próxima, e a última se repete. É o que permite escrever "a primeira falha, a
 * segunda funciona" sem cronômetro.
 */
async function meshWithPeer({
  peerId = 'peer-b',
  selfId = 'peer-a',
  iceQueue = [TURN],
  addPeerNow = true,
  ...overrides
} = {}) {
  installGlobals();
  FakePeerConnection.reset();

  const events = { peerState: [], remoteScreen: [], signals: [] };
  const iceCalls = [];
  const pending = [...iceQueue];

  const mesh = new WebRTCMesh({
    signaling: { sendSignal: (id, data) => events.signals.push([id, data]) },
    iceServers: [],
    localStream: new FakeMediaStream([fakeTrack('audio', 'mic'), fakeTrack('video', 'cam')]),
    getSelfId: () => selfId,
    getRoomKey: () => null,
    onPeerStateChange: (id, state) => events.peerState.push([id, state]),
    onRemoteScreen: (id, stream) => events.remoteScreen.push([id, stream]),
    getIceServers: async (opts) => {
      iceCalls.push(opts || {});
      return pending.length > 1 ? pending.shift() : pending[0];
    },
    ...overrides,
  });

  if (!addPeerNow) return { mesh, events, iceCalls };

  await mesh.addPeer(peerId);
  const rec = mesh.peers.get(peerId);
  return { mesh, rec, pc: rec?.pc, events, iceCalls };
}

/**
 * Silencia e coleta o console durante um trecho.
 *
 * Silenciar importa tanto quanto coletar: metade destes testes exercita
 * justamente os caminhos que logam, e sem isto a saída da suíte fica ilegível.
 */
async function captureConsole(fn) {
  const errors = [];
  const warns = [];
  const origError = console.error;
  const origWarn = console.warn;
  console.error = (...a) => errors.push(a.join(' '));
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    const result = await fn();
    return { result, errors, warns };
  } finally {
    console.error = origError;
    console.warn = origWarn;
  }
}

/**
 * Avança o relógio falso e deixa as microtasks correrem.
 *
 * A recuperação é assíncrona dentro do timer (ela espera a renovação da
 * credencial), então `tick()` sozinho agenda o trabalho mas não o conclui.
 */
async function tick(ms) {
  mock.timers.tick(ms);
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
}

function traceOf(kind) {
  return FakePeerConnection.trace.filter(([k]) => k === kind);
}

// ------------------------------------------------------- A13: reserva de par

test('duas chamadas concorrentes de addPeer constroem UMA conexão (A13, R1)', async () => {
  installGlobals();
  FakePeerConnection.reset();

  let liberar;
  const espera = new Promise((r) => {
    liberar = r;
  });

  const mesh = new WebRTCMesh({
    signaling: { sendSignal: () => {} },
    iceServers: [],
    localStream: new FakeMediaStream([]),
    getSelfId: () => 'peer-a',
    // Renovação lenta: é ela que abre a janela de reentrância que a guarda
    // `peers.has()` sozinha não fecha.
    getIceServers: async () => {
      await espera;
      return TURN;
    },
  });

  const a = mesh.addPeer('peer-b');
  const b = mesh.addPeer('peer-b'); // como o handleSignal faz, com o sinal chegando junto
  liberar();
  await Promise.all([a, b]);

  assert.equal(
    FakePeerConnection.instances.length,
    1,
    'a segunda conexão ficaria órfã, viva e sem referência para fechá-la',
  );
  assert.ok(mesh.peers.has('peer-b'), 'as duas chamadas resolvem com o par registrado');
});

test('sair da sala durante a construção não deixa par fantasma (D12)', async () => {
  installGlobals();
  FakePeerConnection.reset();

  let liberar;
  const espera = new Promise((r) => {
    liberar = r;
  });
  const mesh = new WebRTCMesh({
    signaling: { sendSignal: () => {} },
    iceServers: [],
    localStream: new FakeMediaStream([]),
    getSelfId: () => 'peer-a',
    getIceServers: async () => {
      await espera;
      return TURN;
    },
  });

  const entrando = mesh.addPeer('peer-b');
  mesh.removePeer('peer-b'); // saiu antes de terminar de entrar
  liberar();
  await entrando;

  assert.equal(mesh.peers.has('peer-b'), false, 'quem saiu não pode ser registrado depois');
});

test('a credencial é renovada a cada conexão nova, não uma vez por sessão', async () => {
  const { mesh, iceCalls } = await meshWithPeer();
  await mesh.addPeer('peer-c');

  assert.equal(iceCalls.length, 2, 'uma renovação por RTCPeerConnection');
});

// ------------------------------------------------------------- A14: sem TURN

test('lista sem TURN reporta failed na hora, sem lançar e sem perder o par (A14, D6)', async () => {
  // Uma lista só de STUN: era exatamente o que o fallback antigo devolvia, e é o
  // caso que mais engana — parece uma configuração de ICE legítima e, sob
  // `relay`, não gera um único candidato utilizável.
  const { result, errors } = await captureConsole(() => meshWithPeer({ iceQueue: [SO_STUN] }));

  assert.ok(result.mesh.peers.has('peer-b'), 'o par segue registrado — a recuperação pode resgatá-lo');
  assert.deepEqual(result.events.peerState, [['peer-b', 'failed']]);
  assert.ok(
    errors.some((e) => e.includes('sem servidor TURN')),
    'a falha precisa ser dita, não deduzida de um tile mudo dezenas de segundos depois',
  );
});

test('o valor reportado é sempre do enum de RTCPeerConnectionState (contrato)', async () => {
  // A task irmã consome `onPeerStateChange(peerId, connectionState)` na outra
  // worktree. Inventar um estado tipo 'no-turn' quebraria o consumidor dela sem
  // que nada aqui reclamasse.
  const legitimos = new Set(['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed']);
  const { result } = await captureConsole(() => meshWithPeer({ iceQueue: [[]] }));

  assert.ok(result.events.peerState.length > 0, 'o teste não pode passar por não ter observado nada');
  for (const [, state] of result.events.peerState) {
    assert.ok(legitimos.has(state), `${state} não é RTCPeerConnectionState`);
  }
});

// -------------------------------------------------- A15/A17/A18: recuperação

test('disconnected que volta dentro da carência não dispara recuperação (A15)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const { pc } = await meshWithPeer();

  pc.emitConnection('disconnected');
  await tick(4_000);
  pc.emitConnection('connected');
  await tick(60_000);

  assert.deepEqual(traceOf('restartIce'), [], 'oscilação de rede não merece restart');
  assert.deepEqual(traceOf('setConfiguration'), []);
});

test('disconnected além da carência dispara UMA recuperação (A15)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const { pc } = await meshWithPeer({ selfId: 'zzz' }); // impolite: 'zzz' > 'peer-b'

  pc.emitConnection('disconnected');
  await tick(4_999);
  assert.deepEqual(traceOf('setConfiguration'), [], 'ainda dentro da carência');

  await tick(2);
  assert.equal(traceOf('setConfiguration').length, 1);
  assert.equal(traceOf('restartIce').length, 1);
});

test('os quatro gatilhos juntos produzem UMA recuperação, não quatro (D10)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const { pc } = await meshWithPeer({ selfId: 'zzz' });

  // connectionState e iceConnectionState, failed e disconnected, tudo junto.
  pc.connectionState = 'failed';
  pc.iceConnectionState = 'failed';
  pc.onconnectionstatechange();
  pc.oniceconnectionstatechange();
  pc.emitConnection('disconnected');
  pc.emitIce('disconnected');
  await tick(10);

  assert.equal(traceOf('restartIce').length, 1, 'um flag e um timer desduplicam os quatro gatilhos');
});

test('recuperar é renovar, reconfigurar e SÓ ENTÃO reiniciar o ICE (A17)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const NOVO = [{ urls: ['turn:relay.test:3478'], username: 'renovado', credential: 'x' }];
  const { pc, iceCalls } = await meshWithPeer({ selfId: 'zzz', iceQueue: [TURN, NOVO] });

  pc.emitConnection('failed');
  await tick(10);

  assert.deepEqual(
    iceCalls[1],
    { force: true },
    'a recuperação força a renovação: "a conexão caiu" é evidência de que o cache pode estar errado',
  );

  const seq = FakePeerConnection.trace
    .filter(([k]) => k === 'setConfiguration' || k === 'restartIce')
    .map(([k]) => k);
  assert.deepEqual(seq, ['setConfiguration', 'restartIce'], 'restartIce sozinho é um no-op caro');

  const [, servers, policy] = traceOf('setConfiguration')[0];
  assert.deepEqual(servers, NOVO, 'reconfigura com a lista RENOVADA, não com a do construtor');
  assert.equal(policy, 'relay', 'a política de privacidade não pode se perder no caminho');
});

test('sem TURN na renovação, NÃO reinicia o ICE e reagenda o backoff (A17)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const origError = console.error;
  console.error = () => {};
  try {
    const { pc, events } = await meshWithPeer({ selfId: 'zzz', iceQueue: [TURN, []] });

    pc.emitConnection('failed');
    await tick(10);

    assert.deepEqual(traceOf('restartIce'), [], 'reiniciar sem credencial repete a mesma falha');
    assert.deepEqual(traceOf('setConfiguration'), []);
    assert.ok(
      events.peerState.some(([, s]) => s === 'failed'),
      'a ausência de TURN é reportada a cada tentativa',
    );

    // …e continua tentando, para o caso de a credencial voltar.
    await tick(2_100);
    assert.ok(events.peerState.filter(([, s]) => s === 'failed').length >= 2);
  } finally {
    console.error = origError;
  }
});

test('as tentativas respeitam o backoff, param no teto e o contador zera (A18)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const origError = console.error;
  const erros = [];
  console.error = (...a) => erros.push(a.join(' '));
  try {
    const { pc, events } = await meshWithPeer({ selfId: 'zzz' });

    pc.emitConnection('failed');
    await tick(10);
    assert.equal(traceOf('restartIce').length, 1);

    // O 'failed' que o próprio restart produz não pode furar o backoff.
    pc.emitConnection('failed');
    await tick(1_900);
    assert.equal(traceOf('restartIce').length, 1, 'ainda dentro do backoff de 2s');

    await tick(200);
    assert.equal(traceOf('restartIce').length, 2);

    // Esgota o resto: 4s, 8s, 16s e então o teto.
    for (const espera of [4_100, 8_100, 16_100, 30_100]) {
      pc.emitConnection('failed');
      await tick(espera);
    }

    assert.equal(traceOf('restartIce').length, 5, 'cinco tentativas, e não mais');
    assert.ok(
      erros.some((e) => e.includes('recuperação esgotada')),
      'desistir em silêncio é o bug que esta task veio eliminar',
    );
    assert.equal(events.peerState.at(-1)[1], 'failed', 'a UI continua sabendo a verdade');

    // Voltando a conectar, o orçamento se renova.
    pc.emitConnection('connected');
    await tick(10);
    pc.emitConnection('failed');
    await tick(10);
    assert.equal(traceOf('restartIce').length, 6, 'o contador zera ao ver connected');
  } finally {
    console.error = origError;
  }
});

test('o lado polite não reinicia de imediato, mas a válvula abre em 15s (D10)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const { pc } = await meshWithPeer({ selfId: 'aaa' }); // polite: 'aaa' < 'peer-b'

    pc.emitConnection('failed');
    await tick(10);
    assert.deepEqual(traceOf('restartIce'), [], 'os dois reiniciando dobra a sinalização na pior hora');
    assert.equal(traceOf('setConfiguration').length, 1, 'mas a credencial é renovada dos dois lados');

    await tick(15_100);
    assert.equal(traceOf('restartIce').length, 1, 'se o impolite não voltou, o polite age');
  } finally {
    console.warn = origWarn;
  }
});

test('setConfiguration que lança não mata a recuperação (R10)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const { pc } = await meshWithPeer({ selfId: 'zzz' });
    pc.setConfigurationThrows = true;

    pc.emitConnection('failed');
    await tick(10);

    assert.equal(traceOf('restartIce').length, 1, 'melhor tentar com credencial velha do que não tentar');
  } finally {
    console.warn = origWarn;
  }
});

// ---------------------------------------------------- A19: timers e teardown

test('removePeer durante uma recuperação pendente não deixa efeito nenhum (A19, R3)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const { mesh, pc } = await meshWithPeer({ selfId: 'zzz' });

  pc.emitConnection('failed');
  await tick(10);
  assert.equal(traceOf('restartIce').length, 1);

  mesh.removePeer('peer-b');
  await tick(120_000); // muito além do maior backoff

  assert.equal(traceOf('restartIce').length, 1, 'um setTimeout não pode ressuscitar quem saiu da sala');
  assert.equal(mesh.peers.has('peer-b'), false, 'e não pode recriar o par');
  assert.equal(FakePeerConnection.instances.length, 1);
});

test('closeAll leva os timers junto', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const { mesh, pc } = await meshWithPeer({ selfId: 'zzz' });

  pc.emitConnection('disconnected');
  mesh.closeAll();
  await tick(120_000);

  assert.deepEqual(traceOf('restartIce'), []);
});

// ------------------------------------ A16/A23: negociação, uma offer por vez

test('verificação não dispara offer quando todos os transceivers têm mid (A23)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const { pc } = await meshWithPeer();
  pc.associateAll();

  pc.emitSignaling('stable');
  await tick(10_000);

  assert.deepEqual(
    traceOf('setLocalDescription'),
    [],
    'sem evidência não há ação: dobrar a negociação em toda entrada é o anti-pattern',
  );
});

test('transceiver sem mid dispara a segunda rodada, no máximo 3 vezes (A23)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const origWarn = console.warn;
  const origError = console.error;
  console.warn = () => {};
  console.error = () => {};
  try {
    const { pc } = await meshWithPeer();
    // Estado do perdedor do glare: os quatro sendonly seguem não associados.

    for (const espera of [800, 2_100, 5_100, 10_000]) {
      pc.emitSignaling('stable');
      await tick(espera);
    }

    assert.equal(traceOf('setLocalDescription').length, 3, 'teto de 3, e não um laço');
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
});

test('⭐ failed E transceiver sem mid ao mesmo tempo: UMA negociação (A16, R2)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const origWarn = console.warn;
  console.warn = () => {};
  try {
    const { pc } = await meshWithPeer({ selfId: 'zzz' });

    // As duas condições no mesmo instante — que é o caso comum, não o raro: uma
    // conexão que recuperou volta a `stable` com transceivers possivelmente não
    // associados.
    pc.emitConnection('failed');
    pc.emitSignaling('stable');
    await tick(10);

    // O restart faz o navegador pedir negociação; a verificação também acha
    // motivo. As duas passam pela mesma porta.
    pc.onnegotiationneeded();
    await tick(1_000);

    assert.equal(
      traceOf('setLocalDescription').length,
      1,
      'duas offers concorrentes para o mesmo par são glare artificial',
    );
    assert.equal(traceOf('restartIce').length, 1);
  } finally {
    console.warn = origWarn;
  }
});

test('a recuperação não cria offer diretamente — quem cria é o negotiationneeded', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const { pc } = await meshWithPeer({ selfId: 'zzz' });
  pc.associateAll();

  pc.emitConnection('failed');
  await tick(10);

  assert.equal(traceOf('restartIce').length, 1);
  assert.deepEqual(
    traceOf('setLocalDescription'),
    [],
    'chamar setLocalDescription depois do restartIce são duas offers para o mesmo restart',
  );
});

// --------------------------------------------- A20/A21/A22: estado do par

test('state-request responde ao remetente e só a ele, coalescido (A20, R6)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const { mesh, rec } = await meshWithPeer();
  await mesh.addPeer('peer-c');
  const outro = mesh.peers.get('peer-c');

  rec.channel.sent.length = 0;
  outro.channel.sent.length = 0;

  rec.channel.onmessage({ data: JSON.stringify({ type: 'state-request' }) });
  assert.deepEqual(rec.channel.types(), ['state'], 'responde com o estado corrente');
  assert.deepEqual(outro.channel.types(), [], 'responder com broadcast seriam N mensagens, não 1');

  rec.channel.onmessage({ data: JSON.stringify({ type: 'state-request' }) });
  assert.deepEqual(rec.channel.types(), ['state'], 'pedido repetido em janela curta não gera resposta');
});

test('o canal que abre pede o estado do outro lado, além de anunciar o seu', async () => {
  const { rec } = await meshWithPeer();

  rec.channel.sent.length = 0;
  rec.channel.onopen();

  assert.deepEqual(rec.channel.types(), ['state', 'state-request']);
});

test('ao voltar de uma recuperação, o par reafirma estado e snapshot (A21)', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const snapshot = { enabled: true, lamport: 3, entries: [], tombstones: [], playback: null };
  const { rec, pc } = await meshWithPeer({
    selfId: 'zzz',
    getMusicSnapshot: () => snapshot,
  });

  pc.emitConnection('failed');
  await tick(10);
  rec.channel.sent.length = 0;

  pc.emitConnection('connected');
  await tick(10);

  assert.deepEqual(
    rec.channel.types(),
    ['state', 'music-snapshot'],
    'sem isto o par volta com áudio e sem a tela: a track de tela chega vazia',
  );
});

test('conectar sem ter passado por recuperação NÃO reanuncia nada', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const { rec, pc } = await meshWithPeer();
  rec.channel.sent.length = 0;

  pc.emitConnection('connected');
  await tick(10);

  assert.deepEqual(rec.channel.types(), [], 'reafirmar em toda transição é amplificação');
});

test('tipo desconhecido no canal é ignorado sem erro no console (A22)', async () => {
  const { rec } = await meshWithPeer();

  const { errors, warns } = await captureConsole(() => {
    rec.channel.onmessage({ data: JSON.stringify({ type: 'invencao-do-futuro', x: 1 }) });
    rec.channel.onmessage({ data: 'nem json é' });
  });

  assert.deepEqual(errors, [], 'é assim que um par com bundle antigo ignora o state-request');
  assert.deepEqual(warns, []);
});

// ------------------------------------------------------------------- R9

test("iceTransportPolicy 'relay' vale para toda conexão, inclusive depois de recuperar (R9)", async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());

  const { pc } = await meshWithPeer({ selfId: 'zzz' });
  assert.equal(pc.config.iceTransportPolicy, 'relay');

  pc.emitConnection('failed');
  await tick(10);

  assert.equal(
    pc.getConfiguration().iceTransportPolicy,
    'relay',
    'afrouxar a política vazaria IP local entre participantes, sem quebrar nenhum teste funcional',
  );
});
