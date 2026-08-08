import test from 'node:test';
import assert from 'node:assert/strict';

import { installEnv } from './helpers/fake-env.js';

/** Itens 6, 7 e 8 do DoD: ciclo de vida do compartilhamento de tela. */

const env = installEnv();
const { createLocalMedia, SUPPORTS_SCREEN_SHARE } = await import('../src/media.js');

test.beforeEach(() => {
  env.mediaDevices.displayMediaCalls.length = 0;
  env.mediaDevices.userMediaCalls.length = 0;
  env.mediaDevices.tracks.length = 0;
  env.mediaDevices.failures.length = 0;
});

test('startScreen captura via getDisplayMedia e marca o estado como compartilhando', async () => {
  const media = createLocalMedia();
  const track = await media.startScreen();

  assert.equal(env.mediaDevices.displayMediaCalls.length, 1);
  assert.ok(env.mediaDevices.displayMediaCalls[0].video, 'precisa pedir video');
  assert.equal(media.snapshot().sharing, true);
  assert.equal(media.snapshot().screenTrack, track);
  assert.equal(track.readyState, 'live');
});

test('a tela e marcada como conteudo de detalhe — nitidez acima de fluidez', async () => {
  const media = createLocalMedia();
  const track = await media.startScreen();
  assert.equal(track.contentHint, 'detail');
});

test('parar pela UI fecha o track e limpa o estado', async () => {
  const media = createLocalMedia();
  const track = await media.startScreen();

  media.stopScreen();

  assert.equal(track.stopCount, 1);
  assert.equal(track.readyState, 'ended');
  assert.equal(media.snapshot().sharing, false);
  assert.equal(media.snapshot().screenTrack, null);
});

test('parar pelo botao nativo do navegador avisa o app e limpa o estado', async () => {
  const media = createLocalMedia();
  let avisos = 0;
  const track = await media.startScreen(() => {
    avisos += 1;
  });

  // O caminho que a maioria das pessoas usa: a barrinha "Parar de compartilhar"
  // do proprio Chrome, que so dispara 'ended' no track.
  track.fire('ended');

  assert.equal(avisos, 1, 'o app precisa saber para restaurar a camera');
  assert.equal(media.snapshot().sharing, false);
  assert.equal(media.snapshot().screenTrack, null);
});

test('o callback nativo nao dispara quando quem parou foi a UI', async () => {
  const media = createLocalMedia();
  let avisos = 0;
  const track = await media.startScreen(() => {
    avisos += 1;
  });

  media.stopScreen();
  // Alguns navegadores ainda emitem 'ended' depois do stop() manual: como o
  // estado ja foi limpo, o callback nao pode rodar de novo (dupla limpeza).
  track.fire('ended');

  assert.equal(avisos, 0);
  assert.equal(media.snapshot().sharing, false);
});

test('compartilhar e parar nao toca na camera — ela volta como estava', async () => {
  const media = createLocalMedia();
  await media.enableCamera();
  const cam = media.snapshot().camTrack;

  await media.startScreen();
  assert.equal(media.snapshot().camTrack, cam, 'a camera segue viva durante o compartilhamento');

  media.stopScreen();

  assert.equal(media.snapshot().camTrack, cam);
  assert.equal(cam.readyState, 'live');
  assert.equal(cam.stopCount, 0);
  assert.equal(media.snapshot().camOn, true);
});

test('compartilhar com a camera desligada mantem o estado "camera off"', async () => {
  const media = createLocalMedia();
  await media.startScreen();
  media.stopScreen();

  assert.equal(media.snapshot().camOn, false, 'nao pode religar a camera sozinho');
  assert.equal(media.snapshot().camTrack, null);
});

test('cancelar o seletor propaga o erro e nao deixa estado de compartilhamento', async () => {
  const media = createLocalMedia();
  env.mediaDevices.failNext('NotAllowedError');

  await assert.rejects(() => media.startScreen(), { name: 'NotAllowedError' });

  assert.equal(media.snapshot().sharing, false);
  assert.equal(media.snapshot().screenTrack, null);
});

test('parar sem estar compartilhando e inofensivo', () => {
  const media = createLocalMedia();
  assert.equal(media.stopScreen().sharing, false);
});

test('navegador sem getDisplayMedia: sem suporte e startScreen recusa', async () => {
  assert.equal(SUPPORTS_SCREEN_SHARE, true, 'controle: com suporte');

  // Reavalia o modulo com um navigator sem getDisplayMedia — e o que um
  // navegador antigo (ou iOS Safari) entrega. O botao fica desabilitado.
  const semTela = { mediaDevices: { getUserMedia: env.mediaDevices.getUserMedia } };
  Object.defineProperty(globalThis, 'navigator', { value: semTela, writable: true, configurable: true });

  const modulo = await import('../src/media.js?sem-display=1');
  assert.equal(modulo.SUPPORTS_SCREEN_SHARE, false);

  const media = modulo.createLocalMedia();
  await assert.rejects(() => media.startScreen(), /sem-suporte/);
});
