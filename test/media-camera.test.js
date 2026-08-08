import test from 'node:test';
import assert from 'node:assert/strict';

import { installEnv } from './helpers/fake-env.js';

/**
 * Item 13/14/15 do DoD: o "kill real" da camera.
 *
 * O bug original era `track.enabled = false`: a imagem fica preta, mas o
 * dispositivo continua aberto e o LED aceso. O LED em si so pode ser conferido
 * por um humano com um notebook na mao — mas a CAUSA e verificavel aqui:
 * `stop()` foi chamado, o track ficou 'ended' e nenhum track sobreviveu.
 *
 * Se estes testes passam e mesmo assim o LED continua aceso, o problema esta
 * fora deste modulo (outro getUserMedia em algum lugar), e isso e informacao.
 */

const env = installEnv();
const { createLocalMedia, SUPPORTS_SCREEN_SHARE } = await import('../src/media.js');

const videoCalls = () => env.mediaDevices.userMediaCalls.filter((c) => c.video);

test.beforeEach(() => {
  env.mediaDevices.userMediaCalls.length = 0;
  env.mediaDevices.displayMediaCalls.length = 0;
  env.mediaDevices.tracks.length = 0;
  env.mediaDevices.failures.length = 0;
  env.mediaDevices.rejectExactDeviceId = false;
});

test('desligar a camera chama track.stop() — o dispositivo fecha, nao fica preto', async () => {
  const media = createLocalMedia();
  await media.enableCamera();

  const track = media.snapshot().camTrack;
  assert.ok(track, 'a camera deveria ter aberto');
  assert.equal(track.readyState, 'live');

  media.disableCamera();

  assert.equal(track.stopCount, 1, 'stop() precisa ser chamado exatamente uma vez');
  assert.equal(track.readyState, 'ended');
  assert.equal(media.snapshot().camOn, false);
  assert.equal(media.snapshot().camTrack, null, 'o track nao pode continuar pendurado no estado');
});

test('desligar NAO usa enabled=false — o track nao fica vivo e mudo', async () => {
  const media = createLocalMedia();
  await media.enableCamera();
  const track = media.snapshot().camTrack;

  media.disableCamera();

  // Se alguem "otimizar" este modulo trocando stop() por enabled=false, e aqui
  // que a regressao aparece.
  assert.notEqual(track.readyState, 'live', 'track vivo depois do desligamento = LED aceso');
  assert.ok(track.stopCount > 0);
});

test('religar a camera reabre exatamente o mesmo deviceId', async () => {
  const media = createLocalMedia();
  await media.enableCamera();
  media.disableCamera();
  await media.enableCamera();

  const [primeira, segunda] = videoCalls();
  assert.equal(primeira.video.deviceId, undefined, 'a primeira abertura nao tem preferencia');
  assert.deepEqual(
    segunda.video.deviceId,
    { exact: 'cam-1' },
    'ao religar, o mesmo hardware precisa ser pedido de volta',
  );
  assert.equal(media.snapshot().camOn, true);
});

test('cinco ciclos on/off nao deixam nenhum track orfao', async () => {
  const media = createLocalMedia();

  for (let i = 1; i <= 5; i += 1) {
    await media.toggleCamera();
    assert.equal(media.snapshot().camOn, true, `ciclo ${i}: deveria estar ligada`);
    await media.toggleCamera();
    assert.equal(media.snapshot().camOn, false, `ciclo ${i}: deveria estar desligada`);
  }

  const video = env.allTracks.filter((t) => t.kind === 'video');
  assert.equal(video.length, 5, 'cinco aberturas, cinco tracks');
  assert.equal(
    video.filter((t) => t.readyState === 'live').length,
    0,
    'nenhum track de video pode sobreviver aos cinco ciclos',
  );
  for (const track of video) {
    assert.equal(track.stopCount, 1, 'cada track parado uma unica vez, sem stop duplicado');
  }
});

test('duplo clique durante a abertura nao abre duas cameras', async () => {
  const media = createLocalMedia();
  // Duas chamadas concorrentes: a segunda encontra `busy` e desiste.
  const [a, b] = await Promise.all([media.enableCamera(), media.enableCamera()]);

  assert.equal(videoCalls().length, 1, 'so um getUserMedia deveria ter saido');
  assert.ok(a.camOn || b.camOn);
  assert.equal(env.allTracks.filter((t) => t.kind === 'video' && t.readyState === 'live').length, 1);
});

test('desligar duas vezes seguidas e inofensivo', async () => {
  const media = createLocalMedia();
  await media.enableCamera();
  const track = media.snapshot().camTrack;

  media.disableCamera();
  media.disableCamera();

  assert.equal(track.stopCount, 1);
  assert.equal(media.snapshot().camOn, false);
});

test('camera arrancada (evento ended) se reflete no estado', async () => {
  const media = createLocalMedia();
  await media.enableCamera();
  const track = media.snapshot().camTrack;

  let notificado = null;
  media.subscribe((snap) => {
    notificado = snap;
  });

  track.fire('ended'); // USB removido, ou o SO tomou a camera

  assert.equal(media.snapshot().camOn, false);
  assert.equal(media.snapshot().camTrack, null);
  assert.equal(notificado?.camOn, false, 'a UI precisa ser avisada');
});

test('deviceId que sumiu cai para a camera padrao em vez de falhar', async () => {
  const media = createLocalMedia();
  await media.enableCamera();
  media.disableCamera();

  // A camera trocou de porta USB: o deviceId guardado nao existe mais.
  env.mediaDevices.rejectExactDeviceId = true;
  env.mediaDevices.userMediaCalls.length = 0;

  const snap = await media.enableCamera();

  assert.equal(snap.camOn, true, 'deveria ter reaberto pela camera padrao');
  const calls = videoCalls();
  assert.equal(calls.length, 2, 'uma tentativa com deviceId exato, uma sem');
  assert.deepEqual(calls[0].video.deviceId, { exact: 'cam-1' });
  assert.equal(calls[1].video.deviceId, undefined);
});

test('a trava de concorrencia continua valendo durante a retentativa de fallback', async () => {
  const media = createLocalMedia();
  await media.enableCamera();
  media.disableCamera();
  env.mediaDevices.userMediaCalls.length = 0;

  // Cenario: o deviceId guardado sumiu, entao a abertura vira duas tentativas.
  // Se a trava for solta entre elas, um clique nesse instante abre uma SEGUNDA
  // camera — e uma delas fica orfa, com o LED aceso e ninguem a apontando.
  env.mediaDevices.rejectExactDeviceId = true;
  env.mediaDevices.hold();

  const primeira = media.enableCamera();
  await new Promise((resolve) => setImmediate(resolve)); // retentativa no ar
  const segunda = media.enableCamera(); // o clique apressado

  try {
    // Se a trava estiver valendo, este clique nem chega ao dispositivo: sao duas
    // chamadas (a exata, que falha, e o fallback). Se virarem tres, escapou.
    assert.equal(videoCalls().length, 2, 'exatamente duas tentativas: a exata e o fallback');
  } finally {
    env.mediaDevices.release(); // solta o portao mesmo se a assercao falhar
    await Promise.all([primeira, segunda]);
  }

  assert.equal(
    env.allTracks.filter((tk) => tk.kind === 'video' && tk.readyState === 'live').length,
    1,
    'uma camera aberta, nao duas',
  );

  media.disableCamera();
});

test('permissao negada propaga o erro sem deixar estado sujo', async () => {
  const media = createLocalMedia();
  env.mediaDevices.failNext('NotAllowedError');

  await assert.rejects(() => media.enableCamera(), { name: 'NotAllowedError' });

  const snap = media.snapshot();
  assert.equal(snap.camOn, false);
  assert.equal(snap.busy, false, 'o guarda de concorrencia precisa ser liberado no erro');
  // E o proximo clique tem que funcionar.
  await media.enableCamera();
  assert.equal(media.snapshot().camOn, true);
});

test('mutar o microfone NAO fecha o dispositivo — a assimetria e proposital', async () => {
  const media = createLocalMedia();
  await media.startMic();
  const mic = media.snapshot().micTrack;

  media.toggleMic();

  assert.equal(mic.enabled, false, 'mute precisa ser instantaneo');
  assert.equal(mic.stopCount, 0, 'o microfone nao pode ser fechado no mute: religar demoraria');
  assert.equal(media.snapshot().micOn, false);

  media.toggleMic();
  assert.equal(mic.enabled, true);
  assert.equal(media.snapshot().micOn, true);
});

test('startMic e idempotente', async () => {
  const media = createLocalMedia();
  const primeiro = await media.startMic();
  const segundo = await media.startMic();

  assert.equal(primeiro, segundo);
  assert.equal(env.mediaDevices.userMediaCalls.filter((c) => c.audio).length, 1);
});

test('stopAll encerra microfone, camera e tela — nada sobrevive a saida', async () => {
  const media = createLocalMedia();
  await media.startMic();
  await media.enableCamera();
  await media.startScreen();

  media.stopAll();

  assert.equal(env.liveTracks.length, 0, 'sair da sala nao pode deixar nenhum dispositivo aberto');
  const snap = media.snapshot();
  assert.equal(snap.camOn, false);
  assert.equal(snap.sharing, false);
});

test('este ambiente enxerga suporte a compartilhamento de tela', () => {
  assert.equal(SUPPORTS_SCREEN_SHARE, true);
});
