import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createLevelSmoother,
  measure,
  normalizeLevel,
  rmsFromTimeDomain,
  toDbfs,
  SPEAKING_DBFS,
} from '../src/lib/level.js';

/** Buffer de dominio do tempo: 128 e o silencio. */
function tone(amplitude, length = 512) {
  const buf = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    buf[i] = Math.round(128 + Math.sin((i / length) * Math.PI * 8) * 127 * amplitude);
  }
  return buf;
}

test('silencio absoluto tem RMS zero e nivel zero', () => {
  const buf = new Uint8Array(512).fill(128);
  assert.equal(rmsFromTimeDomain(buf), 0);
  assert.equal(toDbfs(0), -Infinity);
  assert.equal(measure(buf).level, 0);
});

test('o nivel cresce junto com a amplitude — nao e binario', () => {
  const baixo = measure(tone(0.05)).level;
  const medio = measure(tone(0.3)).level;
  const alto = measure(tone(0.9)).level;
  assert.ok(baixo < medio, `${baixo} < ${medio}`);
  assert.ok(medio < alto, `${medio} < ${alto}`);
  assert.ok(alto <= 1);
});

test('normalizeLevel satura nas pontas', () => {
  assert.equal(normalizeLevel(-200), 0);
  assert.equal(normalizeLevel(0), 1);
  assert.equal(normalizeLevel(-Infinity), 0);
});

test('o hangover segura o estado "falando" entre silabas', () => {
  const smoother = createLevelSmoother({ hangoverMs: 500 });
  const fala = { dbfs: SPEAKING_DBFS + 10, level: 0.8 };
  const silencio = { dbfs: -80, level: 0 };

  assert.equal(smoother.push(fala, 1000).speaking, true);
  // pausa curta entre silabas: continua "falando"
  assert.equal(smoother.push(silencio, 1300).speaking, true);
  // pausa longa: cai
  assert.equal(smoother.push(silencio, 1700).speaking, false);
});

test('o ataque e mais rapido que a liberacao', () => {
  const subida = createLevelSmoother();
  const primeiro = subida.push({ dbfs: -20, level: 1 }, 0).level;

  const descida = createLevelSmoother();
  descida.push({ dbfs: -20, level: 1 }, 0);
  descida.push({ dbfs: -20, level: 1 }, 16);
  const antes = descida.state.level;
  const depois = descida.push({ dbfs: -80, level: 0 }, 32).level;

  assert.ok(primeiro > 0.4, 'ataque deve alcancar boa parte do alvo em um quadro');
  assert.ok(depois > antes * 0.7, 'liberacao deve ser suave, sem corte seco');
});

test('o nivel decai ate zero depois de varios quadros em silencio', () => {
  const smoother = createLevelSmoother();
  smoother.push({ dbfs: -20, level: 1 }, 0);
  for (let i = 1; i <= 120; i += 1) smoother.push({ dbfs: -90, level: 0 }, i * 16);
  assert.equal(smoother.state.level, 0);
  assert.equal(smoother.state.speaking, false);
});
