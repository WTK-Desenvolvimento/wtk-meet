/**
 * O que os módulos puros não conseguem provar sozinhos: que os **componentes**
 * ligam as pontas.
 *
 * Três cadeias, uma por defeito desta entrega:
 *
 * 1. `PeerAudio` aplica saída e reprodução em **cada** peer, e nenhum dos seus
 *    elementos é `muted`. Um `<audio muted>` seria a repetição exata do bug: o
 *    `setSinkId` teria sucesso sobre um elemento que não produz som.
 * 2. `VideoTile` não tem mais `setSinkId` nenhum — o roteamento saiu junto com o
 *    som — e o indicador de conexão é irmão do `.video-label`, nunca parte dele.
 * 3. A transição que o mesh reporta chega ao registro do participante, com as
 *    duas guardas: peer que já saiu não ressuscita, e valor repetido não gera
 *    `Map` novo.
 *
 * A cadeia 3 usa o `WebRTCMesh` **real** com um dublê de `RTCPeerConnection`
 * (mesmo padrão de `musicMeshRouting.test.ts`): o que se afirma é que o
 * callback que já existia e ninguém consumia agora chega ao estado.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';


const { createElement } = await import('react');
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: PeerAudio } = await import('../src/components/PeerAudio.js');
const { default: VideoTile } = await import('../src/components/VideoTile.js');
const { applyPeerConnectionState, describeConnection } = await import(
  '../src/lib/peerConnectionStatus.js'
);
const { useAudibleMedia } = await import('../src/lib/audibleMedia.js');

const componentSource = (name: string) =>
  readFileSync(new URL(`../src/components/${name}`, import.meta.url), 'utf8');
const peerAudioSource = componentSource('PeerAudio.tsx');
const remoteMusicSource = componentSource('RemoteMusicAudio.tsx');

/**
 * Um participante, como este arquivo o monta: só o que os dois componentes
 * leem. O cast de `stream` sai em `comoParticipantes`.
 */
type ParticipanteFalso = { displayName?: string; stream?: { id?: string } };

/** O mapa dublê entregue ao componente: o `stream` é só uma identidade aqui. */
const comoParticipantes = (mapa: Map<string, ParticipanteFalso>) =>
  mapa as unknown as Map<string, { stream?: MediaStream | null }>;

/** Um filho da árvore que o `PeerAudio` devolve. */
interface FilhoDeAudio {
  props: {
    sinkId?: string;
    unlockNonce?: number;
    onBlocked?: () => void;
    onSinkError?: (err: unknown) => void;
    stream?: { id?: string };
  };
}

// ------------------------------------------- 1. o sink sai de quem tem som

test('PeerAudio monta um <audio> por peer com stream, e nenhum é muted', () => {
  const participants = new Map([
    ['p1', { displayName: 'Alice', stream: {} }],
    ['p2', { displayName: 'Bob', stream: {} }],
    // Sem stream ainda: não há o que reproduzir, e um elemento vazio só
    // acenderia um falso aviso de autoplay bloqueado.
    ['p3', { displayName: 'Carol' }],
  ]);
  const html = renderToStaticMarkup(
    createElement(PeerAudio, {
      participants: comoParticipantes(participants),
      sinkId: 'spk-b',
      unlockNonce: 0,
    }),
  );

  const elements = html.match(/<audio[^>]*>/g) || [];
  assert.equal(elements.length, 2);
  for (const element of elements) {
    // `muted` aqui seria o bug de volta: `setSinkId` com sucesso, som nenhum.
    assert.ok(!/\bmuted\b/.test(element), `elemento de peer veio muted: ${element}`);
    assert.ok(/autoplay/i.test(element));
  }
});

test('PeerAudio repassa sink, bloqueio e nonce a TODO peer, não só ao primeiro', () => {
  // `PeerAudio` não usa hook nenhum: chamá-lo direto devolve a árvore de
  // elementos, e as props de cada filho são o que ele de fato entrega ao
  // `useAudibleMedia`. É o componente real sob teste, sem espelho e sem DOM —
  // `react-dom/server` renderizaria a marcação e jogaria as props fora.
  const participants = new Map([
    ['p1', { stream: { id: 'a' } }],
    ['p2', { stream: { id: 'b' } }],
  ]);
  const onSinkError = () => {};
  const onBlocked = () => {};

  const tree = PeerAudio({
    participants: comoParticipantes(participants),
    sinkId: 'spk-b',
    onSinkError,
    onBlocked,
    unlockNonce: 3,
  });
  // O cast: `PeerAudio` devolve um elemento React, e o que se afirma aqui são
  // as props que ele repassou a cada filho.
  const children = tree.props.children as FilhoDeAudio[];

  assert.equal(children.length, 2);
  for (const child of children) {
    assert.equal(child.props.sinkId, 'spk-b');
    assert.equal(child.props.unlockNonce, 3);
    assert.equal(child.props.onBlocked, onBlocked);
    assert.equal(child.props.onSinkError, onSinkError);
  }
  assert.deepEqual(children.map((c) => c.props.stream!.id), ['a', 'b']);
  // O container não pode ganhar caixa de layout nem `display:none`: o elemento
  // precisa continuar sendo mídia ativa para tocar.
  assert.equal(tree.props.className, 'peer-audio-sinks');
});

test('o hook de mídia audível é o mesmo dos dois componentes de áudio', () => {
  // A duplicação era a causa raiz do defeito 2 (um chamava `play()`, o outro
  // não). Um `import` que suma daqui é a regressão voltando.
  assert.equal(typeof useAudibleMedia, 'function');
  for (const source of [peerAudioSource, remoteMusicSource]) {
    assert.match(source, /useAudibleMedia\(ref, \{/);
    assert.match(source, /from '\.\.\/lib\/audibleMedia\.js'/);
  }
});

// ------------------------------------- 2. o tile não roteia mais saída nenhuma

test('VideoTile não aceita mais sinkId nem onSinkError', () => {
  // A assinatura é o contrato: uma prop que não existe mais não pode voltar por
  // descuido. `VideoTile.length` é 1 (um objeto de props), então a checagem é
  // sobre o texto da declaração — o jeito mais direto de travar a remoção.
  const source = VideoTile.toString();
  assert.ok(!/sinkId/.test(source), 'sinkId voltou para o VideoTile');
  assert.ok(!/setSinkId/.test(source), 'setSinkId voltou para o VideoTile');
  assert.ok(!/onSinkError/.test(source), 'onSinkError voltou para o VideoTile');
});

test('o <video> do tile continua muted, sempre', () => {
  const html = renderToStaticMarkup(
    createElement(VideoTile, { label: 'Alice', connection: describeConnection('failed') }),
  );
  const video = html.match(/<video[^>]*>/)![0]!;
  assert.ok(/\bmuted\b/.test(video), 'o áudio dos peers não pode voltar para dentro do tile');
});

test('o indicador de conexão é irmão do .video-label, e não entra nele', () => {
  const html = renderToStaticMarkup(
    createElement(VideoTile, { label: 'Alice', connection: describeConnection('failed') }),
  );

  assert.match(html, /<span class="tile-connection bad"[^>]*>Sem conexão<\/span>/);
  assert.match(html, /class="video-tile[^"]*conn-bad/);
  // O e2e compara o `textContent` do rótulo em vários roteiros que não são
  // desta entrega: nenhum texto novo pode entrar ali.
  const label = html.match(/<span class="video-label">(.*?)<\/span>/s)![1]!;
  assert.equal(label, 'Alice');
});

test('conexão saudável não deixa marca nenhuma no tile', () => {
  const html = renderToStaticMarkup(
    createElement(VideoTile, { label: 'Alice', connection: describeConnection('connected') }),
  );
  assert.ok(!html.includes('tile-connection'));
  assert.ok(!/conn-(warn|bad)/.test(html));
});

test('cada estado tem seu rótulo e seu nível no tile', () => {
  const cases = [
    ['connecting', 'Conectando…', 'warn'],
    ['disconnected', 'Instável', 'warn'],
    ['failed', 'Sem conexão', 'bad'],
    ['closed', 'Desconectado', 'bad'],
  ];
  for (const [state, label, level] of cases) {
    const html = renderToStaticMarkup(
      createElement(VideoTile, { label: 'Alice', connection: describeConnection(state) }),
    );
    assert.ok(html.includes(`>${label}<`), `${state} deveria mostrar "${label}"`);
    assert.ok(html.includes(`tile-connection ${level}`), `${state} deveria ter nível ${level}`);
  }
});

test('o tile local não recebe indicador — não existe conexão consigo mesmo', () => {
  const html = renderToStaticMarkup(createElement(VideoTile, { label: 'Você' }));
  assert.ok(!html.includes('tile-connection'));
});

// --------------------------------- 3. a transição do mesh chega ao estado

test('a transição para failed aparece no registro daquele participante', () => {
  const before = new Map<string, { displayName: string; connectionState?: string }>([
    ['p1', { displayName: 'Alice' }],
    ['p2', { displayName: 'Bob' }],
  ]);
  const after = applyPeerConnectionState(before, 'p1', 'failed');

  assert.notEqual(after, before, 'a grade precisa re-renderizar');
  assert.equal(after.get('p1')!.connectionState, 'failed');
  assert.equal(after.get('p1')!.displayName, 'Alice', 'o registro existente foi perdido');
  // Um peer em `failed` não pode apagar o indicador de mais ninguém.
  assert.equal(after.get('p2')!.connectionState, undefined);
  assert.deepEqual(describeConnection(after.get('p1')!.connectionState), {
    level: 'bad',
    label: 'Sem conexão',
    live: 'assertive',
  });
  assert.equal(describeConnection(after.get('p2')!.connectionState)!.label, 'Conectando…');
});

test('a transição de um peer que já saiu não o ressuscita', () => {
  // `removePeer` fecha a conexão e a transição para `closed` chega depois. Sem
  // a guarda, o `Map` ganharia um registro sem nome e sem stream — um tile
  // fantasma na grade.
  const before = new Map<string, { displayName: string; connectionState?: string }>([
    ['p1', { displayName: 'Alice' }],
  ]);
  const after = applyPeerConnectionState(before, 'ja-saiu', 'closed');

  assert.equal(after, before);
  assert.equal(after.has('ja-saiu'), false);
});

test('o mesmo estado repetido devolve o mesmo Map', () => {
  const before = new Map([['p1', { displayName: 'Alice', connectionState: 'connected' }]]);
  assert.equal(applyPeerConnectionState(before, 'p1', 'connected'), before);
  assert.notEqual(applyPeerConnectionState(before, 'p1', 'disconnected'), before);
});

test('o mesh real entrega a transição a quem passar onPeerStateChange', async () => {
  // A ponta que estava solta: o callback já era disparado a cada
  // `connectionstatechange` e ninguém o passava. Aqui ele é ligado ao mesmo
  // redutor que o `Room` usa.
  const seen: [string, string][] = [];
  const created: FakePC[] = [];

  /** `RTCPeerConnection` dublê: o mínimo que o mesh chama na entrada de um par. */
  class FakePC {
    connectionState: string;
    signalingState: string;
    localDescription: unknown;
    onconnectionstatechange?: (() => void) | null;

    constructor() {
      this.connectionState = 'new';
      this.signalingState = 'stable';
      this.localDescription = null;
      created.push(this);
    }
    addTransceiver() {
      return { sender: { replaceTrack: async () => {} }, direction: 'sendrecv' };
    }
    createDataChannel() {
      return { readyState: 'connecting', send() {}, close() {} };
    }
    addEventListener() {}
    addTrack() {
      return { replaceTrack: async () => {} };
    }
    close() {
      this.connectionState = 'closed';
      this.onconnectionstatechange?.();
    }
    /** O que o navegador faz sozinho; aqui é explícito. */
    transitionTo(state: string) {
      this.connectionState = state;
      this.onconnectionstatechange?.();
    }
  }

  // O mesh cria um `MediaStream` por canal de mídia do peer; no Node não existe.
  class FakeMediaStream {
    tracks: unknown[];
    constructor() {
      this.tracks = [];
    }
    addTrack(track: unknown) {
      this.tracks.push(track);
    }
    getTracks() {
      return this.tracks;
    }
    addEventListener() {}
    removeEventListener() {}
  }

  const originalPC = globalThis.RTCPeerConnection;
  const originalMS = globalThis.MediaStream;
  // A fronteira do dublê: ele implementa o que o mesh chama, não a interface
  // inteira do navegador.
  globalThis.RTCPeerConnection = FakePC as unknown as typeof RTCPeerConnection;
  globalThis.MediaStream = FakeMediaStream as unknown as typeof MediaStream;
  try {
    const { WebRTCMesh } = await import('../src/lib/webrtcMesh.js');
    const mesh = new WebRTCMesh({
      signaling: { sendSignal() {}, socket: { id: 'me' } },
      // Com lista vazia o mesh reporta 'failed' na entrada (_reportMissingTurn):
      // sob relay sem TURN a conexão é impossível por construção. Este caso é
      // sobre a *propagação* da transição, então a fixture traz um TURN válido.
      iceServers: [{ urls: 'turn:127.0.0.1:3478', username: 'u', credential: 'c' }],
      localStream: null,
      getSelfId: () => 'me',
      onPeerStateChange: (peerId: string, state: string) => seen.push([peerId, state]),
    });
    await mesh.addPeer('p1');

    let participants = new Map<string, { displayName: string; connectionState?: string }>([
      ['p1', { displayName: 'Alice' }],
    ]);
    const [pc] = created;
    for (const state of ['connecting', 'connected', 'failed']) {
      pc!.transitionTo(state);
      participants = applyPeerConnectionState(participants, 'p1', state);
    }

    assert.deepEqual(seen, [
      ['p1', 'connecting'],
      ['p1', 'connected'],
      ['p1', 'failed'],
    ]);
    assert.equal(participants.get('p1')!.connectionState, 'failed');
    assert.equal(describeConnection(participants.get('p1')!.connectionState)!.label, 'Sem conexão');
  } finally {
    globalThis.RTCPeerConnection = originalPC;
    globalThis.MediaStream = originalMS;
  }
});
