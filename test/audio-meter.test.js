import test from 'node:test';
import assert from 'node:assert/strict';

import { installEnv, FakeTrack, FakeMediaStream } from './helpers/fake-env.js';

/**
 * Item 5 do DoD: ~60 fps quando alguem fala, CPU ociosa quando ninguem fala.
 *
 * "CPU zero em silencio" tem uma traducao objetiva: NENHUM requestAnimationFrame
 * agendado. E isso que estes testes medem — `env.pendingFrames`.
 */

const env = installEnv();
const { createAudioMeter } = await import('../src/audio-meter.js');

function streamComVoz(amplitude = 0) {
  const stream = new FakeMediaStream([new FakeTrack('audio')]);
  stream.amplitude = amplitude;
  return stream;
}

function coletor() {
  const updates = [];
  return { updates, onUpdate: (results) => updates.push(new Map(results)) };
}

test('em silencio o medidor fica ocioso: nenhum quadro agendado', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { onUpdate, updates } = coletor();
  const meter = createAudioMeter({ onUpdate });

  meter.add('eu', streamComVoz(0));

  assert.equal(env.pendingFrames, 0, 'silencio nao pode agendar rAF');
  assert.equal(meter.mode, 'idle');

  t.mock.timers.tick(250);
  t.mock.timers.tick(250);
  t.mock.timers.tick(250);

  assert.equal(env.pendingFrames, 0, 'continua sem rAF depois de varias sondagens');
  assert.equal(updates.length, 3, 'a sondagem ociosa roda ~4x/s, nao 60x/s');
  meter.destroy();
});

test('voz acorda o medidor e ele passa a rodar em requestAnimationFrame', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { onUpdate } = coletor();
  const meter = createAudioMeter({ onUpdate });
  const stream = streamComVoz(0);
  meter.add('eu', stream);

  stream.amplitude = 0.8; // alguem falou
  t.mock.timers.tick(250);

  assert.equal(meter.mode, 'active');
  assert.equal(env.pendingFrames, 1, 'o loop de 60 fps precisa estar agendado');

  env.pumpFrames(5);
  assert.equal(env.pendingFrames, 1, 'e precisa se reagendar enquanto houver voz');
  meter.destroy();
});

test('o silencio devolve o medidor ao modo ocioso', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const meter = createAudioMeter({ onUpdate: () => {} });
  const stream = streamComVoz(0.8);
  meter.add('eu', stream);
  t.mock.timers.tick(250);
  assert.equal(meter.mode, 'active');

  stream.amplitude = 0;
  env.advanceClock(800); // passou do hangover de 500 ms
  env.pumpFrames(80); // o nivel decai pela constante de release

  assert.equal(env.pendingFrames, 0, 'sem voz, nenhum quadro pode continuar agendado');
  assert.equal(meter.mode, 'idle');
  meter.destroy();
});

test('o nivel reportado varia continuamente — nao e liga/desliga', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { onUpdate, updates } = coletor();
  const meter = createAudioMeter({ onUpdate });
  const stream = streamComVoz(0.05);
  meter.add('eu', stream);
  t.mock.timers.tick(250);

  const niveis = [];
  for (const amplitude of [0.1, 0.2, 0.35, 0.5, 0.7, 0.9]) {
    stream.amplitude = amplitude;
    env.pumpFrames(6);
    niveis.push(updates[updates.length - 1].get('eu').level);
  }

  for (let i = 1; i < niveis.length; i += 1) {
    assert.ok(niveis[i] > niveis[i - 1], `nivel deveria subir: ${niveis[i - 1]} -> ${niveis[i]}`);
  }
  assert.ok(new Set(niveis).size === niveis.length, 'valores distintos, nao dois estados');
  assert.ok(niveis[niveis.length - 1] <= 1);
  meter.destroy();
});

test('varios participantes sao medidos de forma independente', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { onUpdate, updates } = coletor();
  const meter = createAudioMeter({ onUpdate });
  const eu = streamComVoz(0);
  const outro = streamComVoz(0.9);
  meter.add('eu', eu);
  meter.add('outro', outro);

  t.mock.timers.tick(250);
  env.pumpFrames(10);

  const ultimo = updates[updates.length - 1];
  assert.equal(meter.size, 2);
  assert.equal(ultimo.get('eu').speaking, false);
  assert.equal(ultimo.get('outro').speaking, true, 'o halo do remoto tambem precisa acender');
  assert.ok(ultimo.get('outro').level > ultimo.get('eu').level);
  meter.destroy();
});

test('adicionar o mesmo id duas vezes nao duplica o analisador', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const meter = createAudioMeter({ onUpdate: () => {} });
  meter.add('eu', streamComVoz(0));
  meter.add('eu', streamComVoz(0));
  assert.equal(meter.size, 1);
  meter.destroy();
});

test('stream sem faixa de audio e ignorado', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const meter = createAudioMeter({ onUpdate: () => {} });
  meter.add('so-video', new FakeMediaStream([new FakeTrack('video')]));
  assert.equal(meter.size, 0);
  assert.equal(env.pendingFrames, 0);
  meter.destroy();
});

test('quem sai da sala para de ser medido e o ultimo a sair desliga tudo', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const meter = createAudioMeter({ onUpdate: () => {} });
  meter.add('a', streamComVoz(0.8));
  meter.add('b', streamComVoz(0.8));
  t.mock.timers.tick(250);

  meter.remove('a');
  assert.equal(meter.size, 1);
  assert.notEqual(meter.mode, 'stopped');

  meter.remove('b');
  assert.equal(meter.size, 0);
  assert.equal(meter.mode, 'stopped');
  assert.equal(env.pendingFrames, 0, 'sala vazia nao pode deixar loop rodando');
  meter.destroy();
});

test('destroy desconecta as fontes e fecha o AudioContext', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const meter = createAudioMeter({ onUpdate: () => {} });
  meter.add('a', streamComVoz(0.5));
  const ctx = env.audioContexts[env.audioContexts.length - 1];

  meter.destroy();

  assert.equal(meter.size, 0);
  assert.equal(env.pendingFrames, 0);
  assert.ok(
    ctx.sources.every((s) => s.disconnected),
    'toda fonte precisa ser desconectada',
  );
  assert.equal(ctx.closed, true);
});
