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

import { MAX_PARTICIPANTS, RESUME_GRACE_MS, RoomStore } from '../src/rooms.js';

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

// ─────────────────────────── contabilidade efêmera (WTK-MEET-21)
//
// Os três leitores acrescentados para telemetria. O que eles guardam vive e
// morre com o `Map`: quando a sala esvazia e é deletada, some junto. O
// `RoomStore` continua passivo — ele não importa `telemetry.ts`, não recebe
// callback e não emite evento; quem orquestra é o `index.ts`.

test('roomStats acompanha o pico de ocupação, e o pico não desce quando alguém sai', () => {
  // O pico é o que vira amostra de `wtk_room_occupancy` no fechamento da sala.
  // Se ele acompanhasse o tamanho corrente, a métrica mediria "quantos estavam
  // na hora em que o último saiu", que é sempre 1.
  const rooms = new RoomStore();
  rooms.addMember('daily', 'a', 'A');
  rooms.addMember('daily', 'b', 'B');
  rooms.addMember('daily', 'c', 'C');
  assert.equal(rooms.roomStats('daily')?.peak, 3);

  rooms.removeMember('daily', 'c');
  rooms.removeMember('daily', 'b');
  assert.equal(rooms.roomStats('daily')?.size, 1, 'o tamanho corrente desce');
  assert.equal(rooms.roomStats('daily')?.peak, 3, 'o pico não');
});

test('roomStats e memberJoinedAt somem junto com a sala', () => {
  const rooms = new RoomStore();
  rooms.addMember('daily', 'a', 'A');
  assert.ok(rooms.roomStats('daily'));
  assert.ok(typeof rooms.memberJoinedAt('daily', 'a') === 'number');

  rooms.removeMember('daily', 'a');
  assert.equal(rooms.roomStats('daily'), null, 'nada sobrevive à sala');
  assert.equal(rooms.memberJoinedAt('daily', 'a'), null);
  assert.equal(rooms.roomStats('sala-que-nunca-existiu'), null);
});

test('o instante de entrada é por socket, e reentrada do mesmo socket não o reinicia', () => {
  // `admitToRoom` sobrescreve o membro quando o displayName muda; zerar o
  // relógio ali faria a sessão daquele socket ser contada em pedaços.
  let agora = 1_000;
  const rooms = new RoomStore(() => agora);
  rooms.addMember('daily', 'a', 'A');
  agora = 5_000;
  rooms.addMember('daily', 'b', 'B');
  agora = 9_000;
  rooms.addMember('daily', 'a', 'A Renomeada');

  assert.equal(rooms.memberJoinedAt('daily', 'a'), 1_000);
  assert.equal(rooms.memberJoinedAt('daily', 'b'), 5_000);
  assert.equal(rooms.roomStats('daily')?.openedAt, 1_000, 'a sala nasce com o primeiro membro');
});

test('snapshot é a soma real do store, depois de 50 ciclos de entrada e saída', () => {
  // A propriedade que torna `wtk_rooms_active` incapaz de derivar: ela é
  // leitura deste `Map`, não um contador que alguém teria que decrementar nos
  // quatro caminhos de saída do servidor.
  const rooms = new RoomStore();
  assert.deepEqual(rooms.snapshot(), { rooms: 0, participants: 0 });

  for (let ciclo = 0; ciclo < 50; ciclo += 1) {
    rooms.addMember(`sala-${ciclo}`, `s-${ciclo}-1`, 'P1');
    rooms.addMember(`sala-${ciclo}`, `s-${ciclo}-2`, 'P2');
    // Metade dos ciclos esvazia; a outra metade fica de pé.
    if (ciclo % 2 === 0) {
      rooms.removeMember(`sala-${ciclo}`, `s-${ciclo}-1`);
      rooms.removeMember(`sala-${ciclo}`, `s-${ciclo}-2`);
    }
  }

  const esperado = { rooms: 25, participants: 50 };
  assert.deepEqual(rooms.snapshot(), esperado);
  assert.equal(rooms.rooms.size, esperado.rooms, 'e bate com o Map, que é a fonte da verdade');
});

test('sala criada por ensureRoom e nunca ocupada não conta como sala ativa', () => {
  const rooms = new RoomStore();
  rooms.ensureRoom('fantasma');
  assert.deepEqual(rooms.snapshot(), { rooms: 0, participants: 0 });
});

// --------------------------------------------------- 2. token de retorno
//
// Toda a janela de graça é provada aqui, com relógio fabricado. Nada neste
// arquivo espera 60 segundos, e nada nele usa `setTimeout` — a expiração é
// preguiçosa de propósito, e é isso que a torna testável na borda exata.

/** Store com relógio e gerador de token sob controle do teste. */
function storeDeTeste() {
  let agora = 1_000_000;
  let emitidos = 0;
  const rooms = new RoomStore(
    () => agora,
    () => `token-${(emitidos += 1)}`,
  );
  return {
    rooms,
    avancar: (ms: number) => {
      agora += ms;
    },
  };
}

/** Uma sala com dois membros: a situação em que a aprovação existe. */
function salaComDois(rooms: RoomStore) {
  rooms.addMember('daily', 'alice', 'Alice');
  rooms.addMember('daily', 'bob', 'Bob');
}

test('a janela de graça é de 60s e está exportada — nenhum teste espera por ela', () => {
  assert.equal(RESUME_GRACE_MS, 60_000);
});

test('o token default é opaco: 32 bytes em hex, e nunca o mesmo duas vezes', () => {
  const rooms = new RoomStore();
  rooms.addMember('daily', 'alice', 'Alice');
  const primeiro = rooms.issueResumeToken('daily', 'alice', 'Alice');
  const segundo = rooms.issueResumeToken('daily', 'alice', 'Alice');

  assert.match(primeiro, /^[0-9a-f]{64}$/, '256 bits tornam adivinhação irrelevante como vetor');
  assert.notEqual(primeiro, segundo);
});

test('cada admissão emite um token novo e mata o anterior do mesmo socket', () => {
  const { rooms } = storeDeTeste();
  salaComDois(rooms);

  const antigo = rooms.issueResumeToken('daily', 'bob', 'Bob');
  const novo = rooms.issueResumeToken('daily', 'bob', 'Bob');
  assert.notEqual(antigo, novo);

  // Bob cai: os dois tokens seriam armados se os dois existissem.
  rooms.removeMember('daily', 'bob');
  rooms.armResumeGrace('daily', 'bob');

  assert.equal(rooms.consumeResumeToken(antigo, 'daily'), null, 'o token rotacionado não volta');
  assert.deepEqual(rooms.consumeResumeToken(novo, 'daily'), { displayName: 'Bob' });
});

test('token de socket que nunca caiu não é retomável — é a aba duplicada', () => {
  // Duplicar a aba no Chrome copia o `sessionStorage`. Sem esta regra a cópia
  // entraria sem aprovação enquanto a original segue na sala: duas presenças a
  // partir de uma aprovação só.
  const { rooms, avancar } = storeDeTeste();
  salaComDois(rooms);
  const token = rooms.issueResumeToken('daily', 'bob', 'Bob');

  assert.equal(rooms.consumeResumeToken(token, 'daily'), null, 'nasce não-armado');
  avancar(1);
  assert.equal(rooms.consumeResumeToken(token, 'daily'), null, 'e continua não-armado');
  assert.equal(rooms.getRoom('daily')?.size, 2, 'e ninguém foi removido da sala');
});

test('a graça vale até o instante anterior ao prazo, e não no prazo', () => {
  const { rooms, avancar } = storeDeTeste();
  salaComDois(rooms);
  const token = rooms.issueResumeToken('daily', 'bob', 'Bob');
  rooms.removeMember('daily', 'bob');
  rooms.armResumeGrace('daily', 'bob');

  avancar(RESUME_GRACE_MS - 1);
  assert.deepEqual(rooms.consumeResumeToken(token, 'daily'), { displayName: 'Bob' }, 'a borda de dentro');
});

test('no instante exato do prazo o token já não vale, e some do registro', () => {
  const { rooms, avancar } = storeDeTeste();
  salaComDois(rooms);
  const token = rooms.issueResumeToken('daily', 'bob', 'Bob');
  rooms.removeMember('daily', 'bob');
  rooms.armResumeGrace('daily', 'bob');

  avancar(RESUME_GRACE_MS);
  assert.equal(rooms.consumeResumeToken(token, 'daily'), null, 'a borda de fora é fechada');
  // E a vaga que ele segurava foi devolvida à sala.
  assert.equal(rooms.isFull('daily'), false);
});

test('o consumo é único: o mesmo token não retoma duas vezes', () => {
  const { rooms } = storeDeTeste();
  salaComDois(rooms);
  const token = rooms.issueResumeToken('daily', 'bob', 'Bob');
  rooms.removeMember('daily', 'bob');
  rooms.armResumeGrace('daily', 'bob');

  assert.deepEqual(rooms.consumeResumeToken(token, 'daily'), { displayName: 'Bob' });
  assert.equal(rooms.consumeResumeToken(token, 'daily'), null, 'sem replay');
});

test('o token de uma sala não abre outra, e nem é consumido por ela', () => {
  const { rooms } = storeDeTeste();
  salaComDois(rooms);
  rooms.addMember('outra', 'carol', 'Carol');
  const token = rooms.issueResumeToken('daily', 'bob', 'Bob');
  rooms.removeMember('daily', 'bob');
  rooms.armResumeGrace('daily', 'bob');

  assert.equal(rooms.consumeResumeToken(token, 'outra'), null, 'a sala é parte do que o token prova');
  assert.deepEqual(rooms.consumeResumeToken(token, 'daily'), { displayName: 'Bob' }, 'e continua valendo na dele');
});

test('token cujo socketId voltou a aparecer na sala não retoma', () => {
  // Cinto de segurança contra qualquer caminho que arme a graça sem remover o
  // membro: o registro descreve uma ausência, e presença o invalida.
  const { rooms } = storeDeTeste();
  salaComDois(rooms);
  const token = rooms.issueResumeToken('daily', 'bob', 'Bob');
  rooms.removeMember('daily', 'bob');
  rooms.armResumeGrace('daily', 'bob');
  rooms.addMember('daily', 'bob', 'Bob');

  assert.equal(rooms.consumeResumeToken(token, 'daily'), null);
  assert.equal(rooms.getRoom('daily')?.size, 2, 'e ninguém foi expulso no caminho');
});

test('a retomada devolve o nome do registro, e não o que vier de fora', () => {
  const { rooms } = storeDeTeste();
  salaComDois(rooms);
  const token = rooms.issueResumeToken('daily', 'bob', 'Bob Original');
  rooms.removeMember('daily', 'bob');
  rooms.armResumeGrace('daily', 'bob');

  // A autoridade do token cobre a identidade que foi aprovada, e nada além:
  // deixar o payload renomear cria um canal que ninguém revisa.
  assert.deepEqual(rooms.consumeResumeToken(token, 'daily'), { displayName: 'Bob Original' });
});

test('a vaga reservada conta para o limite, e o retorno não leva room-full', () => {
  const { rooms } = storeDeTeste();
  for (let i = 1; i <= MAX_PARTICIPANTS; i += 1) rooms.addMember('daily', `s${i}`, `P${i}`);
  assert.equal(rooms.isFull('daily'), true);

  const token = rooms.issueResumeToken('daily', 's6', 'P6');
  rooms.removeMember('daily', 's6');
  rooms.armResumeGrace('daily', 's6');

  assert.equal(rooms.getRoom('daily')?.size, MAX_PARTICIPANTS - 1, 'cinco membros conectados');
  assert.equal(rooms.isFull('daily'), true, 'e a sexta cadeira continua ocupada por quem caiu');
  assert.deepEqual(rooms.consumeResumeToken(token, 'daily'), { displayName: 'P6' }, 'quem caiu volta');
});

test('a vaga reservada não entra no gauge de participantes conectados', () => {
  // `wtk_participants_active` mede gente conectada agora, não cadeiras: um
  // painel que somasse a reserva mentiria sobre ocupação real.
  const { rooms } = storeDeTeste();
  salaComDois(rooms);
  rooms.issueResumeToken('daily', 'bob', 'Bob');
  rooms.removeMember('daily', 'bob');
  rooms.armResumeGrace('daily', 'bob');

  assert.deepEqual(rooms.snapshot(), { rooms: 1, participants: 1 });
});

test('a sala que esvazia leva os tokens dela junto', () => {
  // Sala vazia ⇒ nada resta. É o que mantém o §5 do ARCHITECTURE.md literal, e
  // o que faz "o servidor reiniciou" significar "todo mundo pede aprovação".
  const { rooms } = storeDeTeste();
  rooms.addMember('daily', 'alice', 'Alice');
  const token = rooms.issueResumeToken('daily', 'alice', 'Alice');
  rooms.removeMember('daily', 'alice');
  rooms.armResumeGrace('daily', 'alice');

  assert.equal(rooms.getRoom('daily'), undefined, 'a sala morreu');
  rooms.addMember('daily', 'nova-alice', 'Alice');
  assert.equal(rooms.consumeResumeToken(token, 'daily'), null, 'e o token não ressuscitou com ela');
});

test('saída intencional descarta o token sem armar nada', () => {
  const { rooms } = storeDeTeste();
  salaComDois(rooms);
  const token = rooms.issueResumeToken('daily', 'bob', 'Bob');

  rooms.removeMember('daily', 'bob');
  rooms.discardResumeTokens('daily', 'bob');
  // Mesmo que algo arme depois, não há mais o que armar.
  rooms.armResumeGrace('daily', 'bob');

  assert.equal(rooms.consumeResumeToken(token, 'daily'), null, 'quem clicou em sair, saiu');
  assert.equal(rooms.isFull('daily'), false, 'e não segurou cadeira nenhuma');
});

test('entradas vencidas não se acumulam: a escrita seguinte as varre', () => {
  const { rooms, avancar } = storeDeTeste();
  salaComDois(rooms);
  const vencido = rooms.issueResumeToken('daily', 'bob', 'Bob');
  rooms.removeMember('daily', 'bob');
  rooms.armResumeGrace('daily', 'bob');

  avancar(RESUME_GRACE_MS + 1);
  // Uma escrita qualquer naquela sala é o gatilho da varredura — sem timer, sem
  // handle para cancelar no shutdown.
  rooms.addMember('daily', 'carol', 'Carol');
  rooms.issueResumeToken('daily', 'carol', 'Carol');

  assert.equal(rooms.consumeResumeToken(vencido, 'daily'), null);
  assert.equal(rooms.isFull('daily'), false, 'e a cadeira vencida não ficou reservada');
});
