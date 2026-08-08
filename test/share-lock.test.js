import test from 'node:test';
import assert from 'node:assert/strict';

import { createShareLock } from '../src/lib/share-lock.js';

const ana = { id: 'a', name: 'Ana' };
const bruno = { id: 'b', name: 'Bruno' };

test('a primeira pessoa a pedir leva a trava', () => {
  const lock = createShareLock();
  assert.deepEqual(lock.acquire(ana), { ok: true });
  assert.equal(lock.holder.name, 'Ana');
});

test('a segunda pessoa e recusada e sabe quem esta compartilhando', () => {
  const lock = createShareLock();
  lock.acquire(ana);
  const result = lock.acquire(bruno);
  assert.equal(result.ok, false);
  assert.equal(result.holder.name, 'Ana');
});

test('pedir de novo sendo o dono e idempotente', () => {
  const lock = createShareLock();
  lock.acquire(ana);
  assert.deepEqual(lock.acquire(ana), { ok: true });
});

test('so o dono libera a trava', () => {
  const lock = createShareLock();
  lock.acquire(ana);
  assert.equal(lock.release(bruno.id), false, 'outro participante nao pode liberar');
  assert.equal(lock.isHeldBy(ana.id), true);
  assert.equal(lock.release(ana.id), true);
  assert.equal(lock.holder, null);
});

test('depois de liberada, a proxima pessoa consegue', () => {
  const lock = createShareLock();
  lock.acquire(ana);
  lock.release(ana.id);
  assert.deepEqual(lock.acquire(bruno), { ok: true });
});
