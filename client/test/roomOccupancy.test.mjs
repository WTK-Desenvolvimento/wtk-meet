/**
 * `GET /rooms/:roomId/occupancy` — o aviso de "já existe gente nessa sala" da
 * Home, contra o servidor de verdade.
 *
 * Arquivo separado de propósito: o endpoint é o item do DoD que diverge do
 * documento de arquitetura desta entrega (§3.2 e §7 pedem para ele **não**
 * existir, por enumeração de salas ativas). Manter código e cobertura num
 * commit isolado é o que permite desligá-lo com um `git revert` só, sem tocar
 * no resto da task.
 *
 * O que precisa valer aqui é o mínimo: responde booleano, some quando a sala
 * esvazia e não conta nada além disso — nem quem está lá, nem quantos.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

import { io } from 'socket.io-client';

const SERVER_ENTRY = fileURLToPath(new URL('../../server/src/index.js', import.meta.url));

let server;
let port;
const openSockets = [];

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

/** Entra numa sala vazia — o primeiro a chegar é admitido sem aprovação. */
async function enterEmptyRoom(roomId, displayName) {
  const socket = io(`http://127.0.0.1:${port}`, { transports: ['websocket'], forceNew: true });
  openSockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.on('connect', resolve);
    socket.on('connect_error', reject);
  });
  const approved = new Promise((resolve) => socket.once('join-approved', resolve));
  socket.emit('join-request', { roomId, displayName });
  await approved;
  return socket;
}

const occupancy = async (roomId) => {
  const res = await fetch(`http://127.0.0.1:${port}/rooms/${encodeURIComponent(roomId)}/occupancy`);
  assert.equal(res.status, 200);
  return res.json();
};

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
  // Mesma escalada de `joinRequestSignaling.test.mjs`: há ambientes em que o
  // SIGTERM não chega ao filho e o `await` abaixo ficaria pendente para sempre.
  const exited = new Promise((resolve) => server.once('exit', resolve));
  server.kill();
  const escalate = setTimeout(() => server.kill('SIGKILL'), 2000);
  await exited;
  clearTimeout(escalate);
  server.stdout.destroy();
  server.stderr.destroy();
});

test('sala sem ninguém responde occupied: false', async () => {
  assert.deepEqual(await occupancy('sala-que-nunca-existiu'), { occupied: false });
});

test('sala com gente dentro responde occupied: true', async () => {
  const room = 'sala-ocupada-agora';
  assert.deepEqual(await occupancy(room), { occupied: false });
  await enterEmptyRoom(room, 'Alice');
  assert.deepEqual(await occupancy(room), { occupied: true });
});

test('a resposta não conta nada além do booleano', async () => {
  // Nem nomes, nem quantidade, nem ids: o que o endpoint entrega é a menor
  // informação que faz o aviso da Home existir.
  const room = 'sala-so-booleano';
  const alice = await enterEmptyRoom(room, 'Alice');
  const body = await occupancy(room);
  assert.deepEqual(Object.keys(body), ['occupied']);
  assert.equal(JSON.stringify(body).includes('Alice'), false);
  alice.close();
});

test('a sala some da ocupação quando o último participante sai', async () => {
  const room = 'sala-que-esvazia';
  const alice = await enterEmptyRoom(room, 'Alice');
  assert.deepEqual(await occupancy(room), { occupied: true });

  alice.close();
  // O servidor apaga a sala no `disconnect`; o socket local fecha antes disso.
  const deadline = Date.now() + 3000;
  let body = await occupancy(room);
  while (body.occupied && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    body = await occupancy(room);
  }
  assert.deepEqual(body, { occupied: false }, 'sala vazia continuou marcada como ocupada');
});
