/**
 * O quarto canal de mídia no mesh: por onde a música sai e por onde ela chega.
 *
 * Duas coisas aqui são contrato de rede, não estilo, e as duas falham **em
 * silêncio** quando quebram:
 *
 * 1. **A ordem em que os transceivers são criados é a ordem das m-lines**, e é
 *    por posição que o outro lado classifica o que recebe. Trocar a ordem, ou
 *    estender `addTransceiver` sem estender a lista de classificação, faz a
 *    música cair no stream de voz — onde ela acende o anel de "falando" no tile
 *    de quem toca e perde o volume próprio. Tudo continua *parecendo* funcionar.
 * 2. **A autoria de uma mensagem é a conexão em que ela chegou**, nunca o que o
 *    payload declara. Aceitar um id declarado deixaria qualquer participante
 *    votar ou comandar em nome de outro.
 *
 * O `RTCPeerConnection` é substituído por um dublê: o que está sob teste é o
 * roteamento do mesh, não a pilha WebRTC do navegador.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

// ------------------------------------------------------------ dublês de WebRTC

function fakeTrack(kind, id = `${kind}-track`) {
  return {
    kind,
    id,
    contentHint: '',
    stopped: false,
    listeners: new Map(),
    stop() {
      this.stopped = true;
    },
    addEventListener(type, handler) {
      this.listeners.set(type, handler);
    },
    emit(type) {
      this.listeners.get(type)?.({ type });
    },
  };
}

class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = [...tracks];
  }

  addTrack(track) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }

  removeTrack(track) {
    this.tracks = this.tracks.filter((item) => item !== track);
  }

  getTracks() {
    return [...this.tracks];
  }

  getAudioTracks() {
    return this.tracks.filter((track) => track.kind === 'audio');
  }

  getVideoTracks() {
    return this.tracks.filter((track) => track.kind === 'video');
  }
}

class FakeSender {
  constructor() {
    this.track = null;
    this.replaceCalls = [];
    this.parameters = { encodings: [{}] };
    this.setParametersCalls = [];
    this.setParametersRejects = false;
  }

  async replaceTrack(track) {
    this.replaceCalls.push(track);
    this.track = track;
  }

  getParameters() {
    return this.parameters;
  }

  setParameters(params) {
    this.setParametersCalls.push(params);
    return this.setParametersRejects
      ? Promise.reject(new Error('não suportado'))
      : Promise.resolve();
  }
}

class FakeDataChannel {
  constructor(label, options) {
    this.label = label;
    this.options = options;
    this.readyState = 'open';
    this.sent = [];
    this.closed = false;
  }

  send(data) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = 'closed';
  }
}

class FakePeerConnection {
  constructor(config) {
    this.config = config;
    this.transceivers = [];
    this.channel = null;
    this.closed = false;
    FakePeerConnection.created.push(this);
  }

  addTransceiver(kind, options = {}) {
    const transceiver = {
      kind,
      direction: options.direction,
      sender: new FakeSender(),
      receiver: { track: null },
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  /** O que o navegador cria ao aplicar a oferta remota: na ordem das m-lines. */
  addRemoteTransceiver(kind) {
    const transceiver = {
      kind,
      direction: 'recvonly',
      sender: new FakeSender(),
      receiver: { track: fakeTrack(kind) },
      remote: true,
    };
    this.transceivers.push(transceiver);
    return transceiver;
  }

  getTransceivers() {
    return [...this.transceivers];
  }

  createDataChannel(label, options) {
    this.channel = new FakeDataChannel(label, options);
    return this.channel;
  }

  close() {
    this.closed = true;
  }

  restartIce() {}
}
FakePeerConnection.created = [];

globalThis.RTCPeerConnection = FakePeerConnection;
globalThis.MediaStream = FakeMediaStream;

const { WebRTCMesh } = await import('../src/lib/webrtcMesh.js');

// ------------------------------------------------------------------ auxiliares

async function meshWithPeer(overrides = {}) {
  FakePeerConnection.created.length = 0;
  const events = {
    remoteStream: [],
    remoteScreen: [],
    remoteMusic: [],
    music: [],
    chat: [],
    state: [],
    signals: [],
  };
  const localStream = new FakeMediaStream([fakeTrack('audio', 'mic'), fakeTrack('video', 'cam')]);

  const mesh = new WebRTCMesh({
    signaling: { sendSignal: (peerId, data) => events.signals.push([peerId, data]) },
    iceServers: [],
    // O mesh renova a credencial antes de cada conexão nova. Sem o dublê, ele
    // cairia no provedor real (sem endpoint, num teste de node) e cada `addPeer`
    // logaria o erro de "sem TURN" — ruído que não tem nada a ver com o que este
    // arquivo testa, que é o roteamento das quatro m-lines.
    getIceServers: async () => [{ urls: ['turn:relay.test:3478'] }],
    localStream,
    getSelfId: () => 'peer-a',
    getRoomKey: () => null,
    onRemoteStream: (peerId, stream) => events.remoteStream.push([peerId, stream]),
    onRemoteScreen: (peerId, stream) => events.remoteScreen.push([peerId, stream]),
    onRemotePeerState: (peerId, state) => events.state.push([peerId, state]),
    onChatMessage: (peerId, message) => events.chat.push([peerId, message]),
    onRemoteMusic: (peerId, stream) => events.remoteMusic.push([peerId, stream]),
    onMusicMessage: (peerId, payload) => events.music.push([peerId, payload]),
    ...overrides,
  });

  await mesh.addPeer('peer-b');
  const rec = mesh.peers.get('peer-b');
  return { mesh, rec, events, localStream };
}

function deliver(rec, payload) {
  rec.channel.onmessage({ data: JSON.stringify(payload) });
}

// ------------------------------------------------------- contrato das m-lines

test('a ordem de envio é mic, câmera, tela e música — nessa ordem, sempre', async () => {
  const { rec } = await meshWithPeer();

  assert.deepEqual(
    rec.pc.transceivers.map((t) => t.kind),
    ['audio', 'video', 'video', 'audio'],
    'a música entra depois da tela: inserir no meio embaralha câmera com tela',
  );
  assert.equal(rec.audioT, rec.pc.transceivers[0]);
  assert.equal(rec.camT, rec.pc.transceivers[1]);
  assert.equal(rec.screenT, rec.pc.transceivers[2]);
  assert.equal(rec.musicT, rec.pc.transceivers[3]);
  assert.ok(rec.pc.transceivers.every((t) => t.direction === 'sendonly'));
});

test('os transceivers do outro lado são classificados por posição: o quarto é música', async () => {
  const { mesh, rec } = await meshWithPeer();
  const remote = ['audio', 'video', 'video', 'audio'].map((kind) => rec.pc.addRemoteTransceiver(kind));

  assert.equal(mesh._classifyTransceiver(rec, remote[0]), 'audio');
  assert.equal(mesh._classifyTransceiver(rec, remote[1]), 'camera');
  assert.equal(mesh._classifyTransceiver(rec, remote[2]), 'screen');
  assert.equal(mesh._classifyTransceiver(rec, remote[3]), 'music');
});

test('layout inesperado cai no tipo da track em vez de derrubar a chamada', async () => {
  const { mesh, rec } = await meshWithPeer();
  for (const kind of ['audio', 'video', 'video', 'audio']) rec.pc.addRemoteTransceiver(kind);
  const extra = rec.pc.addRemoteTransceiver('audio'); // quinta m-line: fora do contrato

  assert.equal(mesh._classifyTransceiver(rec, extra), 'audio');
});

// ------------------------------------------------------- roteamento de tracks

test('a música do peer vai para o stream de música, nunca para o de voz', async () => {
  const { mesh, rec, events } = await meshWithPeer();
  const musicTrack = fakeTrack('audio', 'music-remota');

  mesh._handleTrack(rec, { track: musicTrack, transceiver: rec.musicT });

  assert.deepEqual(rec.musicStream.getTracks(), [musicTrack]);
  assert.deepEqual(rec.stream.getTracks(), [], 'música no stream de voz acende o anel de falando');
  assert.equal(rec.hasMusicTrack, true);
  assert.deepEqual(events.remoteMusic, [['peer-b', rec.musicStream]]);
  assert.deepEqual(events.remoteStream, [], 'onRemoteStream é da voz; a música tem canal próprio');
});

test('voz e tela continuam onde estavam — o quarto canal não desloca nada', async () => {
  const { mesh, rec, events } = await meshWithPeer();
  const voice = fakeTrack('audio', 'voz');
  const screen = fakeTrack('video', 'tela');

  mesh._handleTrack(rec, { track: voice, transceiver: rec.audioT });
  mesh._handleTrack(rec, { track: screen, transceiver: rec.screenT });

  assert.deepEqual(rec.stream.getTracks(), [voice]);
  assert.deepEqual(rec.screenStream.getTracks(), [screen]);
  assert.deepEqual(rec.musicStream.getTracks(), []);
  assert.equal(events.remoteStream.length, 1);
  assert.equal(rec.hasScreenTrack, true);
  // A track de tela chega vazia na negociação: só vira tile quando anunciada.
  assert.deepEqual(events.remoteScreen, []);
});

test('a track de música que termina sai do stream sem levar o resto junto', async () => {
  const { mesh, rec } = await meshWithPeer();
  const musicTrack = fakeTrack('audio', 'music-remota');
  mesh._handleTrack(rec, { track: musicTrack, transceiver: rec.musicT });

  musicTrack.emit('ended');
  assert.deepEqual(rec.musicStream.getTracks(), []);
});

// ---------------------------------------------------- roteamento de mensagens

test('a autoria de uma mensagem de música é a conexão, não o que o payload diz', async () => {
  const { rec, events } = await meshWithPeer();

  deliver(rec, { type: 'music-vote-cast', voteId: 'v1', vote: 'yes', voterId: 'peer-c' });

  assert.equal(events.music.length, 1);
  const [peerId, payload] = events.music[0];
  assert.equal(peerId, 'peer-b', 'o id declarado no payload permitiria votar por outro');
  assert.equal(payload.voteId, 'v1');
});

test('todos os tipos music-* passam pelo mesmo roteamento, e só eles', async () => {
  const { rec, events } = await meshWithPeer();
  const types = [
    'music-vote-open',
    'music-vote-cast',
    'music-vote-result',
    'music-queue-add',
    'music-queue-remove',
    'music-queue-reorder',
    'music-playback',
    'music-command',
    'music-snapshot',
  ];
  for (const type of types) deliver(rec, { type });

  assert.deepEqual(
    events.music.map(([, payload]) => payload.type),
    types,
  );
});

test('chat, estado e tipo desconhecido não regridem com a música no canal', async () => {
  const { rec, events } = await meshWithPeer();

  deliver(rec, { type: 'chat', message: { text: 'oi' } });
  deliver(rec, { type: 'state', cameraOff: true, micOff: false, screenOn: false, displayName: 'Bea' });
  assert.doesNotThrow(() => deliver(rec, { type: 'musica-inventada' }));
  assert.doesNotThrow(() => rec.channel.onmessage({ data: 'não é json' }));

  assert.deepEqual(events.chat, [['peer-b', { text: 'oi' }]]);
  assert.equal(events.state.length, 1);
  assert.equal(events.state[0][1].cameraOff, true);
  assert.deepEqual(events.music, [], 'nada além de music-* pode entrar no roteamento de música');
});

// ------------------------------------------------------------------- snapshot

test('quem entra recebe o estado musical inteiro assim que o canal abre', async () => {
  const snapshot = {
    enabled: true,
    lamport: 7,
    entries: [{ id: 'e1', kind: 'url', title: 'Faixa' }],
    tombstones: ['e0'],
    playback: { version: 3, ownerId: 'peer-a', entryId: 'e1', positionSec: 42, playing: true, delivery: 'stream' },
  };
  const { rec } = await meshWithPeer({ getMusicSnapshot: () => snapshot });

  rec.channel.onopen();

  assert.deepEqual(
    rec.channel.sent.map((payload) => payload.type),
    ['state', 'music-snapshot', 'state-request'],
    'estado da grade, estado da música e o pedido do estado do outro lado',
  );
  const sent = rec.channel.sent[1];
  assert.equal(sent.type, 'music-snapshot');
  assert.equal(sent.lamport, 7);
  assert.equal(sent.enabled, true);
  assert.deepEqual(sent.tombstones, ['e0']);
  assert.equal(sent.playback.positionSec, 42, 'sem a posição, quem entra ouve a faixa do início');
});

test('sem estado musical, o canal abre mandando o estado da grade e o pedido', async () => {
  const { rec } = await meshWithPeer({ getMusicSnapshot: () => null });

  rec.channel.onopen();

  assert.deepEqual(
    rec.channel.sent.map((payload) => payload.type),
    ['state', 'state-request'],
  );
});

// -------------------------------------------------------------- track de saída

test('assumir a faixa mexe só no canal de música e marca o conteúdo como música', async () => {
  const { mesh, rec } = await meshWithPeer();
  const micReplaces = rec.audioT.sender.replaceCalls.length;
  const music = fakeTrack('audio', 'minha-musica');

  await mesh.setMusicTrack(music);

  assert.equal(rec.musicT.sender.track, music);
  assert.equal(
    rec.audioT.sender.replaceCalls.length,
    micReplaces,
    'o mic não pode ser tocado: silenciar o microfone não silencia a música',
  );
  assert.equal(music.contentHint, 'music', 'sem a dica, o encoder de voz derruba os agudos');
});

test('o canal de música tem teto de banda por conexão', async () => {
  const { mesh, rec } = await meshWithPeer();
  await mesh.setMusicTrack(fakeTrack('audio', 'minha-musica'));

  const [params] = rec.musicT.sender.setParametersCalls;
  assert.equal(params.encodings[0].maxBitrate, 96_000);
});

test('largar a faixa devolve o canal ao silêncio sem derrubar a conexão', async () => {
  const { mesh, rec } = await meshWithPeer();
  await mesh.setMusicTrack(fakeTrack('audio', 'minha-musica'));

  await mesh.setMusicTrack(null);

  assert.equal(rec.musicT.sender.track, null);
  assert.equal(mesh.localMusicTrack, null);
  assert.equal(rec.pc.closed, false, 'trocar de dono não pode renegociar nem derrubar nada');
  assert.equal(rec.pc.transceivers.length, 4, 'o transceiver continua negociado');
});

test('navegador que recusa o teto de banda toca sem teto, em vez de não tocar', async () => {
  const { mesh, rec } = await meshWithPeer();
  rec.musicT.sender.setParametersRejects = true;
  await assert.doesNotReject(mesh.setMusicTrack(fakeTrack('audio', 'm')));

  const bare = await meshWithPeer();
  delete bare.rec.musicT.sender.getParameters;
  await assert.doesNotReject(bare.mesh.setMusicTrack(fakeTrack('audio', 'm')));
});

test('quem entra no meio da faixa já nasce com a música aplicada', async () => {
  const { mesh } = await meshWithPeer();
  const music = fakeTrack('audio', 'minha-musica');
  await mesh.setMusicTrack(music);

  await mesh.addPeer('peer-c');
  const novo = mesh.peers.get('peer-c');

  assert.equal(novo.musicT.sender.track, music);
  assert.equal(novo.musicT.sender.setParametersCalls.length, 1);
});

// ------------------------------------------------------------------- teardown

test('ao remover o peer, a track de música também para', async () => {
  const { mesh, rec } = await meshWithPeer();
  const musicTrack = fakeTrack('audio', 'music-remota');
  mesh._handleTrack(rec, { track: musicTrack, transceiver: rec.musicT });

  mesh.removePeer('peer-b');

  assert.equal(musicTrack.stopped, true, 'sem parar, o decoder continua vivo');
  assert.deepEqual(rec.musicStream.getTracks(), []);
  assert.equal(rec.pc.closed, true);
});
