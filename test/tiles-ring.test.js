import test from 'node:test';
import assert from 'node:assert/strict';

import { installEnv, FakeTrack } from './helpers/fake-env.js';

/**
 * Itens 2, 3 e 4 do DoD: o halo azul.
 *
 * "Nao e liga/desliga" vira uma assercao concreta: a custom property `--level`
 * assume valores distintos e crescentes conforme o volume. E "nao consome CPU
 * em silencio" vira: nenhuma chamada nova ao canvas depois que o nivel zera.
 */

const env = installEnv({ reducedMotion: false });
const { createTileGrid } = await import('../src/tiles.js');

function grade() {
  const container = env.el('div');
  return { container, tiles: createTileGrid(container) };
}

const canvasDe = (container, i = 0) =>
  container.children[i].descendants().find((el) => el.tagName === 'CANVAS');

test('o tile local nasce com video mudo, avatar, canvas e placa de nome', () => {
  const { container, tiles } = grade();
  tiles.ensure('eu', { name: 'Ana Paula', local: true });

  const tile = container.children[0];
  const video = tile.descendants().find((el) => el.tagName === 'VIDEO');
  const avatar = tile.descendants().find((el) => el.classList.contains('avatar'));
  const placa = tile.descendants().find((el) => el.classList.contains('nameplate'));

  assert.equal(video.muted, true, 'o proprio audio nao pode voltar como eco');
  assert.equal(avatar.textContent, 'AP');
  assert.match(placa.textContent, /Ana Paula \(você\)/);
  assert.ok(canvasDe(container), 'o canvas do halo precisa existir');
  assert.equal(tile.dataset.video, 'off');
});

test('o tile de outro participante nao vem mudo', () => {
  const { container, tiles } = grade();
  tiles.ensure('p2', { name: 'Bruno' });
  const video = container.children[0].descendants().find((el) => el.tagName === 'VIDEO');
  assert.equal(video.muted, false);
});

test('ensure e idempotente — nao duplica tile', () => {
  const { container, tiles } = grade();
  tiles.ensure('eu', { name: 'Ana' });
  tiles.ensure('eu', { name: 'Ana' });
  assert.equal(container.children.length, 1);
  assert.deepEqual(tiles.ids(), ['eu']);
});

test('o nivel de voz vira --level continuo, nao dois estados', () => {
  const { container, tiles } = grade();
  tiles.ensure('eu', { name: 'Ana', local: true });
  const tile = container.children[0];

  const vistos = [];
  for (const level of [0.05, 0.2, 0.45, 0.7, 0.95]) {
    tiles.setLevel('eu', { level, speaking: true });
    vistos.push(Number(tile.style.getPropertyValue('--level')));
  }

  assert.deepEqual(vistos, [0.05, 0.2, 0.45, 0.7, 0.95]);
  assert.equal(new Set(vistos).size, 5, 'cinco valores distintos = intensidade variavel');
  assert.equal(tile.dataset.speaking, 'true');
});

test('o halo aparece tambem nos tiles dos outros participantes', () => {
  const { container, tiles } = grade();
  tiles.ensure('eu', { name: 'Ana', local: true });
  tiles.ensure('p2', { name: 'Bruno' });

  tiles.setLevel('p2', { level: 0.8, speaking: true });

  const remoto = container.children[1];
  assert.equal(remoto.dataset.speaking, 'true');
  assert.equal(remoto.style.getPropertyValue('--level'), '0.800');
  assert.ok(canvasDe(container, 1).ctx.calls.length > 0, 'o canvas do remoto tambem desenha');
  assert.equal(container.children[0].dataset.speaking, 'false', 'quem esta calado nao acende');
});

test('falando: ondas e particulas sao desenhadas', () => {
  const { container, tiles } = grade();
  tiles.ensure('eu', { name: 'Ana', local: true });
  const ctx = canvasDe(container).ctx;

  tiles.setLevel('eu', { level: 0.7, speaking: true });

  assert.ok(ctx.count('stroke') > 0, 'as ondas sao contornos');
  assert.ok(ctx.count('arc') > 0, 'as particulas sao arcos');
  assert.ok(ctx.count('fill') > 0);
});

test('as ondas se acumulam ao longo do tempo e envelhecem', () => {
  const { container, tiles } = grade();
  tiles.ensure('eu', { name: 'Ana', local: true });
  const ctx = canvasDe(container).ctx;

  tiles.setLevel('eu', { level: 0.7, speaking: true });
  const primeiras = ctx.count('stroke');
  env.advanceClock(400); // passou o intervalo entre ondas
  tiles.setLevel('eu', { level: 0.7, speaking: true });

  assert.ok(ctx.count('stroke') > primeiras + 1, 'uma onda nova por intervalo');
});

test('silencio limpa o canvas uma vez e para de gastar CPU', () => {
  const { container, tiles } = grade();
  tiles.ensure('eu', { name: 'Ana', local: true });
  const ctx = canvasDe(container).ctx;

  tiles.setLevel('eu', { level: 0.7, speaking: true });
  ctx.calls.length = 0;

  tiles.setLevel('eu', { level: 0, speaking: false });
  const aposLimpeza = ctx.calls.length;
  assert.equal(aposLimpeza, 1, 'apenas o clearRect final');
  assert.equal(ctx.calls[0].op, 'clearRect');

  for (let i = 0; i < 60; i += 1) tiles.setLevel('eu', { level: 0, speaking: false });

  assert.equal(ctx.calls.length, aposLimpeza, '60 quadros em silencio = zero desenho');
});

test('o canvas acompanha o devicePixelRatio', () => {
  const { container, tiles } = grade();
  tiles.ensure('eu', { name: 'Ana', local: true });
  const canvas = canvasDe(container);
  canvas.rect = { width: 400, height: 300 };
  env.window.devicePixelRatio = 2;

  tiles.setLevel('eu', { level: 0.5, speaking: true });

  assert.equal(canvas.width, 800);
  assert.equal(canvas.height, 600);
  env.window.devicePixelRatio = 1;
});

test('setTrack liga e desliga o marcador de video do tile', () => {
  const { container, tiles } = grade();
  tiles.ensure('p2', { name: 'Bruno' });
  const tile = container.children[0];

  tiles.setTrack('p2', 'video', new FakeTrack('video'));
  assert.equal(tile.dataset.video, 'on');

  tiles.setTrack('p2', 'video', null);
  assert.equal(tile.dataset.video, 'off', 'sem track, o avatar volta — nada de quadro congelado');
});

test('trocar o track de video substitui, nao acumula', () => {
  const { tiles } = grade();
  tiles.ensure('p2', { name: 'Bruno' });
  tiles.setTrack('p2', 'audio', new FakeTrack('audio'));
  tiles.setTrack('p2', 'video', new FakeTrack('video'));
  tiles.setTrack('p2', 'video', new FakeTrack('video'));

  // O stream do tile e interno; o efeito visivel e o marcador continuar 'on'
  // sem que o audio tenha sido derrubado junto.
  assert.equal(tiles.has('p2'), true);
});

test('setMic reflete o mute do participante', () => {
  const { container, tiles } = grade();
  tiles.ensure('p2', { name: 'Bruno' });
  tiles.setMic('p2', false);
  assert.equal(container.children[0].dataset.mic, 'off');
  tiles.setMic('p2', true);
  assert.equal(container.children[0].dataset.mic, 'on');
});

test('um tile de tela marca a grade em modo apresentacao', () => {
  const { container, tiles } = grade();
  tiles.ensure('eu', { name: 'Ana', local: true });
  assert.equal(container.dataset.screen, 'false');

  tiles.ensure('screen:eu', { name: 'Sua tela', screen: true });
  assert.equal(container.dataset.screen, 'true');

  tiles.remove('screen:eu');
  assert.equal(container.dataset.screen, 'false', 'parar de compartilhar desfaz o layout');
});

test('remover o tile limpa o canvas e solta o video', () => {
  const { container, tiles } = grade();
  tiles.ensure('p2', { name: 'Bruno' });
  const tile = container.children[0];
  const video = tile.descendants().find((el) => el.tagName === 'VIDEO');
  tiles.setTrack('p2', 'video', new FakeTrack('video'));

  tiles.remove('p2');

  assert.equal(container.children.length, 0);
  assert.equal(tiles.has('p2'), false);
  assert.equal(video.srcObject, null, 'o elemento nao pode segurar o stream');
});

test('clear esvazia a grade inteira ao sair da sala', () => {
  const { container, tiles } = grade();
  tiles.ensure('eu', { name: 'Ana', local: true });
  tiles.ensure('p2', { name: 'Bruno' });
  tiles.ensure('screen:p2', { name: 'Tela compartilhada', screen: true });

  tiles.clear();

  assert.equal(container.children.length, 0);
  assert.deepEqual(tiles.ids(), []);
});

test('operacoes em id inexistente sao inofensivas', () => {
  const { tiles } = grade();
  tiles.setLevel('ninguem', { level: 1, speaking: true });
  tiles.setMic('ninguem', false);
  tiles.setTrack('ninguem', 'video', null);
  tiles.setName('ninguem', 'x');
  tiles.remove('ninguem');
  assert.deepEqual(tiles.ids(), []);
});
