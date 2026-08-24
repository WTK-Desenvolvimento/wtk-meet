/**
 * WTK-MEET-19 — a **entrada** na sala com a câmera desligada por padrão.
 *
 * O defeito que estes testes protegem é de privacidade e é irreversível: até
 * esta entrega, abrir o link de uma sala chamava `getUserMedia({ video: true })`
 * e o LED da webcam acendia antes de qualquer decisão de quem abriu. Uma vez que
 * um frame saiu, ele saiu.
 *
 * Duas superfícies, e as duas são verificáveis sem navegador:
 *
 * 1. **A cadeia de constraints da entrada** (`initialMediaPlan`). É pura de
 *    propósito — o `Room.jsx` inteiro é intestável sem DOM, e foi exatamente
 *    dentro dele que a cadeia hardcoded viveu sem cobertura nenhuma. O que se
 *    afirma aqui é o que o navegador vai receber, tentativa por tentativa.
 * 2. **O snapshot que o mesh publica** (`localState`). É ele que decide se o
 *    tile do recém-chegado nasce em placeholder nas outras abas. O mesh de
 *    verdade é construído aqui; quem é dublê é a pilha WebRTC.
 *
 * O que **não** está aqui, e por quê: o valor de `muted`. Ele continua nascendo
 * `false` e nenhuma constraint de áudio muda — a ausência de mudança é afirmada
 * pelos casos de áudio abaixo, que exigem que toda tentativa peça microfone.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_PREFERENCES,
  initialMediaPlan,
  readPreferences,
} from '../src/lib/devices.js';
import { WebRTCMesh } from '../src/lib/webrtcMesh.js';

/** `localStorage` de mentira, só com o que `readPreferences` consome. */
function storageWith(value) {
  return { getItem: () => (value === undefined ? null : JSON.stringify(value)) };
}

/** "Alguma tentativa pede vídeo?" — a pergunta que o LED da webcam responde. */
function pedeVideo(plan) {
  return plan.attempts.some((attempt) => attempt.video !== false);
}

// ------------------------------------ a cadeia de constraints da entrada

test('sem preferência salva: nenhuma tentativa da entrada pede vídeo', () => {
  // O caminho de 100% de quem abre um link pela primeira vez.
  const prefs = readPreferences(storageWith(undefined));
  const plan = initialMediaPlan(prefs, { audioProcessing: null });

  assert.equal(plan.wantsVideo, false);
  assert.equal(pedeVideo(plan), false, 'o LED da webcam não pode acender na entrada');
});

test('com a preferência de entrar ligado: a primeira tentativa pede vídeo', () => {
  const prefs = readPreferences(storageWith({ startCameraOff: false }));
  const plan = initialMediaPlan(prefs, { audioProcessing: null });

  assert.equal(plan.wantsVideo, true);
  assert.equal(plan.attempts[0].video, true);
});

test('o valor inicial de `cameraOff` acompanha a preferência nos dois estados', () => {
  // É este valor que o `Room` usa para inicializar o estado da UI, e é ele que
  // decide o rótulo do botão e o placeholder do próprio tile.
  assert.equal(initialMediaPlan(readPreferences(storageWith(undefined))).cameraOff, true);
  assert.equal(initialMediaPlan(readPreferences(storageWith({}))).cameraOff, true);
  assert.equal(
    initialMediaPlan(readPreferences(storageWith({ startCameraOff: true }))).cameraOff,
    true,
  );
  assert.equal(
    initialMediaPlan(readPreferences(storageWith({ startCameraOff: false }))).cameraOff,
    false,
  );
});

test('`cameraOff` e `wantsVideo` são sempre o inverso um do outro', () => {
  // Se algum dia deixarem de ser, existe um caminho em que a UI diz "câmera
  // ligada" e nenhuma tentativa pediu vídeo (ou o contrário).
  for (const prefs of [{}, { startCameraOff: true }, { startCameraOff: false }]) {
    const plan = initialMediaPlan({ ...DEFAULT_PREFERENCES, ...prefs });
    assert.equal(plan.cameraOff, !plan.wantsVideo);
    assert.equal(pedeVideo(plan), plan.wantsVideo);
  }
});

test('entrar desligado não repete a mesma requisição duas vezes', () => {
  // Com `video: false`, a primeira e a segunda tentativa da cadeia antiga
  // colapsavam na MESMA requisição. Um `getUserMedia` repetido numa falha é
  // meio segundo de espera que ninguém entende.
  const plan = initialMediaPlan({ ...DEFAULT_PREFERENCES, audioInputId: 'mic-1' });
  assert.equal(plan.attempts.length, 2);
  assert.notDeepEqual(plan.attempts[0], plan.attempts[1]);
});

test('a última tentativa ignora a preferência de microfone, nos dois ramos', () => {
  // Uma preferência obsoleta (headset que ficou em outra máquina) não pode fazer
  // a pessoa entrar sem áudio nenhum.
  for (const startCameraOff of [true, false]) {
    const plan = initialMediaPlan({
      ...DEFAULT_PREFERENCES,
      startCameraOff,
      videoInputId: 'cam-1',
      audioInputId: 'mic-que-sumiu',
    });
    assert.deepEqual(plan.attempts[plan.attempts.length - 1], { video: false, audio: true });
  }
});

test('o microfone é pedido em toda tentativa — a preferência é só sobre a câmera', () => {
  for (const startCameraOff of [true, false]) {
    const plan = initialMediaPlan({ ...DEFAULT_PREFERENCES, startCameraOff }, {
      audioProcessing: { noiseSuppression: true },
    });
    for (const attempt of plan.attempts) {
      assert.notEqual(attempt.audio, false);
    }
  }
});

test('a supressão de ruído é injetada, e só nas tentativas com preferência', () => {
  // `audioProcessing` vem de quem chama porque a preferência de supressão mora
  // em outra chave de storage — é isso que mantém `devices.js` puro.
  const plan = initialMediaPlan(
    { ...DEFAULT_PREFERENCES, startCameraOff: false },
    { audioProcessing: { noiseSuppression: true } },
  );
  assert.deepEqual(plan.attempts[0].audio, { noiseSuppression: true });
  assert.deepEqual(plan.attempts[1].audio, { noiseSuppression: true });
  assert.equal(plan.attempts[2].audio, true, 'a rede de segurança não leva nada junto');
});

// ------------------------- o snapshot que o recém-chegado publica no mesh

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
}

class FakeMediaStream {
  constructor(tracks = []) {
    this.tracks = [...tracks];
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

class FakePeerConnection {
  constructor() {
    this.connectionState = 'new';
    this.signalingState = 'stable';
    this.transceivers = [];
  }
  addTransceiver(kind, { direction } = {}) {
    const t = { mid: null, kind, direction, sender: { replaceTrack: async () => {} } };
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
  async setLocalDescription() {}
  close() {}
}

const fakeTrack = (kind) => ({ kind, id: `${kind}-1`, stop() {}, addEventListener() {} });

/** Um mesh com o stream que a entrada de verdade produziria. */
async function meshEntrando({ comCamera }) {
  globalThis.RTCPeerConnection = FakePeerConnection;
  globalThis.MediaStream = FakeMediaStream;

  const tracks = [fakeTrack('audio'), ...(comCamera ? [fakeTrack('video')] : [])];
  const mesh = new WebRTCMesh({
    signaling: { sendSignal: () => {} },
    iceServers: [],
    localStream: new FakeMediaStream(tracks),
    getSelfId: () => 'eu',
    getRoomKey: () => null,
    getIceServers: async () => [],
  });
  await mesh.addPeer('quem-ja-estava');
  return { mesh, rec: mesh.peers.get('quem-ja-estava') };
}

test('entrando sem track de câmera, o snapshot inicial sai com cameraOff: true', async () => {
  // É este booleano que faz o tile do recém-chegado nascer em placeholder nas
  // outras abas, em vez de um retângulo preto.
  const { mesh } = await meshEntrando({ comCamera: false });
  assert.equal(mesh.localState.cameraOff, true);
  assert.equal(mesh.localState.screenOn, false);
  assert.equal(mesh.localState.micOff, false, 'o microfone não é assunto desta entrega');
});

test('entrando com track de câmera, o mesmo snapshot sai com cameraOff: false', async () => {
  const { mesh } = await meshEntrando({ comCamera: true });
  assert.equal(mesh.localState.cameraOff, false);
});

test('o `state` enviado quando o canal abre carrega o cameraOff: true da entrada', async () => {
  // A primeira mensagem que o outro lado recebe é a que decide o que ele
  // desenha. Se ela saísse sem o campo, `!!undefined` seria `false` lá.
  const { mesh, rec } = await meshEntrando({ comCamera: false });
  mesh.localState.displayName = 'Recém-chegado';

  rec.channel.onopen();

  const state = rec.channel.sent.find((m) => m.type === 'state');
  assert.ok(state, 'o canal ao abrir precisa anunciar o estado');
  assert.equal(state.cameraOff, true);
  assert.equal(state.displayName, 'Recém-chegado');
});

test('nenhum sender de câmera nasce com track quando se entra desligado', async () => {
  // O canal de câmera **existe** (os quatro transceivers são incondicionais, e a
  // ordem das m-lines é o contrato de classificação do outro lado) — o que não
  // existe é o track dentro dele. Criar o transceiver condicionalmente quebraria
  // a ordem e faria "Ativar câmera" precisar de renegociação.
  const { mesh, rec } = await meshEntrando({ comCamera: false });
  assert.equal(rec.pc.getTransceivers().length, 4, 'mic, câmera, tela e música');
  assert.equal(mesh.localCameraTrack, null);
});
