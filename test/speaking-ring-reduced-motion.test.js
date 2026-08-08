import test from 'node:test';
import assert from 'node:assert/strict';

import { installEnv } from './helpers/fake-env.js';

/**
 * Item 4 do DoD: com `prefers-reduced-motion: reduce` o halo continua existindo
 * e continua reagindo ao volume — o que sai e o MOVIMENTO (ondas e particulas).
 *
 * Arquivo separado porque a preferencia e lida uma unica vez, no import do
 * modulo. `node --test` da um processo por arquivo, entao aqui o mundo inteiro
 * e "movimento reduzido".
 */

const env = installEnv({ reducedMotion: true });
const { createSpeakingRing, REDUCED_MOTION } = await import('../src/speaking-ring.js');

function halo() {
  const canvas = env.el('canvas');
  return { canvas, ring: createSpeakingRing(canvas) };
}

test('a preferencia do sistema e consultada e respeitada', () => {
  assert.equal(REDUCED_MOTION, true);
  assert.ok(
    env.matchMediaCalls.some((q) => q.includes('prefers-reduced-motion')),
    'o modulo precisa perguntar ao sistema, nao adivinhar',
  );
});

test('o halo estatico e desenhado: contorno sim, particulas nao', () => {
  const { canvas, ring } = halo();

  ring.render({ level: 0.8, speaking: true });

  const ctx = canvas.ctx;
  assert.ok(ctx.count('stroke') > 0, 'o contorno azul continua indicando quem fala');
  assert.equal(ctx.count('arc'), 0, 'nenhuma particula em movimento');
  assert.equal(ctx.count('fill'), 0);
});

test('mesmo estatico, a intensidade acompanha o volume', () => {
  const { canvas, ring } = halo();

  ring.render({ level: 0.15, speaking: true });
  const fraco = { lineWidth: canvas.ctx.lineWidth, cor: canvas.ctx.strokeStyle };

  ring.render({ level: 0.9, speaking: true });
  const forte = { lineWidth: canvas.ctx.lineWidth, cor: canvas.ctx.strokeStyle };

  assert.ok(forte.lineWidth > fraco.lineWidth, 'o contorno engrossa com o volume');
  assert.notEqual(forte.cor, fraco.cor, 'e a opacidade acompanha — nao e liga/desliga');
});

test('quadros repetidos nao acumulam desenho — um clear por quadro', () => {
  const { canvas, ring } = halo();
  ring.render({ level: 0.5, speaking: true });
  const primeiro = canvas.ctx.calls.length;

  ring.render({ level: 0.5, speaking: true });

  assert.equal(canvas.ctx.calls.length, primeiro * 2, 'custo constante por quadro');
  assert.equal(canvas.ctx.calls[0].op, 'setTransform');
});

test('silencio limpa e para', () => {
  const { canvas, ring } = halo();
  ring.render({ level: 0.5, speaking: true });
  canvas.ctx.calls.length = 0;

  ring.render({ level: 0, speaking: false });
  assert.equal(canvas.ctx.calls.length, 1);

  for (let i = 0; i < 30; i += 1) ring.render({ level: 0, speaking: false });
  assert.equal(canvas.ctx.calls.length, 1, 'silencio nao desenha nada');
});

test('canvas sem tamanho (tile ainda nao no layout) nao quebra', () => {
  const { canvas, ring } = halo();
  canvas.rect = { width: 0, height: 0 };
  assert.doesNotThrow(() => ring.render({ level: 0.9, speaking: true }));
});

test('clear zera o halo', () => {
  const { canvas, ring } = halo();
  ring.render({ level: 0.9, speaking: true });
  canvas.ctx.calls.length = 0;

  ring.clear();

  assert.equal(canvas.ctx.count('clearRect'), 1);
});
