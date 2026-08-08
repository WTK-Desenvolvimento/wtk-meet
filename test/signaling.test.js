import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

import { start, stop } from '../server/index.js';

/**
 * Integracao de verdade: sobe o servidor e conversa com ele por WebSocket.
 * Cobre o protocolo inteiro menos o que exige um navegador (SDP/ICE de verdade).
 */

let port;

before(async () => {
  ({ port } = await start(0));
});

after(async () => {
  await stop();
});

function connect(room, name) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  const inbox = [];
  const waiters = [];

  socket.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    inbox.push(msg);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].type === msg.t) {
        waiters.splice(i, 1)[0].resolve(msg);
      }
    }
  });

  const client = {
    socket,
    inbox,
    send: (payload) => socket.send(JSON.stringify(payload)),
    /** Espera uma mensagem de um tipo (olhando tambem o que ja chegou). */
    next(type, timeoutMs = 2000) {
      const found = inbox.find((m) => m.t === type && !m.__consumed);
      if (found) {
        found.__consumed = true;
        return Promise.resolve(found);
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout esperando ${type}`)), timeoutMs);
        waiters.push({
          type,
          resolve: (msg) => {
            clearTimeout(timer);
            msg.__consumed = true;
            resolve(msg);
          },
        });
      });
    },
    close: () => socket.close(),
  };

  return new Promise((resolve) => {
    socket.on('open', () => {
      client.send({ t: 'join', room, name });
      resolve(client);
    });
  });
}

test('quem entra recebe a lista de quem ja estava; quem estava e avisado', async () => {
  const ana = await connect('sala-a', 'Ana');
  const welcomeAna = await ana.next('welcome');
  assert.equal(welcomeAna.peers.length, 0);
  assert.equal(welcomeAna.self.name, 'Ana');

  const bruno = await connect('sala-a', 'Bruno');
  const welcomeBruno = await bruno.next('welcome');
  assert.equal(welcomeBruno.peers.length, 1);
  assert.equal(welcomeBruno.peers[0].name, 'Ana');

  const aviso = await ana.next('peer-join');
  assert.equal(aviso.peer.name, 'Bruno');

  ana.close();
  bruno.close();
});

test('a saida e anunciada aos que ficam', async () => {
  const ana = await connect('sala-b', 'Ana');
  await ana.next('welcome');
  const bruno = await connect('sala-b', 'Bruno');
  await bruno.next('welcome');
  await ana.next('peer-join');

  bruno.close();
  const leave = await ana.next('peer-leave');
  assert.equal(leave.peer.name, 'Bruno');
  ana.close();
});

test('mensagem de chat chega a todos, inclusive ao remetente', async () => {
  const ana = await connect('sala-c', 'Ana');
  await ana.next('welcome');
  const bruno = await connect('sala-c', 'Bruno');
  await bruno.next('welcome');

  ana.send({ t: 'chat', text: 'bom dia <b>pessoal</b>' });

  const recebidaBruno = await bruno.next('chat');
  const recebidaAna = await ana.next('chat');
  assert.equal(recebidaBruno.from.name, 'Ana');
  // O texto trafega cru; quem escapa e a renderizacao (textContent no cliente).
  assert.equal(recebidaBruno.text, 'bom dia <b>pessoal</b>');
  assert.equal(recebidaAna.id, recebidaBruno.id);

  ana.close();
  bruno.close();
});

test('quem entra depois NAO recebe o historico — o chat e efemero', async () => {
  const ana = await connect('sala-d', 'Ana');
  await ana.next('welcome');
  ana.send({ t: 'chat', text: 'segredo dito antes' });
  await ana.next('chat');

  const bruno = await connect('sala-d', 'Bruno');
  await bruno.next('welcome');
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(
    bruno.inbox.filter((m) => m.t === 'chat').length,
    0,
    'nenhuma mensagem anterior pode ser entregue',
  );

  ana.close();
  bruno.close();
});

test('mensagem longa demais e recusada pelo servidor', async () => {
  const ana = await connect('sala-e', 'Ana');
  await ana.next('welcome');
  ana.send({ t: 'chat', text: 'x'.repeat(5000) });
  const rejeicao = await ana.next('chat-rejected');
  assert.equal(rejeicao.reason, 'muito-longa');
  ana.close();
});

test('so um compartilhamento de tela por vez', async () => {
  const ana = await connect('sala-f', 'Ana');
  await ana.next('welcome');
  const bruno = await connect('sala-f', 'Bruno');
  await bruno.next('welcome');

  ana.send({ t: 'share-request' });
  await ana.next('share-granted');
  const estado = await bruno.next('share-state');
  assert.equal(estado.holder.name, 'Ana');

  bruno.send({ t: 'share-request' });
  const negado = await bruno.next('share-denied');
  assert.equal(negado.holder.name, 'Ana');

  ana.send({ t: 'share-stop' });
  const liberado = await bruno.next('share-state');
  assert.equal(liberado.holder, null);

  bruno.send({ t: 'share-request' });
  await bruno.next('share-granted');

  ana.close();
  bruno.close();
});

test('a trava de tela e liberada se quem compartilha cair', async () => {
  const ana = await connect('sala-g', 'Ana');
  await ana.next('welcome');
  const bruno = await connect('sala-g', 'Bruno');
  await bruno.next('welcome');

  ana.send({ t: 'share-request' });
  await ana.next('share-granted');
  await bruno.next('share-state');

  ana.close();
  await bruno.next('peer-leave');
  const liberado = await bruno.next('share-state');
  assert.equal(liberado.holder, null);

  bruno.close();
});

test('mudanca de estado de camera/microfone e propagada', async () => {
  const ana = await connect('sala-h', 'Ana');
  await ana.next('welcome');
  const bruno = await connect('sala-h', 'Bruno');
  await bruno.next('welcome');

  ana.send({ t: 'state', patch: { cam: true, mic: false } });
  const estado = await bruno.next('peer-state');
  assert.equal(estado.state.cam, true);
  assert.equal(estado.state.mic, false);

  ana.close();
  bruno.close();
});

test('SDP e ICE sao repassados apenas ao destinatario', async () => {
  const ana = await connect('sala-i', 'Ana');
  const welcomeAna = await ana.next('welcome');
  const bruno = await connect('sala-i', 'Bruno');
  const welcomeBruno = await bruno.next('welcome');
  const caio = await connect('sala-i', 'Caio');
  await caio.next('welcome');

  ana.send({
    t: 'signal',
    to: welcomeBruno.self.id,
    data: { description: { type: 'offer', sdp: 'v=0' } },
  });

  const sinal = await bruno.next('signal');
  assert.equal(sinal.from, welcomeAna.self.id);
  assert.equal(sinal.data.description.sdp, 'v=0');
  assert.equal(caio.inbox.filter((m) => m.t === 'signal').length, 0, 'terceiro nao ve o sinal');

  ana.close();
  bruno.close();
  caio.close();
});

test('salas diferentes nao se enxergam', async () => {
  const ana = await connect('sala-x', 'Ana');
  await ana.next('welcome');
  const bruno = await connect('sala-y', 'Bruno');
  await bruno.next('welcome');
  bruno.send({ t: 'chat', text: 'oi' });
  await bruno.next('chat');
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(ana.inbox.filter((m) => m.t === 'chat').length, 0);
  assert.equal(ana.inbox.filter((m) => m.t === 'peer-join').length, 0);

  ana.close();
  bruno.close();
});
