/**
 * `lib/peerConnectionStatus.js` — a tradução de `connectionState` para o tile.
 *
 * Módulo puro, então o teste é o contrato inteiro: os seis estados que o
 * navegador produz, o estado ausente (o intervalo entre o participante entrar no
 * mapa e a primeira transição chegar) e um valor desconhecido.
 *
 * A checagem que mais importa aqui não é nenhum rótulo em particular: é que
 * `connected` devolva `null`. Um indicador aceso no caminho feliz vira ruído,
 * ninguém o lê, e o silêncio que esta entrega existe para acabar volta em outra
 * forma.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { describeConnection } from '../src/lib/peerConnectionStatus.js';

/** Todos os valores possíveis de `RTCPeerConnection.connectionState`. */
const ALL_STATES = ['new', 'connecting', 'connected', 'disconnected', 'failed', 'closed'];

test('connected é o único estado sem indicador', () => {
  assert.equal(describeConnection('connected'), null);
  for (const state of ALL_STATES) {
    if (state === 'connected') continue;
    assert.ok(describeConnection(state), `${state} deveria produzir indicador`);
  }
});

test('failed e closed são os estados graves; os transitórios são avisos', () => {
  assert.deepEqual(describeConnection('failed'), {
    level: 'bad',
    label: 'Sem conexão',
    live: 'assertive',
  });
  assert.deepEqual(describeConnection('closed'), {
    level: 'bad',
    label: 'Desconectado',
    live: 'polite',
  });
  assert.equal(describeConnection('disconnected').level, 'warn');
  assert.equal(describeConnection('disconnected').label, 'Instável');
});

test('new e connecting dizem a mesma coisa: "Conectando…"', () => {
  assert.deepEqual(describeConnection('new'), {
    level: 'warn',
    label: 'Conectando…',
    live: 'polite',
  });
  assert.deepEqual(describeConnection('connecting'), describeConnection('new'));
});

test('estado ausente é tratado como new, não como "sem informação"', () => {
  // O registro do participante entra no mapa **antes** de `mesh.addPeer`; até a
  // primeira transição chegar, `connectionState` é `undefined`. Devolver `null`
  // aqui faria o tile mentir exatamente na janela em que ele já mentia.
  assert.deepEqual(describeConnection(undefined), describeConnection('new'));
  assert.deepEqual(describeConnection(null), describeConnection('new'));
});

test('valor desconhecido não vira indicador ausente', () => {
  assert.deepEqual(describeConnection('quantum-superposition'), describeConnection('new'));
  assert.deepEqual(describeConnection(''), describeConnection('new'));
});

test('nenhum rótulo vaza o connectionState cru', () => {
  // "disconnected" e "failed" não são palavras para o usuário final; o objetivo
  // declarado é uma frase acionável, não um despejo de enum.
  for (const state of [...ALL_STATES, undefined]) {
    const described = describeConnection(state);
    if (!described) continue;
    const label = described.label.toLowerCase();
    for (const raw of ALL_STATES) {
      assert.ok(!label.includes(raw), `o rótulo de ${state} contém o estado cru "${raw}"`);
    }
    assert.ok(['warn', 'bad'].includes(described.level));
    assert.ok(['polite', 'assertive'].includes(described.live));
  }
});
