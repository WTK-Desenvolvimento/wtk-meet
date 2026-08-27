/**
 * O contrato estrutural do mesh — o que ele monta ao criar um par, e o que ele
 * desmonta ao fechar.
 *
 * Rede de segurança da migração para TypeScript. `webrtcMesh.js` é o arquivo
 * mais frágil do produto (1067 linhas) e o que menos perdoa: quase tudo que ele
 * faz é irreversível do lado de fora — uma m-line criada fora de ordem só
 * aparece como "a tela de fulano virou a câmera de fulano" no navegador de
 * outra pessoa, dez minutos depois, no E2E.
 *
 * Os testes que já existem cobrem *política* de exceção — `meshRecovery`
 * (renovar → setConfiguration → restartIce), `musicMeshRouting` (para onde vai
 * cada track de música) e `joinCameraDefault` (o estado inicial anunciado).
 * O que faltava, e é o que este arquivo cobre, é o **esqueleto**: quantas
 * conexões nascem, com que configuração, com quais transceivers, em que ordem,
 * e o que sobra depois de fechar.
 *
 * Nenhum destes casos é sobre desenho desejável: eles congelam o que o código
 * faz **hoje**. A conversão para TypeScript tem liberdade para mudar a forma
 * das declarações e nenhuma para mover qualquer linha daqui.
 *
 * `RTCPeerConnection` e `MediaStream` são dublês — o que está sob teste é o
 * mesh, não a pilha WebRTC do navegador.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { CHAT_CHANNEL_ID, CHAT_CHANNEL_LABEL } from '../src/lib/chat.js';
import { WebRTCMesh } from '../src/lib/webrtcMesh.js';

import type { SignalPayload, WebRTCMeshOptions } from '../src/lib/webrtcMesh.js';
import type { IceServer } from '../src/lib/iceServers.js';

const TURN = [{ urls: ['turn:relay.test:3478'], username: 'u', credential: 'c' }];

// ------------------------------------------------------------ dublês de WebRTC

/**
 * Os dublês implementam **o que o mesh chama**, e não a interface do navegador
 * inteira. O preço são os `as unknown as` da fronteira, cada um comentado.
 */
interface FakeTrack {
  kind: string;
  id: string;
  contentHint: string;
  enabled: boolean;
  readyState: string;
  stopped: boolean;
  stop(): void;
  addEventListener(): void;
  removeEventListener(): void;
}

function fakeTrack(kind: string, id = `${kind}-track`): FakeTrack {
  return {
    kind,
    id,
    contentHint: '',
    enabled: true,
    readyState: 'live',
    stopped: false,
    stop() {
      this.stopped = true;
      this.readyState = 'ended';
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

class FakeMediaStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = [...tracks];
  }
  addTrack(t: FakeTrack) {
    if (!this.tracks.includes(t)) this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
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
    this.readyState = 'connecting';
    this.sent = [];
    this.closed = false;
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.closed = true;
    this.readyState = 'closed';
  }
}

/** Um transceiver dublê: só o que o mesh lê. */
interface FakeTransceiver {
  mid: string | null;
  kind: string;
  direction?: string;
  sender: {
    track: unknown;
    replaceTrack: (track: unknown) => Promise<void>;
    getParameters: (() => unknown) | null;
  };
}

class FakePeerConnection {
  static instances: FakePeerConnection[] = [];

  config: RTCConfiguration | undefined;
  connectionState: string;
  iceConnectionState: string;
  signalingState: string;
  localDescription: { type: string; sdp: string };
  transceivers: FakeTransceiver[];
  closed: boolean;
  channel?: FakeDataChannel;
  onicecandidate?: ((event: unknown) => void) | null;
  ontrack?: ((event: unknown) => void) | null;
  onnegotiationneeded?: (() => void) | null;
  onconnectionstatechange?: (() => void) | null;
  oniceconnectionstatechange?: (() => void) | null;
  onsignalingstatechange?: (() => void) | null;

  constructor(config?: RTCConfiguration) {
    this.config = config;
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.signalingState = 'stable';
    this.localDescription = { type: 'offer', sdp: 'v=0' };
    this.transceivers = [];
    this.closed = false;
    FakePeerConnection.instances.push(this);
  }

  static reset() {
    FakePeerConnection.instances = [];
  }

  addTransceiver(kind: string, { direction }: { direction?: string } = {}) {
    const t = {
      mid: null,
      kind,
      direction,
      sender: {
        track: null as unknown,
        async replaceTrack(track: unknown) {
          this.track = track;
        },
        getParameters: null,
      },
    };
    this.transceivers.push(t);
    return t;
  }

  getTransceivers() {
    return [...this.transceivers];
  }

  createDataChannel(label: string, options?: RTCDataChannelInit) {
    this.channel = new FakeDataChannel(label, options);
    return this.channel;
  }

  getConfiguration() {
    return this.config;
  }
  setConfiguration(config: RTCConfiguration) {
    this.config = config;
  }
  restartIce() {}
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}

  close() {
    this.closed = true;
    this.signalingState = 'closed';
  }
}

FakePeerConnection.reset();

// ------------------------------------------------------------------- fixtures

/**
 * Constrói um mesh com os globais de WebRTC dublados.
 *
 * Devolve também `restore`, e todo caso o chama num `finally`: deixar
 * `globalThis.RTCPeerConnection` sujo vaza para os outros arquivos da suíte,
 * que rodam no mesmo processo.
 */
function makeMesh({
  iceServers = TURN,
  localStream = null,
  selfId = 'aaa-eu',
  ...rest
}: {
  iceServers?: IceServer[];
  localStream?: FakeMediaStream | null;
  selfId?: string;
} & Omit<Partial<WebRTCMeshOptions>, 'localStream'> = {}) {
  const originalPC = globalThis.RTCPeerConnection;
  const originalMS = globalThis.MediaStream;
  // A fronteira do dublê: ele implementa o que o mesh chama, não a interface
  // inteira do navegador — que traria `generateCertificate`, `clone` e mais uma
  // dúzia de membros que nenhum caso exercita.
  globalThis.RTCPeerConnection = FakePeerConnection as unknown as typeof RTCPeerConnection;
  globalThis.MediaStream = FakeMediaStream as unknown as typeof MediaStream;
  FakePeerConnection.reset();

  const sent: [string, SignalPayload][] = [];
  const mesh = new WebRTCMesh({
    signaling: {
      sendSignal: (peerId, data) => sent.push([peerId, data]),
      socket: { id: selfId },
    },
    iceServers,
    localStream: localStream as unknown as MediaStream | null,
    getSelfId: () => selfId,
    getRoomKey: () => null,
    // Injetado para nenhum caso tocar a rede: o provedor real faz fetch.
    getIceServers: async () => iceServers,
    ...rest,
  });

  return {
    mesh,
    sent,
    instances: FakePeerConnection.instances,
    restore() {
      globalThis.RTCPeerConnection = originalPC;
      globalThis.MediaStream = originalMS;
    },
  };
}

// ------------------------------------------- 1. a forma da conexão que nasce

test('toda RTCPeerConnection nasce com iceTransportPolicy relay', async () => {
  // É a decisão de privacidade mais cara do produto: sem `relay` o IP de casa de
  // cada participante aparece nos candidatos ICE de todo mundo na sala. Um
  // refactor que perca esta linha não quebra nada visível — a chamada continua
  // conectando, só que direto.
  const h = makeMesh();
  try {
    await h.mesh.addPeer('bbb-bob');
    await h.mesh.addPeer('ccc-carol');

    assert.equal(h.instances.length, 2);
    for (const pc of h.instances) {
      assert.equal(pc.config!.iceTransportPolicy, 'relay');
      assert.deepEqual(pc.config!.iceServers, TURN);
    }
  } finally {
    h.restore();
  }
});

test('a entrada cria quatro transceivers sendonly, nesta ordem: mic, câmera, tela, música', async () => {
  // A ordem **é** o protocolo. O outro lado classifica as m-lines que chegam
  // pela posição (`_classifyTransceiver`), então inserir um transceiver no meio
  // — por exemplo o de música "perto do mic", já que os dois são áudio —
  // embaralha câmera com tela na grade de quem está do outro lado.
  const h = makeMesh();
  try {
    await h.mesh.addPeer('bbb-bob');
    const [pc] = h.instances;

    assert.deepEqual(
      pc.transceivers.map((t) => [t.kind, t.direction]),
      [
        ['audio', 'sendonly'],
        ['video', 'sendonly'],
        ['video', 'sendonly'],
        ['audio', 'sendonly'],
      ],
    );
  } finally {
    h.restore();
  }
});

test('cada transceiver fica guardado no registro do par, um por papel', async () => {
  const h = makeMesh();
  try {
    await h.mesh.addPeer('bbb-bob');
    const rec = h.mesh.peers.get('bbb-bob')!;
    const [audioT, camT, screenT, musicT] = h.instances[0]!.transceivers;

    assert.equal(rec.audioT, audioT);
    assert.equal(rec.camT, camT);
    assert.equal(rec.screenT, screenT);
    assert.equal(rec.musicT, musicT);
  } finally {
    h.restore();
  }
});

test('as tracks locais já entram nos senders na criação do par', async () => {
  // Um par que entra depois tem que nascer com o estado atual aplicado; se as
  // tracks só fossem ligadas por renegociação, quem chega ouviria silêncio até
  // o próximo evento.
  const mic = fakeTrack('audio', 'mic-1');
  const cam = fakeTrack('video', 'cam-1');
  const h = makeMesh({ localStream: new FakeMediaStream([mic, cam]) });
  try {
    await h.mesh.addPeer('bbb-bob');
    const [audioT, camT, screenT, musicT] = h.instances[0]!.transceivers;

    assert.equal(audioT.sender.track, mic);
    assert.equal(camT.sender.track, cam);
    assert.equal(screenT.sender.track, null, 'ninguém compartilha tela ao entrar');
    assert.equal(musicT.sender.track, null, 'nem música');
  } finally {
    h.restore();
  }
});

test('o data channel é negociado fora de banda, com o mesmo id nos dois lados', async () => {
  // `negotiated: true` + id fixo é o que dispensa `ondatachannel` e elimina a
  // corrida sobre quem cria o canal. Chat e estado de câmera/tela trafegam por
  // aqui — nunca pelo servidor de sinalização.
  const h = makeMesh();
  try {
    await h.mesh.addPeer('bbb-bob');
    const channel = h.instances[0]!.channel!;

    assert.equal(channel.label, CHAT_CHANNEL_LABEL);
    assert.equal(channel.options!.negotiated, true);
    assert.equal(channel.options!.id, CHAT_CHANNEL_ID);
    assert.equal(channel.options!.ordered, true);
  } finally {
    h.restore();
  }
});

test('o papel polite sai da comparação lexicográfica dos ids, e é oposto nas duas pontas', async () => {
  // Sem sorteio e sem round-trip: exatamente um lado cede em caso de colisão de
  // offer. Se os dois lados calculassem o mesmo papel, uma renegociação
  // simultânea travaria a conexão em glare.
  const h = makeMesh({ selfId: 'aaa' });
  try {
    await h.mesh.addPeer('zzz');
    assert.equal(h.mesh.peers.get('zzz')!.polite, true, '"aaa" < "zzz" → polite');
  } finally {
    h.restore();
  }

  const outro = makeMesh({ selfId: 'zzz' });
  try {
    await outro.mesh.addPeer('aaa');
    assert.equal(outro.mesh.peers.get('aaa')!.polite, false, 'a outra ponta é impolite');
  } finally {
    outro.restore();
  }
});

// --------------------------------------------- 2. sem TURN utilizável

test('lista de ICE servers vazia não lança e reporta o par como failed', async () => {
  // Sob `relay` sem nenhum TURN o desfecho é determinístico: zero candidatos,
  // zero conexões. Gritar na hora evita dezenas de segundos de tile mudo antes
  // de o ICE desistir sozinho.
  const estados: [string, string][] = [];
  const h = makeMesh({ iceServers: [], onPeerStateChange: (id, s) => estados.push([id, s]) });
  const erros: string[] = [];
  const originalError = console.error;
  console.error = (...args) => erros.push(args.join(' '));
  try {
    await h.mesh.addPeer('bbb-bob');

    assert.deepEqual(estados, [['bbb-bob', 'failed']]);
    assert.equal(h.mesh.peers.has('bbb-bob'), true, 'o par é registrado assim mesmo');
    assert.ok(
      erros.some((linha) => linha.includes('sem servidor TURN utilizável')),
      'o motivo vai para o console de quem estiver olhando',
    );
  } finally {
    console.error = originalError;
    h.restore();
  }
});

test('só STUN também conta como "sem TURN"', async () => {
  // `relay` descarta candidatos host e srflx: um STUN sozinho é tão inútil
  // quanto lista vazia, e precisa produzir o mesmo aviso.
  const estados: [string, string][] = [];
  const h = makeMesh({
    iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }],
    onPeerStateChange: (id, s) => estados.push([id, s]),
  });
  const originalError = console.error;
  console.error = () => {};
  try {
    await h.mesh.addPeer('bbb-bob');
    assert.deepEqual(estados, [['bbb-bob', 'failed']]);
  } finally {
    console.error = originalError;
    h.restore();
  }
});

test('com TURN válido a entrada é silenciosa — nenhum estado é reportado', async () => {
  const estados: [string, string][] = [];
  const h = makeMesh({ onPeerStateChange: (id, s) => estados.push([id, s]) });
  try {
    await h.mesh.addPeer('bbb-bob');
    assert.deepEqual(estados, [], 'o primeiro estado só vem do connectionstatechange real');
  } finally {
    h.restore();
  }
});

// ------------------------------------- 3. um par é um par: nunca dois objetos

test('addPeer duas vezes para o mesmo par não cria uma segunda conexão', async () => {
  const h = makeMesh();
  try {
    await h.mesh.addPeer('bbb-bob');
    await h.mesh.addPeer('bbb-bob');

    assert.equal(h.instances.length, 1);
    assert.equal(h.mesh.peers.size, 1);
  } finally {
    h.restore();
  }
});

test('addPeer e handleSignal concorrentes compartilham a mesma construção', async () => {
  // A janela existe porque `addPeer` espera a renovação da credencial: o `Room`
  // chama `addPeer` no `peer-joined` enquanto o primeiro sinal do mesmo par já
  // está chegando, e `handleSignal` chama `addPeer` também. Sem o mapa de
  // em-voo seriam duas `RTCPeerConnection` para o mesmo par — a segunda
  // sobrescreve o mapa e a primeira fica órfã, viva, com tracks, sem nenhuma
  // referência que permita fechá-la. O sintoma é mídia que não chega,
  // intermitentemente, num par específico.
  const h = makeMesh();
  try {
    await Promise.all([
      h.mesh.addPeer('bbb-bob'),
      h.mesh.handleSignal('bbb-bob', { type: 'ice-candidate', candidate: { candidate: 'x' } }),
    ]);

    assert.equal(h.instances.length, 1, 'uma conexão, não duas');
    assert.equal(h.mesh.peers.size, 1);
  } finally {
    h.restore();
  }
});

test('um sinal de par desconhecido cria exatamente uma conexão para ele', async () => {
  // O primeiro sinal pode chegar antes do `peer-joined` — a ordem entre os dois
  // não é garantida pelo servidor.
  const h = makeMesh();
  try {
    await h.mesh.handleSignal('bbb-bob', { type: 'ice-candidate', candidate: { candidate: 'x' } });

    assert.equal(h.instances.length, 1);
    assert.equal(h.mesh.peers.has('bbb-bob'), true);
  } finally {
    h.restore();
  }
});

test('depois de fechado, nem sinal nem addPeer criam conexão nova', async () => {
  const h = makeMesh();
  try {
    h.mesh.closeAll();
    await h.mesh.addPeer('bbb-bob');
    await h.mesh.handleSignal('ccc-carol', { type: 'ice-candidate', candidate: { candidate: 'x' } });

    assert.equal(h.instances.length, 0, 'sala fechada não abre conexão');
    assert.equal(h.mesh.peers.size, 0);
  } finally {
    h.restore();
  }
});

test('sair durante a construção não deixa par fantasma no mapa', async () => {
  // `removePeer` durante o await da credencial não acha nada para remover,
  // porque o par ainda não está no mapa. Sem a marca de abandono, a construção
  // registraria, depois, uma conexão para quem já não está na sala.
  // `!` de atribuição definitiva: o executor do `Promise` roda sincronamente.
  let liberar!: () => void;
  const espera = new Promise<void>((resolve) => {
    liberar = resolve;
  });
  const h = makeMesh({
    getIceServers: async () => {
      await espera;
      return TURN;
    },
  });
  try {
    const emVoo = h.mesh.addPeer('bbb-bob');
    h.mesh.removePeer('bbb-bob');
    liberar();
    await emVoo;

    assert.equal(h.mesh.peers.has('bbb-bob'), false, 'quem saiu não volta pela porta dos fundos');
    assert.equal(h.mesh.peers.size, 0);
  } finally {
    h.restore();
  }
});

// ------------------------------------------------------- 4. o desmonte

test('closeAll fecha toda conexão, todo canal e para toda track recebida', async () => {
  const h = makeMesh();
  const fechados: string[] = [];
  try {
    await h.mesh.addPeer('bbb-bob');
    await h.mesh.addPeer('ccc-carol');

    // Tracks que chegaram do outro lado — o mesh é dono de pará-las, porque um
    // <video> que ainda referencie o stream mantém o decoder vivo.
    const recebidas: FakeTrack[] = [];
    for (const rec of h.mesh.peers.values()) {
      for (const stream of [rec.stream, rec.screenStream, rec.musicStream]) {
        const t = fakeTrack('video', `remota-${recebidas.length}`);
        stream.addTrack(t as unknown as MediaStreamTrack);
        recebidas.push(t);
      }
    }

    h.mesh.onRemoteStreamClosed = (peerId) => fechados.push(peerId);
    h.mesh.closeAll();

    assert.equal(h.mesh.closed, true);
    assert.equal(h.mesh.peers.size, 0, 'o mapa de pares esvazia');
    assert.deepEqual(h.instances.map((pc) => pc.closed), [true, true]);
    assert.deepEqual(h.instances.map((pc) => pc.channel!.closed), [true, true]);
    assert.equal(recebidas.every((t) => t.stopped), true, 'nenhuma track remota fica viva');
    assert.deepEqual(fechados.sort(), ['bbb-bob', 'ccc-carol']);
  } finally {
    h.restore();
  }
});

test('closeAll solta todos os handlers da conexão', async () => {
  // Um handler sobrevivente dispara numa PC fechada e ressuscita caminho de
  // recuperação para um par que já não existe.
  const h = makeMesh();
  try {
    await h.mesh.addPeer('bbb-bob');
    const [pc] = h.instances;
    h.mesh.closeAll();

    for (const nome of [
      'onicecandidate',
      'onnegotiationneeded',
      'ontrack',
      'onconnectionstatechange',
      'oniceconnectionstatechange',
      'onsignalingstatechange',
    ]) {
      // O índice por string: a lista acima é a asserção — cada handler que o
      // mesh instalou tem que voltar a `null`.
      assert.equal((pc as unknown as Record<string, unknown>)[nome], null, `${nome} continuou ligado depois do fechamento`);
    }
  } finally {
    h.restore();
  }
});

test('removePeer tira só o par pedido e avisa quem observa', async () => {
  const h = makeMesh();
  const fechados: string[] = [];
  try {
    await h.mesh.addPeer('bbb-bob');
    await h.mesh.addPeer('ccc-carol');
    h.mesh.onRemoteStreamClosed = (peerId) => fechados.push(peerId);

    h.mesh.removePeer('bbb-bob');

    assert.deepEqual([...h.mesh.peers.keys()], ['ccc-carol']);
    assert.deepEqual(fechados, ['bbb-bob']);
    assert.equal(h.instances[0]!.closed, true);
    assert.equal(h.instances[1].closed, false, 'quem ficou não é afetado');
  } finally {
    h.restore();
  }
});

test('removePeer de par desconhecido não lança nem avisa ninguém', async () => {
  const h = makeMesh();
  const fechados: string[] = [];
  try {
    h.mesh.onRemoteStreamClosed = (peerId) => fechados.push(peerId);
    assert.doesNotThrow(() => h.mesh.removePeer('nunca-existiu'));
    assert.deepEqual(fechados, []);
  } finally {
    h.restore();
  }
});

// -------------------------------------------------- 5. o estado local inicial

test('o estado anunciado nasce coerente com as tracks que existem', async () => {
  // `cameraOff` é derivado da ausência de track de vídeo, e não de um default
  // fixo: entrar com a câmera desligada é o caminho normal do produto (PreJoin).
  const semCamera = makeMesh({ localStream: new FakeMediaStream([fakeTrack('audio')]) });
  try {
    assert.deepEqual(semCamera.mesh.localState, {
      displayName: '',
      cameraOff: true,
      micOff: false,
      screenOn: false,
    });
  } finally {
    semCamera.restore();
  }

  const comCamera = makeMesh({
    localStream: new FakeMediaStream([fakeTrack('audio'), fakeTrack('video')]),
  });
  try {
    assert.equal(comCamera.mesh.localState.cameraOff, false);
  } finally {
    comCamera.restore();
  }
});

test('sem stream nenhum o mesh ainda constrói, e se declara sem câmera', async () => {
  // É o estado da sala enquanto o getUserMedia não voltou.
  const h = makeMesh({ localStream: null });
  try {
    assert.equal(h.mesh.localAudioTrack, null);
    assert.equal(h.mesh.localCameraTrack, null);
    assert.equal(h.mesh.localState.cameraOff, true);
  } finally {
    h.restore();
  }
});
