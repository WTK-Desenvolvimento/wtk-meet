/**
 * Caracterização dos handlers Socket.IO e dos endpoints HTTP do servidor.
 *
 * Rede de segurança da migração para TypeScript: até aqui, o único portão sobre
 * `src/index.js` era o E2E — dez minutos por rodada, com passos intermitentes
 * por temporização do sandbox. Migrar o servidor sob aquele portão significaria
 * uma bissecção de dez minutos por tentativa, e um vermelho ambíguo entre
 * "erro de conversão" e "o sandbox engasgou".
 *
 * O que está sob teste é o **protocolo observável de fora**: o que cada socket
 * recebe, em que ordem, e o que ele deliberadamente **não** recebe. Nada aqui
 * inspeciona estado interno do servidor — é de propósito, porque a conversão
 * tem liberdade para mudar a forma das estruturas e nenhuma para mudar o que
 * trafega no fio.
 *
 * Complementa, e não substitui, `client/test/joinRequestSignaling.test.mjs`:
 * aquele cobre o ciclo de vida do pedido de entrada do ponto de vista do modal;
 * este cobre as arestas que o modal nunca exercita — sala cheia, sala inválida,
 * aprovação forjada, relay entre salas diferentes e os dois endpoints HTTP.
 *
 * O servidor sobe de verdade, num processo filho, numa porta sorteada pelo SO.
 * Simular o Socket.IO provaria só que a simulação concorda consigo mesma.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import test, { after, before } from 'node:test';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { io } from 'socket.io-client';

import { MAX_PARTICIPANTS } from '../src/rooms.js';

const SERVER_ENTRY = fileURLToPath(new URL('../src/index.js', import.meta.url));

/** Espera curta: um evento que não chega em 1,5s no loopback não vai chegar. */
const EVENT_TIMEOUT = 1500;

let server;
let port;
const openSockets = [];

/** Porta livre do SO, para não brigar com um servidor de desenvolvimento aberto. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port: chosen } = probe.address();
      probe.close(() => resolve(chosen));
    });
  });
}

function startServer(chosenPort) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, PORT: String(chosenPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const failed = setTimeout(() => reject(new Error('o servidor não subiu em 10s')), 10000);
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening')) {
        clearTimeout(failed);
        resolve(child);
      }
    });
    child.on('error', reject);
  });
}

function connect() {
  const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
  openSockets.push(socket);
  return new Promise((resolve, reject) => {
    socket.on('connect', () => resolve(socket));
    socket.on('connect_error', reject);
  });
}

/** Próxima ocorrência de um evento, com prazo — um `off` no fim evita vazamento. */
function once(socket, event, timeout = EVENT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`nada de "${event}" em ${timeout}ms`));
    }, timeout);
    function handler(payload) {
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    }
    socket.on(event, handler);
  });
}

/**
 * Afirma que um evento **não** chega dentro do prazo.
 *
 * Metade do contrato deste servidor é sobre silêncio: aprovação forjada
 * ignorada, `signal` para outra sala descartado, `to` inexistente sem erro. Um
 * teste que só verifica o que chega não veria nenhuma dessas regressões.
 */
function nothing(socket, event, timeout = 300) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve();
    }, timeout);
    function handler(payload) {
      clearTimeout(timer);
      socket.off(event, handler);
      reject(new Error(`"${event}" chegou quando não devia: ${JSON.stringify(payload)}`));
    }
    socket.on(event, handler);
  });
}

/** Entra numa sala vazia: o primeiro a chegar é admitido sem aprovação. */
async function enterEmptyRoom(roomId, displayName) {
  const socket = await connect();
  const approved = once(socket, 'join-approved', 3000);
  socket.emit('join-request', { roomId, displayName });
  await approved;
  return socket;
}

/** Entra numa sala ocupada, com `approver` aprovando o pedido. */
async function enterWithApproval(roomId, displayName, approver) {
  const socket = await connect();
  const incoming = once(approver, 'join-request', 3000);
  const admitted = once(socket, 'join-approved', 3000);
  socket.emit('join-request', { roomId, displayName });
  const { requesterId } = await incoming;
  approver.emit('approve-join', { requesterId });
  await admitted;
  return socket;
}

before(async () => {
  port = await freePort();
  server = await startServer(port);
});

after(async () => {
  for (const socket of openSockets) {
    socket.removeAllListeners();
    socket.close();
  }
  if (!server) return;
  // Os pipes do processo filho seguram o event loop do runner mesmo depois do
  // kill; sem soltá-los o arquivo termina com "resolution is still pending".
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  // Escalada: neste sandbox o SIGTERM não é entregue a filhos. Sem isto o
  // arquivo trava para sempre com todos os casos já verdes.
  const escalate = setTimeout(() => server.kill('SIGKILL'), 2000);
  await exited;
  clearTimeout(escalate);
  server.stdout.destroy();
  server.stderr.destroy();
});

// ---------------------------------------------------------------- 1. entrada

test('o primeiro a entrar é admitido sem aprovação, com a sala ainda vazia', async () => {
  const socket = await connect();
  const approved = once(socket, 'join-approved', 3000);
  socket.emit('join-request', { roomId: 'sala-primeiro', displayName: 'Alice' });
  const payload = await approved;

  assert.equal(payload.selfId, socket.id, 'o id do socket é a identidade dentro da sala');
  assert.deepEqual(payload.members, [], 'não havia ninguém para listar');
  assert.equal(payload.maxParticipants, MAX_PARTICIPANTS, 'o limite viaja no join-approved');
});

test('quem entra depois recebe a lista de quem já estava, na ordem de entrada', async () => {
  const room = 'sala-ordem';
  const alice = await enterEmptyRoom(room, 'Alice');
  const bob = await enterWithApproval(room, 'Bob', alice);

  const carol = await connect();
  const incoming = once(alice, 'join-request', 3000);
  const admitted = once(carol, 'join-approved', 3000);
  carol.emit('join-request', { roomId: room, displayName: 'Carol' });
  alice.emit('approve-join', { requesterId: (await incoming).requesterId });
  const payload = await admitted;

  assert.deepEqual(
    payload.members,
    [
      { id: alice.id, displayName: 'Alice' },
      { id: bob.id, displayName: 'Bob' },
    ],
    'a lista é [{ id, displayName }] e preserva a ordem de entrada',
  );
});

test('o pedido chega a todos os que já estão na sala, não só a um', async () => {
  // A aprovação é distribuída: qualquer membro decide. Se o pedido chegasse só
  // ao primeiro, a sala ficaria refém de quem entrou primeiro estar atento.
  const room = 'sala-todos-veem';
  const alice = await enterEmptyRoom(room, 'Alice');
  const bob = await enterWithApproval(room, 'Bob', alice);

  const seenByAlice = once(alice, 'join-request');
  const seenByBob = once(bob, 'join-request');
  const carol = await connect();
  carol.emit('join-request', { roomId: room, displayName: 'Carol' });

  const [fromAlice, fromBob] = await Promise.all([seenByAlice, seenByBob]);
  assert.equal(fromAlice.requesterId, carol.id);
  assert.equal(fromBob.requesterId, carol.id);
  assert.equal(fromAlice.displayName, 'Carol');
});

test('quem espera aprovação não recebe o próprio pedido de volta', async () => {
  const room = 'sala-sem-eco';
  const alice = await enterEmptyRoom(room, 'Alice');

  const bob = await connect();
  const eco = nothing(bob, 'join-request');
  bob.emit('join-request', { roomId: room, displayName: 'Bob' });
  await once(alice, 'join-request');
  await eco;
});

// ------------------------------------------------------ 2. nome de exibição

test('displayName ausente, vazio, em branco ou não-string vira "Guest"', async () => {
  const room = 'sala-guest';
  const alice = await enterEmptyRoom(room, 'Alice');

  for (const displayName of [undefined, '', '   ', 42, null, { nome: 'x' }]) {
    const incoming = once(alice, 'join-request');
    const requester = await connect();
    requester.emit('join-request', { roomId: room, displayName });
    const request = await incoming;

    assert.equal(request.displayName, 'Guest', `"${JSON.stringify(displayName)}" devia virar Guest`);
    alice.emit('deny-join', { requesterId: request.requesterId });
    await once(requester, 'join-denied');
  }
});

test('displayName é aparado nas pontas e truncado em 40 caracteres', async () => {
  const room = 'sala-truncagem';
  const alice = await enterEmptyRoom(room, 'Alice');

  const incoming = once(alice, 'join-request');
  const bob = await connect();
  bob.emit('join-request', { roomId: room, displayName: `  ${'N'.repeat(60)}  ` });
  const request = await incoming;

  // O `trim` vem antes do `slice`: o espaço não consome cota dos 40.
  assert.equal(request.displayName, 'N'.repeat(40));
  assert.equal(request.displayName.length, 40);
});

test('um nome que só tem espaço depois do corte ainda vira "Guest"', async () => {
  const room = 'sala-espaco';
  const alice = await enterEmptyRoom(room, 'Alice');

  const incoming = once(alice, 'join-request');
  const bob = await connect();
  bob.emit('join-request', { roomId: room, displayName: '\n\t  \n' });

  assert.equal((await incoming).displayName, 'Guest');
});

// ------------------------------------------------------------- 3. recusas

test('roomId que não é string, ou é vazio, é recusado como invalid-room', async () => {
  for (const roomId of [undefined, '', 42, null, ['daily'], { id: 'daily' }]) {
    const socket = await connect();
    const denied = once(socket, 'join-denied');
    socket.emit('join-request', { roomId, displayName: 'Alice' });

    assert.equal((await denied).reason, 'invalid-room', `roomId ${JSON.stringify(roomId)}`);
  }
});

test('join-request sem payload nenhum é recusado, e não derruba o servidor', async () => {
  // O handler tem `= {}` como padrão justamente para isto; um cliente antigo ou
  // um probe que emita o evento pelado não pode matar o processo da sala.
  const socket = await connect();
  const denied = once(socket, 'join-denied');
  socket.emit('join-request');

  assert.equal((await denied).reason, 'invalid-room');
});

test('a sala lotada recusa com room-full, e ninguém dentro é incomodado', async () => {
  const room = 'sala-lotada';
  const alice = await enterEmptyRoom(room, 'Alice');
  for (let i = 2; i <= MAX_PARTICIPANTS; i += 1) {
    await enterWithApproval(room, `P${i}`, alice);
  }

  const excedente = await connect();
  const denied = once(excedente, 'join-denied');
  // Quem está dentro não pode nem ver o pedido: a recusa é do servidor, e um
  // modal que aparecesse aqui pediria uma decisão que não existe.
  const semPedido = nothing(alice, 'join-request');
  excedente.emit('join-request', { roomId: room, displayName: 'Setimo' });

  assert.equal((await denied).reason, 'room-full');
  await semPedido;
});

// ------------------------------------------------- 4. aprovação e negação

test('aprovação de quem não está na sala do pedido é ignorada em silêncio', async () => {
  // É a defesa contra aprovação forjada: o id de um pedido circula entre os
  // membros, e sem esta checagem qualquer socket conectado poderia usá-lo para
  // se auto-admitir numa sala em que nunca entrou.
  const room = 'sala-vitima';
  const alice = await enterEmptyRoom(room, 'Alice');

  const incoming = once(alice, 'join-request');
  const bob = await connect();
  bob.emit('join-request', { roomId: room, displayName: 'Bob' });
  const { requesterId } = await incoming;

  const forasteiro = await enterEmptyRoom('outra-sala', 'Mallory');
  const naoEntrou = nothing(bob, 'join-approved');
  forasteiro.emit('approve-join', { requesterId });
  await naoEntrou;

  // E o pedido continua legítimo para quem tem direito de decidir.
  const admitted = once(bob, 'join-approved', 3000);
  alice.emit('approve-join', { requesterId });
  assert.equal((await admitted).selfId, bob.id);
});

test('aprovar um requesterId que não existe não faz nada', async () => {
  const room = 'sala-id-fantasma';
  const alice = await enterEmptyRoom(room, 'Alice');
  assert.doesNotThrow(() => alice.emit('approve-join', { requesterId: 'nunca-pediu' }));
  assert.doesNotThrow(() => alice.emit('approve-join'));

  // O servidor continua vivo e atendendo depois dos dois eventos malformados.
  const bob = await enterWithApproval(room, 'Bob', alice);
  assert.ok(bob.id);
});

test('negar responde "denied" a quem pediu e retira o pedido dos demais', async () => {
  const room = 'sala-negativa';
  const alice = await enterEmptyRoom(room, 'Alice');
  const bob = await enterWithApproval(room, 'Bob', alice);

  const seenByAlice = once(alice, 'join-request');
  const seenByBob = once(bob, 'join-request');
  const carol = await connect();
  carol.emit('join-request', { roomId: room, displayName: 'Carol' });
  const { requesterId } = await seenByAlice;
  await seenByBob;

  const denied = once(carol, 'join-denied');
  const cancelled = once(bob, 'join-request-cancelled');
  alice.emit('deny-join', { requesterId });

  assert.equal((await denied).reason, 'denied', 'quem pediu ouve "denied", e não "room-full"');
  assert.equal((await cancelled).requesterId, requesterId, 'a linha some da tela de quem não clicou');
});

test('negação de quem está em outra sala é ignorada', async () => {
  const room = 'sala-negacao-forjada';
  const alice = await enterEmptyRoom(room, 'Alice');

  const incoming = once(alice, 'join-request');
  const bob = await connect();
  bob.emit('join-request', { roomId: room, displayName: 'Bob' });
  const { requesterId } = await incoming;

  const forasteiro = await enterEmptyRoom('sala-do-mallory', 'Mallory');
  const semRecusa = nothing(bob, 'join-denied');
  forasteiro.emit('deny-join', { requesterId });
  await semRecusa;
});

test('desistir enquanto espera retira o pedido, sem mandar recusa a ninguém', async () => {
  const room = 'sala-desistiu';
  const alice = await enterEmptyRoom(room, 'Alice');

  const incoming = once(alice, 'join-request');
  const bob = await connect();
  bob.emit('join-request', { roomId: room, displayName: 'Bob' });
  const { requesterId } = await incoming;

  const cancelled = once(alice, 'join-request-cancelled');
  // `peer-left` seria mentira: Bob nunca chegou a entrar na sala.
  const semSaida = nothing(alice, 'peer-left');
  bob.close();

  assert.equal((await cancelled).requesterId, requesterId);
  await semSaida;
});

// ----------------------------------------------------------- 5. relay de sinal

test('o sinal é retransmitido dentro da sala com o remetente preenchido', async () => {
  const room = 'sala-relay';
  const alice = await enterEmptyRoom(room, 'Alice');
  const bob = await enterWithApproval(room, 'Bob', alice);

  const relayed = once(bob, 'signal');
  const offer = { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' };
  alice.emit('signal', { to: bob.id, data: offer });

  const received = await relayed;
  assert.equal(received.from, alice.id, 'o `from` é do servidor: o remetente não o declara');
  assert.deepEqual(received.data, offer, 'o payload atravessa intacto — o servidor não o inspeciona');
});

test('candidato ICE atravessa igual: o servidor não distingue tipo de payload', async () => {
  const room = 'sala-relay-ice';
  const alice = await enterEmptyRoom(room, 'Alice');
  const bob = await enterWithApproval(room, 'Bob', alice);

  const relayed = once(alice, 'signal');
  const candidate = {
    candidate: { candidate: 'candidate:1 1 UDP 2130706431 10.0.0.1 54321 typ host', sdpMid: '0' },
  };
  bob.emit('signal', { to: alice.id, data: candidate });

  const received = await relayed;
  assert.equal(received.from, bob.id);
  assert.deepEqual(received.data, candidate);
});

test('sinal para alguém de outra sala é descartado sem erro', async () => {
  // Sem esta regra, um socket conectado poderia injetar SDP em qualquer sala do
  // servidor sabendo só o id do alvo — e o mesh do outro lado abriria conexão.
  const alice = await enterEmptyRoom('sala-a', 'Alice');
  const bob = await enterEmptyRoom('sala-b', 'Bob');

  const nadaChega = nothing(bob, 'signal');
  alice.emit('signal', { to: bob.id, data: { type: 'offer' } });
  await nadaChega;
});

test('sinal para id inexistente, ou sem `to` utilizável, não derruba nada', async () => {
  const room = 'sala-relay-invalido';
  const alice = await enterEmptyRoom(room, 'Alice');
  const bob = await enterWithApproval(room, 'Bob', alice);

  for (const to of ['id-que-nao-existe', undefined, 42, null]) {
    alice.emit('signal', { to, data: { type: 'offer' } });
  }
  alice.emit('signal');

  // O servidor segue atendendo o par legítimo depois de todos os malformados.
  const relayed = once(bob, 'signal');
  alice.emit('signal', { to: bob.id, data: { type: 'answer' } });
  assert.deepEqual((await relayed).data, { type: 'answer' });
});

test('quem ainda espera aprovação não recebe nem envia sinal', async () => {
  // Enquanto o pedido está pendente o socket não está em sala nenhuma, então
  // `findRoomOf` devolve null e o relay não acontece nos dois sentidos.
  const room = 'sala-pendente-mudo';
  const alice = await enterEmptyRoom(room, 'Alice');

  const incoming = once(alice, 'join-request');
  const bob = await connect();
  bob.emit('join-request', { roomId: room, displayName: 'Bob' });
  await incoming;

  const bobNaoRecebe = nothing(bob, 'signal');
  const aliceNaoRecebe = nothing(alice, 'signal');
  alice.emit('signal', { to: bob.id, data: { type: 'offer' } });
  bob.emit('signal', { to: alice.id, data: { type: 'offer' } });
  await Promise.all([bobNaoRecebe, aliceNaoRecebe]);
});

// --------------------------------------------------------------- 6. saída

test('leave-room avisa quem fica, uma vez só, e libera a vaga', async () => {
  const room = 'sala-saida';
  const alice = await enterEmptyRoom(room, 'Alice');
  const bob = await enterWithApproval(room, 'Bob', alice);

  const left = once(alice, 'peer-left');
  bob.emit('leave-room');
  assert.equal((await left).peerId, bob.id);

  // Um segundo `leave-room` do mesmo socket não pode gerar outro `peer-left`:
  // do lado do client, remover um participante que já saiu é o caminho para
  // um tile fantasma reaparecer.
  const semRepeticao = nothing(alice, 'peer-left');
  bob.emit('leave-room');
  await semRepeticao;
});

test('desconectar avisa quem fica, mesmo sem leave-room', async () => {
  const room = 'sala-queda';
  const alice = await enterEmptyRoom(room, 'Alice');
  const bob = await enterWithApproval(room, 'Bob', alice);

  // O id tem que ser lido antes do close: o socket-client o zera ao desconectar.
  const bobId = bob.id;
  const left = once(alice, 'peer-left', 3000);
  bob.close();
  assert.equal((await left).peerId, bobId);
});

test('quem sai não recebe o próprio peer-left', async () => {
  const room = 'sala-saida-sem-eco';
  const alice = await enterEmptyRoom(room, 'Alice');
  const bob = await enterWithApproval(room, 'Bob', alice);

  const eco = nothing(bob, 'peer-left');
  const left = once(alice, 'peer-left');
  bob.emit('leave-room');
  await left;
  await eco;
});

test('a sala esvaziada volta a admitir o próximo sem aprovação', async () => {
  // É a prova, de fora, de que o `RoomStore` apagou a sala: se o Map vazio
  // tivesse ficado, o próximo a chegar cairia na fila de aprovação de ninguém
  // e esperaria para sempre.
  const room = 'sala-reciclada';
  const alice = await enterEmptyRoom(room, 'Alice');
  alice.emit('leave-room');

  const proximo = await connect();
  const approved = once(proximo, 'join-approved', 3000);
  proximo.emit('join-request', { roomId: room, displayName: 'Bob' });

  assert.deepEqual((await approved).members, [], 'a sala renasceu vazia');
});

// -------------------------------------------------------- 7. endpoints HTTP

test('/health responde ok e o booleano de TURN, e nada além disso', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(res.status, 200);

  const body = await res.json();
  // `configured` é booleano puro: não diz qual token, não valida credencial e
  // não chama a Cloudflare. Sem `CF_TURN_*` no ambiente do teste, é false.
  assert.deepEqual(body, { ok: true, turn: { configured: false } });
});

test('/rooms/:id/occupancy responde só { occupied } — sem nomes e sem contagem', async () => {
  const room = 'sala-ocupacao';
  const vazia = await (await fetch(`http://127.0.0.1:${port}/rooms/${room}/occupancy`)).json();
  assert.deepEqual(vazia, { occupied: false });

  const alice = await enterEmptyRoom(room, 'Alice');
  const ocupada = await (await fetch(`http://127.0.0.1:${port}/rooms/${room}/occupancy`)).json();
  // A forma é o contrato: qualquer campo a mais aqui é vazamento de quem está
  // na sala para quem só sabe adivinhar o endereço.
  assert.deepEqual(ocupada, { occupied: true }, 'só o booleano, nunca quem ou quantos');

  alice.emit('leave-room');
  // A ocupação acompanha o esvaziamento — é o mesmo estado que o Socket.IO lê.
  const depois = await (async () => {
    for (let i = 0; i < 20; i += 1) {
      const body = await (await fetch(`http://127.0.0.1:${port}/rooms/${room}/occupancy`)).json();
      if (body.occupied === false) return body;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('a sala continuou ocupada depois do leave-room');
  })();
  assert.deepEqual(depois, { occupied: false });
});

test('/turn-credentials sem CF_TURN_* responde 503, e não uma lista vazia com 200', async () => {
  // Lista vazia com 200 é indistinguível de sala saudável para o client, para um
  // probe e para qualquer proxy no caminho — e sob `iceTransportPolicy: 'relay'`
  // significa que nenhuma conexão vai fechar.
  const res = await fetch(`http://127.0.0.1:${port}/turn-credentials`);
  assert.equal(res.status, 503);

  const body = await res.json();
  assert.equal(body.error, 'turn-unconfigured');
  assert.ok(!JSON.stringify(body).includes('iceServers'), 'não anuncia lista nenhuma');
});
