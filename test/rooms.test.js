import test from 'node:test';
import assert from 'node:assert/strict';

import { createRoomRegistry, publicPeer } from '../server/rooms.js';

const socket = { readyState: 1, send() {} };

test('participantes entram e saem da sala', () => {
  const registry = createRoomRegistry();
  const { room } = registry.join('sala', 'p1', 'Ana', socket);
  registry.join('sala', 'p2', 'Bruno', socket);

  assert.equal(room.peers.size, 2);
  registry.leave('sala', 'p1');
  assert.equal(room.peers.size, 1);
});

test('sala vazia e destruida — nada sobrevive a ultima pessoa', () => {
  const registry = createRoomRegistry();
  registry.join('sala', 'p1', 'Ana', socket);
  assert.equal(registry.size, 1);
  registry.leave('sala', 'p1');
  assert.equal(registry.size, 0);
  assert.equal(registry.get('sala'), null);
});

test('sair libera a trava de compartilhamento', () => {
  const registry = createRoomRegistry();
  const { room, peer } = registry.join('sala', 'p1', 'Ana', socket);
  registry.join('sala', 'p2', 'Bruno', socket);
  room.shareLock.acquire({ id: peer.id, name: peer.name });

  const result = registry.leave('sala', 'p1');
  assert.equal(result.releasedShare, true);
  assert.equal(room.shareLock.holder, null);
});

test('publicPeer nao vaza o socket', () => {
  const registry = createRoomRegistry();
  const { peer } = registry.join('sala', 'p1', 'Ana', socket);
  const view = publicPeer(peer);
  assert.deepEqual(Object.keys(view).sort(), ['id', 'name', 'state']);
  assert.equal(view.socket, undefined);
});

test('o servidor rejeita mensagem longa demais mesmo se o cliente deixar passar', () => {
  const registry = createRoomRegistry();
  const { peer } = registry.join('sala', 'p1', 'Ana', socket);
  const result = registry.checkChat(peer, 'a'.repeat(5000), 1000);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'muito-longa');
});

test('rate limit corta a rajada e libera depois da janela', () => {
  const registry = createRoomRegistry();
  const { peer } = registry.join('sala', 'p1', 'Ana', socket);

  for (let i = 0; i < 5; i += 1) {
    assert.equal(registry.checkChat(peer, `msg ${i}`, 1000 + i).ok, true);
  }
  assert.equal(registry.checkChat(peer, 'sexta', 1010).reason, 'rate-limit');
  // Passada a janela de 3s, volta a aceitar.
  assert.equal(registry.checkChat(peer, 'depois', 5000).ok, true);
});

test('o nome do participante e normalizado na entrada', () => {
  const registry = createRoomRegistry();
  const { peer } = registry.join('sala', 'p1', '   Nicolas    Woitchik  ', socket);
  assert.equal(peer.name, 'Nicolas Woitchik');
});
