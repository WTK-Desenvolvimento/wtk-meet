/**
 * Caracterização do `RoomStore` — a estrutura que a migração para TypeScript
 * vai reescrever como `Map<string, Map<string, Member>>`.
 *
 * Este arquivo não descreve o desenho que o `RoomStore` *deveria* ter: ele
 * congela o que ele **faz hoje**, incluindo as arestas que só existem por
 * acidente de implementação (`getRoom` de sala inexistente devolve `undefined`,
 * `removeMember` de sala inexistente não lança). A tipagem tem liberdade para
 * mudar a forma da declaração; não tem liberdade para mudar nenhuma linha
 * daqui.
 *
 * Por que agora: o `RoomStore` é o dono do único estado do produto, e o Map
 * aninhado é justamente onde os handlers de sinalização mais erram. Até esta
 * suíte existir, o único portão sobre ele era o E2E — dez minutos por rodada.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { MAX_PARTICIPANTS, RoomStore } from '../src/rooms.js';

test('a sala nasce vazia e o limite é 6', () => {
  assert.equal(MAX_PARTICIPANTS, 6, 'o limite é contrato: o client o exibe e o E2E o exercita');

  const rooms = new RoomStore();
  assert.equal(rooms.isEmpty('daily'), true, 'sala que nunca existiu conta como vazia');
  assert.equal(rooms.isFull('daily'), false);
  assert.deepEqual(rooms.members('daily'), []);
});

test('ensureRoom é idempotente e devolve sempre o mesmo Map', () => {
  // Se uma segunda chamada trocasse o Map, todo mundo que já estava na sala
  // sumiria sem nenhum evento — a falha mais silenciosa possível.
  const rooms = new RoomStore();
  const first = rooms.ensureRoom('daily');
  first.set('socket-a', { displayName: 'Alice' });

  const second = rooms.ensureRoom('daily');
  assert.equal(second, first, 'ensureRoom não pode recriar uma sala que já existe');
  assert.equal(second.size, 1);
});

test('isEmpty deixa de valer no primeiro membro, e isFull só no sexto', () => {
  const rooms = new RoomStore();

  for (let i = 1; i <= MAX_PARTICIPANTS; i += 1) {
    assert.equal(rooms.isFull('daily'), false, `com ${i - 1} membros a sala ainda aceita gente`);
    rooms.addMember('daily', `socket-${i}`, `P${i}`);
    assert.equal(rooms.isEmpty('daily'), false);
  }

  assert.equal(rooms.isFull('daily'), true, 'o sexto membro fecha a sala');

  // `>=` e não `===`: se um sétimo entrasse por qualquer caminho, a sala não
  // pode voltar a se declarar aberta.
  rooms.addMember('daily', 'socket-7', 'P7');
  assert.equal(rooms.isFull('daily'), true);
});

test('addMember guarda o displayName e sobrescreve o mesmo socket sem duplicar', () => {
  const rooms = new RoomStore();
  rooms.addMember('daily', 'socket-a', 'Alice');
  rooms.addMember('daily', 'socket-a', 'Alice Renomeada');

  assert.deepEqual(rooms.members('daily'), [['socket-a', { displayName: 'Alice Renomeada' }]]);
});

test('members devolve pares [socketId, info] na ordem de entrada', () => {
  // A ordem é observável: `admitToRoom` manda esta lista para quem entra, e o
  // client monta a grade a partir dela. Map preserva ordem de inserção, e é
  // disso que o produto depende hoje.
  const rooms = new RoomStore();
  rooms.addMember('daily', 'socket-a', 'Alice');
  rooms.addMember('daily', 'socket-b', 'Bob');
  rooms.addMember('daily', 'socket-c', 'Carol');

  assert.deepEqual(rooms.members('daily'), [
    ['socket-a', { displayName: 'Alice' }],
    ['socket-b', { displayName: 'Bob' }],
    ['socket-c', { displayName: 'Carol' }],
  ]);
});

test('members de sala inexistente é lista vazia, não undefined', () => {
  // `admitToRoom` e `cancelPendingJoin` iteram este retorno direto, sem guarda.
  const rooms = new RoomStore();
  assert.deepEqual(rooms.members('nunca-existiu'), []);
});

test('sair libera a vaga sem apagar a sala enquanto sobrar alguém', () => {
  const rooms = new RoomStore();
  for (let i = 1; i <= MAX_PARTICIPANTS; i += 1) rooms.addMember('daily', `socket-${i}`, `P${i}`);

  rooms.removeMember('daily', 'socket-3');
  assert.equal(rooms.isFull('daily'), false, 'a vaga aberta volta a ser oferecida');
  assert.equal(rooms.members('daily').length, 5);
  assert.equal(rooms.findRoomOf('socket-3'), null);
  assert.equal(rooms.findRoomOf('socket-4'), 'daily', 'quem ficou não é afetado');
});

test('a saída do último apaga a sala — não sobra Map vazio', () => {
  // É a garantia de "nada persiste": uma sala que ficasse no Map depois de
  // esvaziar seria estado acumulando para sempre num processo sem reinício,
  // e faria `isEmpty` continuar respondendo por um endereço abandonado.
  const rooms = new RoomStore();
  rooms.addMember('daily', 'socket-a', 'Alice');
  rooms.removeMember('daily', 'socket-a');

  assert.equal(rooms.isEmpty('daily'), true);
  assert.equal(rooms.getRoom('daily'), undefined, 'a chave sai do Map, não fica um Map vazio');
  assert.equal(rooms.rooms.size, 0);
  assert.equal(rooms.findRoomOf('socket-a'), null);
});

test('removeMember de sala ou de socket inexistente não lança', () => {
  // `disconnect` chama este caminho para todo socket que nunca entrou em sala.
  const rooms = new RoomStore();
  assert.doesNotThrow(() => rooms.removeMember('nunca-existiu', 'socket-a'));

  rooms.addMember('daily', 'socket-a', 'Alice');
  assert.doesNotThrow(() => rooms.removeMember('daily', 'socket-fantasma'));
  assert.equal(rooms.members('daily').length, 1, 'remover um desconhecido não mexe em quem está');
});

test('findRoomOf acha o socket em qualquer sala, e devolve null para desconhecido', () => {
  const rooms = new RoomStore();
  rooms.addMember('daily', 'socket-a', 'Alice');
  rooms.addMember('retro', 'socket-b', 'Bob');

  assert.equal(rooms.findRoomOf('socket-a'), 'daily');
  assert.equal(rooms.findRoomOf('socket-b'), 'retro');
  assert.equal(rooms.findRoomOf('socket-desconhecido'), null, 'null, e não undefined');
});

test('salas são isoladas: lotar uma não fecha a outra', () => {
  const rooms = new RoomStore();
  for (let i = 1; i <= MAX_PARTICIPANTS; i += 1) rooms.addMember('daily', `socket-${i}`, `P${i}`);
  rooms.addMember('retro', 'socket-x', 'X');

  assert.equal(rooms.isFull('daily'), true);
  assert.equal(rooms.isFull('retro'), false);
  assert.equal(rooms.members('retro').length, 1);
});
