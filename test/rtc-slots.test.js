import test from 'node:test';
import assert from 'node:assert/strict';

import { installEnv, FakeTrack, createFakeSignaling } from './helpers/fake-env.js';

/**
 * O contrato de slots (audio, camera, tela) e o que faz ligar/desligar camera e
 * tela custar zero renegociacao. Se alguem reordenar os `addTransceiver`, o
 * outro lado passa a receber a tela no lugar da camera — bug silencioso e
 * dificil de achar na mao. Estes testes travam a ordem.
 */

const env = installEnv();
const { createPeerHub, SLOT } = await import('../src/rtc.js');

function setup(tracks = {}) {
  const signaling = createFakeSignaling();
  const local = { micTrack: null, camTrack: null, screenTrack: null, ...tracks };
  const remotes = [];
  const hub = createPeerHub({
    signaling,
    getLocalTracks: () => local,
    onRemoteTrack: (peerId, slot, track) => remotes.push({ peerId, slot, track }),
  });
  return { hub, signaling, local, remotes };
}

const lastPeer = () => env.peers[env.peers.length - 1];

test.beforeEach(() => {
  env.peers.length = 0;
});

test('a oferta cria exatamente tres transceivers na ordem audio, video, video', async () => {
  const { hub } = setup();
  await hub.offerTo('p1');

  const pc = lastPeer();
  const kinds = pc.getTransceivers().map((t) => t.kind);
  assert.deepEqual(kinds, ['audio', 'video', 'video']);
  assert.equal(SLOT.AUDIO, 0);
  assert.equal(SLOT.CAMERA, 1);
  assert.equal(SLOT.SCREEN, 2);
});

test('cada track local vai para o seu slot', async () => {
  const mic = new FakeTrack('audio');
  const cam = new FakeTrack('video');
  const screen = new FakeTrack('video');
  const { hub } = setup({ micTrack: mic, camTrack: cam, screenTrack: screen });

  await hub.offerTo('p1');

  const senders = lastPeer().getSenders();
  assert.equal(senders[SLOT.AUDIO].track, mic);
  assert.equal(senders[SLOT.CAMERA].track, cam);
  assert.equal(senders[SLOT.SCREEN].track, screen);
});

test('a oferta e enviada ao destinatario certo pelo signaling', async () => {
  const { hub, signaling } = setup();
  await hub.offerTo('p1');

  const [msg] = signaling.ofType('signal');
  assert.equal(msg.to, 'p1');
  assert.equal(msg.data.description.type, 'offer');
});

test('a tela pede preferencia de resolucao, nao de fluidez', async () => {
  const { hub } = setup();
  await hub.offerTo('p1');

  const screenSender = lastPeer().getSenders()[SLOT.SCREEN];
  assert.equal(screenSender.params.degradationPreference, 'maintain-resolution');
});

test('desligar a camera envia null no slot dela — o outro lado nao congela', async () => {
  const cam = new FakeTrack('video');
  const { hub, local } = setup({ camTrack: cam });
  await hub.offerTo('p1');

  local.camTrack = null; // foi o `track.stop()` do media.js
  await hub.republish();

  const sender = lastPeer().getSenders()[SLOT.CAMERA];
  assert.equal(sender.track, null);
  assert.deepEqual(sender.replaceCalls, [cam, null], 'o null precisa chegar ao sender');
});

test('religar a camera reenvia o track novo sem recriar a conexao', async () => {
  const primeira = new FakeTrack('video');
  const { hub, local } = setup({ camTrack: primeira });
  await hub.offerTo('p1');
  const pc = lastPeer();

  local.camTrack = null;
  await hub.republish();
  const segunda = new FakeTrack('video');
  local.camTrack = segunda;
  await hub.republish();

  assert.equal(env.peers.length, 1, 'nenhuma conexao nova: sem renegociacao, sem glare');
  assert.equal(pc.getSenders()[SLOT.CAMERA].track, segunda);
  assert.equal(pc.localDescription.type, 'offer', 'a descricao local nao foi refeita');
});

test('compartilhar e parar a tela mexem apenas no slot 2', async () => {
  const cam = new FakeTrack('video');
  const { hub, local } = setup({ camTrack: cam });
  await hub.offerTo('p1');

  const screen = new FakeTrack('video');
  local.screenTrack = screen;
  await hub.republish();
  const senders = lastPeer().getSenders();
  assert.equal(senders[SLOT.SCREEN].track, screen);
  assert.equal(senders[SLOT.CAMERA].track, cam, 'a camera nao pode ser afetada');

  local.screenTrack = null;
  await hub.republish();
  assert.equal(senders[SLOT.SCREEN].track, null);
  assert.equal(senders[SLOT.CAMERA].track, cam);
});

test('quem responde promove os transceivers para sendrecv', async () => {
  const mic = new FakeTrack('audio');
  const { hub, signaling } = setup({ micTrack: mic });

  await hub.handleSignal('p1', { description: { type: 'offer', sdp: 'x' } });

  const pc = lastPeer();
  // Transceivers nascidos de uma oferta remota vem 'recvonly'. Sem promover,
  // o replaceTrack posterior nao envia nada e o outro lado ve tela preta.
  assert.deepEqual(
    pc.getTransceivers().map((t) => t.direction),
    ['sendrecv', 'sendrecv', 'sendrecv'],
  );
  assert.equal(pc.getSenders()[SLOT.AUDIO].track, mic);

  const [msg] = signaling.ofType('signal');
  assert.equal(msg.data.description.type, 'answer');
  assert.equal(msg.to, 'p1');
});

test('a resposta do outro lado e aplicada sem criar conexao nova', async () => {
  const { hub } = setup();
  await hub.offerTo('p1');

  await hub.handleSignal('p1', { description: { type: 'answer', sdp: 'y' } });

  assert.equal(env.peers.length, 1);
  assert.equal(lastPeer().remoteDescription.type, 'answer');
});

test('candidato que chega antes da descricao remota e guardado e reenviado depois', async () => {
  const { hub } = setup();
  await hub.offerTo('p1');
  const pc = lastPeer();

  await hub.handleSignal('p1', { candidate: { candidate: 'cedo-demais' } });
  assert.equal(pc.iceCandidates.length, 0, 'ainda nao da para aplicar');

  await hub.handleSignal('p1', { description: { type: 'answer', sdp: 'y' } });
  assert.equal(pc.iceCandidates.length, 1, 'o candidato guardado precisa ser aplicado');

  await hub.handleSignal('p1', { candidate: { candidate: 'agora-vai' } });
  assert.equal(pc.iceCandidates.length, 2);
});

test('candidato de um peer desconhecido nao explode', async () => {
  const { hub } = setup();
  await hub.handleSignal('fantasma', { candidate: { candidate: 'x' } });
  assert.equal(env.peers.length, 0);
});

test('o track remoto e roteado pelo indice do transceiver', async () => {
  const { hub, remotes } = setup();
  await hub.offerTo('p1');
  const pc = lastPeer();

  for (const slot of [SLOT.AUDIO, SLOT.CAMERA, SLOT.SCREEN]) {
    pc.fire('track', { transceiver: pc.getTransceivers()[slot], track: new FakeTrack('video') });
  }

  assert.deepEqual(
    remotes.map((r) => r.slot),
    [SLOT.AUDIO, SLOT.CAMERA, SLOT.SCREEN],
  );
  assert.ok(remotes.every((r) => r.peerId === 'p1'));
});

test('close solta os senders e fecha a conexao', async () => {
  const cam = new FakeTrack('video');
  const { hub } = setup({ camTrack: cam });
  await hub.offerTo('p1');
  const pc = lastPeer();

  hub.close('p1');

  assert.equal(pc.closed, true);
  assert.equal(hub.size, 0);
  assert.ok(
    pc.getSenders().every((s) => s.track === null),
    'nenhum sender pode continuar segurando um track',
  );
});

test('closeAll fecha todas as conexoes da malha', async () => {
  const { hub } = setup();
  await hub.offerTo('p1');
  await hub.offerTo('p2');
  await hub.offerTo('p3');
  assert.equal(hub.size, 3);

  hub.closeAll();

  assert.equal(hub.size, 0);
  assert.ok(env.peers.every((pc) => pc.closed));
});

test('os candidatos ICE locais sao enviados so ao peer da conexao', async () => {
  const { hub, signaling } = setup();
  await hub.offerTo('p1');
  await hub.offerTo('p2');
  signaling.clear();

  env.peers[0].fire('icecandidate', { candidate: { toJSON: () => ({ candidate: 'a' }) } });

  const enviados = signaling.ofType('signal');
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].to, 'p1');
  assert.deepEqual(enviados[0].data.candidate, { candidate: 'a' });
});
