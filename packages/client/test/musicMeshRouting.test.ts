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

/**
 * Os dublês implementam **o que o mesh chama**, e não a interface do navegador
 * inteira. O preço são os `as unknown as` da fronteira, cada um comentado.
 */
interface FakeTrack {
  kind: string;
  id: string;
  contentHint: string;
  stopped: boolean;
  listeners: Map<string, (event: { type: string }) => void>;
  stop(): void;
  addEventListener(type: string, handler: (event: { type: string }) => void): void;
  emit(type: string): void;
}

function fakeTrack(kind: string, id = `${kind}-track`): FakeTrack {
  return {
    kind,
    id,
    contentHint: '',
    stopped: false,
    listeners: new Map(),
    stop() {
      this.stopped = true;
    },
    addEventListener(type: string, handler: (event: { type: string }) => void) {
      this.listeners.set(type, handler);
    },
    emit(type: string) {
      this.listeners.get(type)?.({ type });
    },
  };
}

class FakeMediaStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }

  addTrack(track: FakeTrack) {
    if (!this.tracks.includes(track)) this.tracks.push(track);
  }

  removeTrack(track: FakeTrack) {
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
  track: FakeTrack | null;
  replaceCalls: (FakeTrack | null)[];
  parameters: { encodings: { maxBitrate?: number }[] };
  setParametersCalls: unknown[];
  setParametersRejects: boolean;
  constructor() {
    this.track = null;
    this.replaceCalls = [];
    this.parameters = { encodings: [{}] };
    this.setParametersCalls = [];
    this.setParametersRejects = false;
  }

  async replaceTrack(track: FakeTrack | null) {
    this.replaceCalls.push(track);
    this.track = track;
  }

  getParameters() {
    return this.parameters;
  }

  setParameters(params: unknown) {
    this.setParametersCalls.push(params);
    return this.setParametersRejects
      ? Promise.reject(new Error('não suportado'))
      : Promise.resolve();
  }
}

/** Um payload do data channel, já desserializado. */
interface PayloadEnviado {
  type?: string;
  [campo: string]: unknown;
}

class FakeDataChannel {
  label: string;
  options: RTCDataChannelInit | undefined;
  readyState: string;
  sent: PayloadEnviado[];
  closed: boolean;
  onopen?: (() => void) | null;
  onmessage?: ((event: { data: string }) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  constructor(label: string, options?: RTCDataChannelInit) {
    this.label = label;
    this.options = options;
    this.readyState = 'open';
    this.sent = [];
    this.closed = false;
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.closed = true;
    this.readyState = 'closed';
  }
}

/** Um transceiver dublê: o que o mesh lê ao classificar as m-lines. */
interface FakeTransceiver {
  kind: string;
  direction?: string;
  sender: FakeSender;
  receiver: { track: FakeTrack | null };
  remote?: boolean;
  mid?: string | null;
}

class FakePeerConnection {
  static created: FakePeerConnection[] = [];

  config: RTCConfiguration | undefined;
  transceivers: FakeTransceiver[];
  channel: FakeDataChannel | null;
  closed: boolean;
  onicecandidate?: ((event: unknown) => void) | null;
  ontrack?: ((event: unknown) => void) | null;
  onnegotiationneeded?: (() => void) | null;
  onconnectionstatechange?: (() => void) | null;
  oniceconnectionstatechange?: (() => void) | null;
  onsignalingstatechange?: (() => void) | null;

  constructor(config?: RTCConfiguration) {
    this.config = config;
    this.transceivers = [];
    this.channel = null;
    this.closed = false;
    FakePeerConnection.created.push(this);
  }

  addTransceiver(kind: string, options: { direction?: string } = {}) {
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
  addRemoteTransceiver(kind: string) {
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

  createDataChannel(label: string, options?: RTCDataChannelInit) {
    this.channel = new FakeDataChannel(label, options);
    return this.channel;
  }

  close() {
    this.closed = true;
  }

  restartIce() {}
}
FakePeerConnection.created = [];

// A fronteira do dublê: ele implementa o que o mesh chama, não a interface
// inteira do navegador.
globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
globalThis.MediaStream = FakeMediaStream as unknown as typeof MediaStream;

/** Como um dublê é entregue a uma opção do mesh que espera o tipo do navegador. */
const comoNavegador = <T,>(duble: unknown): T => duble as T;

const { WebRTCMesh } = await import('../src/lib/webrtcMesh.js');

import type {
  MusicMessage,
} from '../src/lib/musicProtocol.js';
import type { SessionSnapshot } from '../src/lib/musicSession.js';
import type {
  PeerRecord,
  RemotePeerState,
  SignalPayload,
  WebRTCMeshOptions,
} from '../src/lib/webrtcMesh.js';

// ------------------------------------------------------------------ auxiliares

async function meshWithPeer(overrides: Partial<WebRTCMeshOptions> = {}) {
  FakePeerConnection.created.length = 0;
  const events: {
    remoteStream: [string, MediaStream][];
    remoteScreen: [string, MediaStream | null][];
    remoteMusic: [string, MediaStream][];
    music: [string, MusicMessage][];
    chat: [string, unknown][];
    state: [string, RemotePeerState][];
    signals: [string, SignalPayload][];
  } = {
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
    localStream: comoNavegador<MediaStream>(localStream),
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
  // Os `!`/casts: `addPeer` acabou de registrar o par, e tanto a conexão quanto
  // o canal que ele guarda são os dublês instalados acima.
  const rec = mesh.peers.get('peer-b')!;
  const pc = rec.pc as unknown as FakePeerConnection;
  return { mesh, rec, pc, events, localStream };
}

/** O caminho inverso: o transceiver que o mesh guardou é o dublê. */
const trDe = (t: RTCRtpTransceiver | undefined): FakeTransceiver =>
  t as unknown as FakeTransceiver;

/** Um transceiver dublê, entregue a um método que espera o do navegador. */
const comoTransceiver = (t: unknown): RTCRtpTransceiver => t as RTCRtpTransceiver;

/** Um evento `track` dublê, com só os dois campos que o mesh lê. */
const comoTrackEvent = (e: { track: FakeTrack; transceiver?: unknown; streams?: unknown[] }): RTCTrackEvent =>
  e as unknown as RTCTrackEvent;

/** A conexão que o mesh guarda é o dublê — um lugar só para o cast. */
const pcDe = (rec: PeerRecord): FakePeerConnection =>
  rec.pc as unknown as FakePeerConnection;

/** O canal que o mesh guarda é o dublê — um lugar só para o cast. */
const canalDe = (rec: PeerRecord): FakeDataChannel =>
  rec.channel as unknown as FakeDataChannel;

function deliver(rec: PeerRecord, payload: unknown) {
  canalDe(rec).onmessage!({ data: JSON.stringify(payload) });
}

// ------------------------------------------------------- contrato das m-lines

test('a ordem de envio é mic, câmera, tela e música — nessa ordem, sempre', async () => {
  const { rec } = await meshWithPeer();

  assert.deepEqual(
    pcDe(rec).transceivers.map((t) => t.kind),
    ['audio', 'video', 'video', 'audio'],
    'a música entra depois da tela: inserir no meio embaralha câmera com tela',
  );
  assert.equal(rec.audioT, pcDe(rec).transceivers[0]);
  assert.equal(rec.camT, pcDe(rec).transceivers[1]);
  assert.equal(rec.screenT, pcDe(rec).transceivers[2]);
  assert.equal(rec.musicT, pcDe(rec).transceivers[3]);
  assert.ok(pcDe(rec).transceivers.every((t) => t.direction === 'sendonly'));
});

test('os transceivers do outro lado são classificados por posição: o quarto é música', async () => {
  const { mesh, rec } = await meshWithPeer();
  const remote = ['audio', 'video', 'video', 'audio'].map((kind) => pcDe(rec).addRemoteTransceiver(kind));

  assert.equal(mesh._classifyTransceiver(rec, comoTransceiver(remote[0]!)), 'audio');
  assert.equal(mesh._classifyTransceiver(rec, comoTransceiver(remote[1]!)), 'camera');
  assert.equal(mesh._classifyTransceiver(rec, comoTransceiver(remote[2]!)), 'screen');
  assert.equal(mesh._classifyTransceiver(rec, comoTransceiver(remote[3]!)), 'music');
});

test('layout inesperado cai no tipo da track em vez de derrubar a chamada', async () => {
  const { mesh, rec } = await meshWithPeer();
  for (const kind of ['audio', 'video', 'video', 'audio']) pcDe(rec).addRemoteTransceiver(kind);
  const extra = pcDe(rec).addRemoteTransceiver('audio'); // quinta m-line: fora do contrato

  assert.equal(mesh._classifyTransceiver(rec, comoTransceiver(extra)), 'audio');
});

// ------------------------------------------------------- roteamento de tracks

test('a música do peer vai para o stream de música, nunca para o de voz', async () => {
  const { mesh, rec, events } = await meshWithPeer();
  const musicTrack = fakeTrack('audio', 'music-remota');

  mesh._handleTrack(rec, comoTrackEvent({ track: musicTrack, transceiver: rec.musicT }));

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

  mesh._handleTrack(rec, comoTrackEvent({ track: voice, transceiver: rec.audioT }));
  mesh._handleTrack(rec, comoTrackEvent({ track: screen, transceiver: rec.screenT }));

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
  mesh._handleTrack(rec, comoTrackEvent({ track: musicTrack, transceiver: rec.musicT }));

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
  assert.doesNotThrow(() => canalDe(rec).onmessage!({ data: 'não é json' }));

  assert.deepEqual(events.chat, [['peer-b', { text: 'oi' }]]);
  assert.equal(events.state.length, 1);
  assert.equal(events.state[0][1].cameraOff, true);
  assert.deepEqual(events.music, [], 'nada além de music-* pode entrar no roteamento de música');
});

// ------------------------------------------------------------------- snapshot

test('quem entra recebe o estado musical inteiro assim que o canal abre', async () => {
  const snapshot = comoNavegador<SessionSnapshot>({
    enabled: true,
    lamport: 7,
    entries: [{ id: 'e1', kind: 'url', title: 'Faixa' }],
    tombstones: ['e0'],
    playback: { version: 3, ownerId: 'peer-a', entryId: 'e1', positionSec: 42, playing: true, delivery: 'stream' },
  });
  const { rec } = await meshWithPeer({ getMusicSnapshot: () => snapshot });

  canalDe(rec).onopen!();

  assert.deepEqual(
    canalDe(rec).sent.map((payload) => payload.type),
    ['state', 'music-snapshot', 'state-request'],
    'estado da grade, estado da música e o pedido do estado do outro lado',
  );
  const sent = canalDe(rec).sent[1];
  assert.equal(sent.type, 'music-snapshot');
  assert.equal(sent.lamport, 7);
  assert.equal(sent.enabled, true);
  assert.deepEqual(sent.tombstones, ['e0']);
  // O cast: `sent` é o payload cru do canal, e o que se afirma aqui é
  // justamente que o campo aninhado atravessou.
  assert.equal((sent.playback as { positionSec: number }).positionSec, 42, 'sem a posição, quem entra ouve a faixa do início');
});

test('sem estado musical, o canal abre mandando o estado da grade e o pedido', async () => {
  const { rec } = await meshWithPeer({ getMusicSnapshot: () => null });

  canalDe(rec).onopen!();

  assert.deepEqual(
    canalDe(rec).sent.map((payload) => payload.type),
    ['state', 'state-request'],
  );
});

// -------------------------------------------------------------- track de saída

test('assumir a faixa mexe só no canal de música e marca o conteúdo como música', async () => {
  const { mesh, rec } = await meshWithPeer();
  const micReplaces = trDe(rec.audioT).sender.replaceCalls.length;
  const music = fakeTrack('audio', 'minha-musica');

  await mesh.setMusicTrack(comoNavegador<MediaStreamTrack>(music));

  assert.equal(trDe(rec.musicT).sender.track, music);
  assert.equal(
    trDe(rec.audioT).sender.replaceCalls.length,
    micReplaces,
    'o mic não pode ser tocado: silenciar o microfone não silencia a música',
  );
  assert.equal(music.contentHint, 'music', 'sem a dica, o encoder de voz derruba os agudos');
});

test('o canal de música tem teto de banda por conexão', async () => {
  const { mesh, rec } = await meshWithPeer();
  await mesh.setMusicTrack(comoNavegador<MediaStreamTrack>(fakeTrack('audio', 'minha-musica')));

  // O cast: `setParametersCalls` guarda o que o mesh passou, sem forma declarada.
  const [params] = trDe(rec.musicT).sender.setParametersCalls as {
    encodings: { maxBitrate?: number }[];
  }[];
  assert.equal(params!.encodings[0]!.maxBitrate, 96_000);
});

test('largar a faixa devolve o canal ao silêncio sem derrubar a conexão', async () => {
  const { mesh, rec } = await meshWithPeer();
  await mesh.setMusicTrack(comoNavegador<MediaStreamTrack>(fakeTrack('audio', 'minha-musica')));

  await mesh.setMusicTrack(null);

  assert.equal(trDe(rec.musicT).sender.track, null);
  assert.equal(mesh.localMusicTrack, null);
  assert.equal(pcDe(rec).closed, false, 'trocar de dono não pode renegociar nem derrubar nada');
  assert.equal(pcDe(rec).transceivers.length, 4, 'o transceiver continua negociado');
});

test('navegador que recusa o teto de banda toca sem teto, em vez de não tocar', async () => {
  const { mesh, rec } = await meshWithPeer();
  trDe(rec.musicT).sender.setParametersRejects = true;
  await assert.doesNotReject(mesh.setMusicTrack(comoNavegador<MediaStreamTrack>(fakeTrack('audio', 'm'))));

  const bare = await meshWithPeer();
  delete (trDe(bare.rec.musicT).sender as { getParameters?: unknown }).getParameters;
  await assert.doesNotReject(bare.mesh.setMusicTrack(comoNavegador<MediaStreamTrack>(fakeTrack('audio', 'm'))));
});

test('quem entra no meio da faixa já nasce com a música aplicada', async () => {
  const { mesh } = await meshWithPeer();
  const music = fakeTrack('audio', 'minha-musica');
  await mesh.setMusicTrack(comoNavegador<MediaStreamTrack>(music));

  await mesh.addPeer('peer-c');
  const novo = mesh.peers.get('peer-c')!;

  assert.equal(trDe(novo.musicT).sender.track, music);
  assert.equal(trDe(novo.musicT).sender.setParametersCalls.length, 1);
});

// ------------------------------------------------------------------- teardown

test('ao remover o peer, a track de música também para', async () => {
  const { mesh, rec } = await meshWithPeer();
  const musicTrack = fakeTrack('audio', 'music-remota');
  mesh._handleTrack(rec, comoTrackEvent({ track: musicTrack, transceiver: rec.musicT }));

  mesh.removePeer('peer-b');

  assert.equal(musicTrack.stopped, true, 'sem parar, o decoder continua vivo');
  assert.deepEqual(rec.musicStream.getTracks(), []);
  assert.equal(pcDe(rec).closed, true);
});
