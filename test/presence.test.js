import test from 'node:test';
import assert from 'node:assert/strict';

import { createPresenceTracker, describeBatch } from '../src/lib/presence.js';

const ana = { id: 'a', name: 'Ana' };
const bruno = { id: 'b', name: 'Bruno' };
const caio = { id: 'c', name: 'Caio' };

test('entrada e anunciada depois da janela de agrupamento', () => {
  const tracker = createPresenceTracker({ groupWindowMs: 600 });
  tracker.join(ana, 0);
  assert.deepEqual(tracker.tick(100), [], 'nao emite antes da janela fechar');

  const batches = tracker.tick(800);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].type, 'join');
  assert.deepEqual(batches[0].peers, [ana]);
});

test('entradas simultaneas viram um aviso so', () => {
  const tracker = createPresenceTracker({ groupWindowMs: 600 });
  tracker.join(ana, 0);
  tracker.join(bruno, 120);
  tracker.join(caio, 300);

  const batches = tracker.tick(700);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].peers.length, 3);
});

test('saida espera o debounce', () => {
  const tracker = createPresenceTracker({ leaveDebounceMs: 2000, groupWindowMs: 600 });
  tracker.leave(ana, 0);
  assert.deepEqual(tracker.tick(1500), [], 'ainda dentro do debounce');
  assert.deepEqual(tracker.tick(2100), [], 'promovida, mas a janela de grupo ainda esta aberta');

  const batches = tracker.tick(2800);
  assert.equal(batches[0].type, 'leave');
  assert.deepEqual(batches[0].peers, [ana]);
});

test('oscilacao de rede nao gera "saiu / entrou"', () => {
  const tracker = createPresenceTracker({ leaveDebounceMs: 2000, keyOf: (p) => p.name });
  tracker.leave({ id: 'socket-1', name: 'Ana' }, 0);
  // Reconectou com outro id de socket, mesmo nome, dentro da janela.
  const anunciou = tracker.join({ id: 'socket-2', name: 'Ana' }, 900);

  assert.equal(anunciou, false, 'reconexao nao e uma entrada nova');
  assert.equal(tracker.pendingLeaveCount, 0);
  assert.deepEqual(tracker.tick(5000), [], 'nenhum aviso, nem de saida nem de entrada');
});

test('entradas e saidas misturadas mantem a ordem em lotes separados', () => {
  const tracker = createPresenceTracker({ leaveDebounceMs: 0, groupWindowMs: 600 });
  tracker.join(ana, 0);
  tracker.join(bruno, 10);
  tracker.leave(caio, 20);
  tracker.tick(20); // promove a saida vencida

  const batches = tracker.tick(700);
  assert.equal(batches.length, 2);
  assert.equal(batches[0].type, 'join');
  assert.equal(batches[0].peers.length, 2);
  assert.equal(batches[1].type, 'leave');
});

test('describeBatch usa plural e resumo corretos', () => {
  assert.equal(describeBatch({ type: 'join', peers: [ana] }), 'Ana entrou na chamada');
  assert.equal(describeBatch({ type: 'leave', peers: [ana, bruno] }), 'Ana e Bruno saíram da chamada');
  assert.equal(
    describeBatch({ type: 'join', peers: [ana, bruno, caio, { id: 'd', name: 'Dora' }] }),
    'Ana, Bruno e mais 2 entraram na chamada',
  );
});
