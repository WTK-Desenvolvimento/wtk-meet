/**
 * Ciclo de vida de um pedido de entrada, do lado da sinalização.
 *
 * O modal de aprovação é a única coisa da tela que **bloqueia** a sala: ele não
 * fecha por Esc nem por clique no backdrop (de propósito — ver
 * `components/JoinRequestModal.jsx`), então cada linha listada só some quando o
 * pedido correspondente é resolvido. A consequência é dura: um pedido que ficar
 * pendente no cliente depois de já não poder ser atendido trava a sala inteira
 * atrás de um backdrop com botões que não fazem nada.
 *
 * Quem decide quando a linha some é o servidor. Por isso estes casos exercitam
 * o servidor de verdade — processo real, Socket.IO real — em vez de simular o
 * protocolo. É o teste mais barato que prova o contrato que o modal assume;
 * a validação no navegador fica com `e2e/run.mjs` (checagens M1–M6).
 *
 * Mora em `client/test/` porque é aqui que roda o `npm test` do projeto e onde
 * `socket.io-client` já é dependência — o servidor não tem suíte própria, e
 * criar uma custaria uma dependência nova só para isto.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

import { io } from 'socket.io-client';

const SERVER_ENTRY = fileURLToPath(new URL('../../server/src/index.js', import.meta.url));

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

/** Entra numa sala vazia: o primeiro a chegar é admitido sem aprovação. */
async function enterEmptyRoom(roomId, displayName) {
  const socket = await connect();
  const approved = once(socket, 'join-approved', 3000);
  socket.emit('join-request', { roomId, displayName });
  await approved;
  return socket;
}

/** Pede entrada numa sala ocupada e devolve o socket ainda pendente. */
async function requestEntry(roomId, displayName) {
  const socket = await connect();
  socket.emit('join-request', { roomId, displayName });
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
  // Escalada depois de um prazo curto: há ambientes (sandboxes de CI, contêineres
  // com PID 1 sem reaper) em que o SIGTERM simplesmente não é entregue ao filho.
  // Sem isto, `await exited` fica pendente para sempre e o arquivo inteiro trava
  // depois de todos os casos já terem passado — uma suíte que nunca termina, sem
  // nenhum caso vermelho para explicar o porquê.
  const escalate = setTimeout(() => server.kill('SIGKILL'), 2000);
  await exited;
  clearTimeout(escalate);
  server.stdout.destroy();
  server.stderr.destroy();
});

test('quem já está na sala recebe o pedido com o id e o nome de quem espera', async () => {
  const room = 'sala-pedido-chega';
  const alice = await enterEmptyRoom(room, 'Alice');

  const incoming = once(alice, 'join-request');
  const bob = await requestEntry(room, 'Bob');
  const request = await incoming;

  assert.equal(request.displayName, 'Bob');
  assert.equal(request.requesterId, bob.id, 'o id do pedido é o que "Aprovar" vai enviar de volta');
});

test('aprovar admite quem esperava e avisa o resto da sala', async () => {
  const room = 'sala-aprovacao';
  const alice = await enterEmptyRoom(room, 'Alice');

  const incoming = once(alice, 'join-request');
  const bob = await requestEntry(room, 'Bob');
  const { requesterId } = await incoming;

  const admitted = once(bob, 'join-approved');
  const announced = once(alice, 'peer-joined');
  alice.emit('approve-join', { requesterId });

  const approval = await admitted;
  assert.deepEqual(
    approval.members.map((m) => m.displayName),
    ['Alice'],
    'quem entra recebe a lista de quem já estava',
  );
  assert.equal((await announced).peerId, bob.id);
});

test('resolver um pedido não interfere no outro que está pendente', async () => {
  // O modal lista N pedidos, um por linha. Aprovar o primeiro não pode deixar o
  // segundo órfão: ele continua sendo aprovável pelo mesmo id.
  const room = 'sala-dois-pedidos';
  const alice = await enterEmptyRoom(room, 'Alice');

  const firstIncoming = once(alice, 'join-request');
  await requestEntry(room, 'Bob');
  const first = await firstIncoming;

  const secondIncoming = once(alice, 'join-request');
  const carol = await requestEntry(room, 'Carol');
  const second = await secondIncoming;

  alice.emit('approve-join', { requesterId: first.requesterId });
  await once(alice, 'peer-joined');

  const carolAdmitted = once(carol, 'join-approved');
  alice.emit('approve-join', { requesterId: second.requesterId });
  const approval = await carolAdmitted;
  assert.equal(approval.selfId, carol.id, 'o segundo pedido continuou aprovável pelo mesmo id');
});

test('o pedido é retirado da sala quando quem esperava desiste', async () => {
  // Fechar a aba enquanto espera é o caminho mais comum de desistência. Do
  // outro lado o modal continua aberto, bloqueando a sala com um botão
  // "Aprovar" que o servidor já ignora (o pendente foi apagado). Só um aviso
  // explícito derruba aquela linha.
  const room = 'sala-desistencia';
  const alice = await enterEmptyRoom(room, 'Alice');

  const incoming = once(alice, 'join-request');
  const bob = await requestEntry(room, 'Bob');
  const { requesterId } = await incoming;

  const cancelled = once(alice, 'join-request-cancelled');
  bob.close();

  const event = await cancelled;
  assert.equal(event.requesterId, requesterId, 'o cancelamento identifica a linha a remover');
});

test('quando um participante nega, o pedido some da tela dos demais', async () => {
  // A aprovação é distribuída: qualquer um decide, e a decisão vale para todos.
  // Quem não clicou também precisa saber que aquele pedido acabou — senão fica
  // com um modal exigindo uma decisão que já foi tomada.
  const room = 'sala-negacao-compartilhada';
  const alice = await enterEmptyRoom(room, 'Alice');

  const bobIncoming = once(alice, 'join-request');
  const bob = await requestEntry(room, 'Bob');
  alice.emit('approve-join', { requesterId: (await bobIncoming).requesterId });
  await once(bob, 'join-approved');

  const seenByAlice = once(alice, 'join-request');
  const seenByBob = once(bob, 'join-request');
  await requestEntry(room, 'Carol');
  const { requesterId } = await seenByAlice;
  await seenByBob;

  const cancelledForBob = once(bob, 'join-request-cancelled');
  alice.emit('deny-join', { requesterId });

  assert.equal((await cancelledForBob).requesterId, requesterId);
});
