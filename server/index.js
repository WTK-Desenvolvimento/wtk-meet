import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

import { createRoomRegistry, publicPeer } from './rooms.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PORT = Number(process.env.PORT ?? 5173);

// Em producao servimos o bundle; em dev servimos o fonte direto (ESM nativo,
// sem passo de build no caminho critico).
const staticRoot = fs.existsSync(path.join(DIST, 'index.html')) ? DIST : ROOT;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = path.join(staticRoot, decodeURIComponent(url.pathname));

  // Barreira de path traversal.
  if (!filePath.startsWith(staticRoot)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  const missing = !fs.existsSync(filePath);
  if (missing || fs.statSync(filePath).isDirectory()) {
    // Fallback para o index so em rotas de navegacao. Um asset inexistente
    // precisa devolver 404, senao o navegador recebe HTML no lugar de JS e o
    // erro aparece como uma falha de sintaxe indecifravel.
    if (missing && path.extname(filePath)) {
      res.writeHead(404).end('Not found');
      return;
    }
    filePath = path.join(staticRoot, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404).end('Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME[path.extname(filePath)] ?? 'application/octet-stream',
    'Cache-Control': 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server });
const registry = createRoomRegistry();

function send(socket, payload) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
}

function broadcast(room, payload, exceptId = null) {
  for (const peer of room.peers.values()) {
    if (peer.id !== exceptId) send(peer.socket, payload);
  }
}

wss.on('connection', (socket) => {
  const peerId = randomUUID();
  let roomId = null;

  socket.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.t !== 'string') return;

    // --- entrada na sala ---------------------------------------------------
    if (msg.t === 'join') {
      if (roomId) return;
      roomId = String(msg.room ?? 'wtk').slice(0, 64);
      const { room, peer } = registry.join(roomId, peerId, msg.name, socket);

      send(socket, {
        t: 'welcome',
        self: publicPeer(peer),
        peers: [...room.peers.values()].filter((p) => p.id !== peerId).map(publicPeer),
        sharer: room.shareLock.holder,
      });
      // Os que ja estavam na sala e que iniciam a oferta — regra fixa que
      // elimina glare sem precisar de perfect negotiation.
      broadcast(room, { t: 'peer-join', peer: publicPeer(peer) }, peerId);
      return;
    }

    const room = roomId ? registry.get(roomId) : null;
    if (!room) return;
    const peer = room.peers.get(peerId);
    if (!peer) return;

    switch (msg.t) {
      // --- relay de SDP/ICE ------------------------------------------------
      case 'signal': {
        const target = room.peers.get(msg.to);
        if (target) send(target.socket, { t: 'signal', from: peerId, data: msg.data });
        break;
      }

      // --- estado de midia (cam/mic/tela) ----------------------------------
      case 'state': {
        const patch = msg.patch ?? {};
        for (const key of ['cam', 'mic', 'screen']) {
          if (typeof patch[key] === 'boolean') peer.state[key] = patch[key];
        }
        broadcast(room, { t: 'peer-state', id: peerId, state: { ...peer.state } }, peerId);
        break;
      }

      // --- trava de compartilhamento de tela --------------------------------
      case 'share-request': {
        const result = room.shareLock.acquire({ id: peerId, name: peer.name });
        if (!result.ok) {
          send(socket, { t: 'share-denied', holder: result.holder });
          break;
        }
        peer.state.screen = true;
        send(socket, { t: 'share-granted' });
        broadcast(room, { t: 'share-state', holder: room.shareLock.holder });
        break;
      }

      case 'share-stop': {
        if (room.shareLock.release(peerId)) {
          peer.state.screen = false;
          broadcast(room, { t: 'share-state', holder: null });
        }
        break;
      }

      // --- chat efemero ------------------------------------------------------
      case 'chat': {
        const check = registry.checkChat(peer, msg.text, Date.now());
        if (!check.ok) {
          send(socket, { t: 'chat-rejected', reason: check.reason });
          break;
        }
        // Repassado e esquecido. Nada e gravado.
        broadcast(room, {
          t: 'chat',
          id: randomUUID(),
          from: { id: peerId, name: peer.name },
          text: check.text,
        });
        break;
      }

      default:
        break;
    }
  });

  socket.on('close', () => {
    if (!roomId) return;
    const result = registry.leave(roomId, peerId);
    if (!result?.peer) return;
    const { room, peer, releasedShare } = result;
    broadcast(room, { t: 'peer-leave', peer: { id: peer.id, name: peer.name } });
    if (releasedShare) broadcast(room, { t: 'share-state', holder: null });
  });
});

/** Exportado para os testes de integracao subirem o servidor numa porta livre. */
export function start(port = PORT) {
  return new Promise((resolve) => {
    server.listen(port, () => resolve({ server, port: server.address().port }));
  });
}

export function stop() {
  return new Promise((resolve) => {
    wss.clients.forEach((client) => client.terminate());
    wss.close(() => server.close(resolve));
  });
}

// Auto-start apenas quando executado direto (`npm run dev`).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  start().then(({ port }) => {
    process.stdout.write(`wtk-meet em http://localhost:${port} (servindo ${path.basename(staticRoot)})\n`);
  });
}
