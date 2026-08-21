import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { RoomStore, MAX_PARTICIPANTS } from './rooms.js';
import { fetchCloudflareIceServers, isTurnConfigured } from './turnCredentials.js';
import 'dotenv/config';

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const allowedOrigins = CLIENT_ORIGIN.split(',').map(o => o.trim());
const corsOrigin = allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins;

const app = express();
app.use(cors({ origin: corsOrigin }));
/**
 * `turn.configured` é aditivo: `ok` continua onde estava, e quem só lê `ok` não
 * quebra. É booleano puro — não diz qual token, não valida a credencial e não
 * chama a Cloudflare.
 */
app.get('/health', (_req, res) => res.json({ ok: true, turn: { configured: isTurnConfigured() } }));

/**
 * Short-lived TURN credentials via Cloudflare TURN API — nunca persistidas.
 *
 * Três desfechos, três status. Isto **era** um endpoint que respondia `200
 * {"iceServers": []}` nos três casos, o que tornava um deploy sem
 * `CF_TURN_TOKEN_ID`/`CF_TURN_API_TOKEN` bit-a-bit indistinguível de uma sala
 * saudável — para o client, para um probe externo e para qualquer proxy no
 * caminho. Como o client roda `iceTransportPolicy: 'relay'`, lista vazia é
 * garantia de que nenhuma conexão fecha; anunciá-la como sucesso é a falha
 * silenciosa que esta entrega remove.
 *
 * 503 é "não estou provisionado para servir isto" e 502 é "meu upstream
 * falhou": ações de resposta diferentes, distinguíveis na aba de rede sem
 * ninguém precisar ler log. Nenhuma das mensagens carrega valor de segredo.
 */
app.get('/turn-credentials', async (_req, res) => {
  try {
    const credentials = await fetchCloudflareIceServers();
    if (!credentials) {
      console.error(
        '[turn] /turn-credentials: CF_TURN_TOKEN_ID/CF_TURN_API_TOKEN ausentes — nenhuma conexão vai fechar.',
      );
      return res.status(503).json({
        error: 'turn-unconfigured',
        message: 'Servidor sem credenciais de TURN configuradas.',
      });
    }
    return res.json(credentials);
  } catch (err) {
    console.error('[turn] /turn-credentials: falha no upstream:', err.message);
    return res.status(502).json({
      error: 'turn-upstream',
      message: 'Falha ao obter credenciais de TURN na Cloudflare.',
    });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin },
});

const rooms = new RoomStore();

/**
 * "Já tem gente nesse endereço agora?" — booleano, e nada além disso.
 *
 * Existe para o aviso da Home quando alguém escolhe um endereço personalizado
 * (`/daily`) que já está em uso: sem ele, marcar uma reunião num nome óbvio cai
 * no meio da conversa de outro time, e a única pista é a fila de aprovação
 * deles. Responde `{ occupied }` e mais nada: sem nomes, sem contagem, sem
 * histórico — nada que diga *quem* está lá.
 *
 * Ressalva registrada, porque ela é real: o documento de arquitetura desta
 * entrega (§3.2 e §7) pede para **não** existir endpoint de existência de sala,
 * e `ARCHITECTURE.md` §5 classifica "que um roomId existe" como conhecimento
 * interno do servidor. Com endereços curtos e adivinháveis, isto é, no
 * agregado, um oráculo: varrer uma lista de nomes prováveis diz quais times
 * estão reunidos agora, sem entrar em sala nenhuma. Está aqui porque é item
 * explícito do DoD da WTK-MEET-10, e o commit que o introduz é isolado de
 * propósito — reverter só ele desliga o recurso, e o client trata a falha como
 * "não ocupado" e segue funcionando.
 */
app.get('/rooms/:roomId/occupancy', (req, res) => {
  res.json({ occupied: !rooms.isEmpty(req.params.roomId) });
});
// requesterSocketId -> { roomId, displayName }
// Only holds people waiting on approval; never written anywhere durable.
const pendingJoins = new Map();

function sanitizeDisplayName(name) {
  if (typeof name !== 'string') return 'Guest';
  const trimmed = name.trim().slice(0, 40);
  return trimmed.length > 0 ? trimmed : 'Guest';
}

io.on('connection', (socket) => {
  socket.on('join-request', ({ roomId, displayName } = {}) => {
    if (typeof roomId !== 'string' || roomId.length === 0) {
      socket.emit('join-denied', { reason: 'invalid-room' });
      return;
    }
    const name = sanitizeDisplayName(displayName);

    if (rooms.isFull(roomId)) {
      socket.emit('join-denied', { reason: 'room-full' });
      return;
    }

    if (rooms.isEmpty(roomId)) {
      // First person in — they *are* the room, no approval needed.
      admitToRoom(socket, roomId, name);
      return;
    }

    pendingJoins.set(socket.id, { roomId, displayName: name });
    const approvers = rooms.members(roomId);
    for (const [approverSocketId] of approvers) {
      io.to(approverSocketId).emit('join-request', {
        requesterId: socket.id,
        displayName: name,
      });
    }
  });

  socket.on('approve-join', ({ requesterId } = {}) => {
    const pending = pendingJoins.get(requesterId);
    if (!pending) return; // already handled or expired

    const approverRoom = rooms.findRoomOf(socket.id);
    if (approverRoom !== pending.roomId) return; // spoofed/stale approval

    if (rooms.isFull(pending.roomId)) {
      io.to(requesterId).emit('join-denied', { reason: 'room-full' });
      cancelPendingJoin(requesterId, pending.roomId);
      return;
    }

    const requesterSocket = io.sockets.sockets.get(requesterId);
    if (!requesterSocket) {
      // Requester disconnected while waiting: nobody is coming in, so the
      // approval prompt has to come down on every screen showing it.
      cancelPendingJoin(requesterId, pending.roomId);
      return;
    }

    pendingJoins.delete(requesterId);
    admitToRoom(requesterSocket, pending.roomId, pending.displayName);
  });

  socket.on('deny-join', ({ requesterId } = {}) => {
    const pending = pendingJoins.get(requesterId);
    if (!pending) return;
    const approverRoom = rooms.findRoomOf(socket.id);
    if (approverRoom !== pending.roomId) return;

    cancelPendingJoin(requesterId, pending.roomId);
    io.to(requesterId).emit('join-denied', { reason: 'denied' });
  });

  socket.on('signal', ({ to, data } = {}) => {
    if (typeof to !== 'string') return;
    const myRoom = rooms.findRoomOf(socket.id);
    const targetRoom = rooms.findRoomOf(to);
    if (!myRoom || myRoom !== targetRoom) return; // only relay within same room
    io.to(to).emit('signal', { from: socket.id, data });
  });

  socket.on('leave-room', () => {
    leaveCurrentRoom(socket);
  });

  socket.on('disconnect', () => {
    const pending = pendingJoins.get(socket.id);
    if (pending) cancelPendingJoin(socket.id, pending.roomId);
    leaveCurrentRoom(socket);
  });
});

/**
 * Drops a pending join and tells the room to stop asking about it.
 *
 * Approval is a modal on every member's screen, so a request that can no longer
 * be granted — the requester gave up, closed the tab, or someone else already
 * decided — must be retracted explicitly. Without this the modal would sit there
 * forever with a button that silently does nothing.
 *
 * Only membership metadata travels here: an id that is already public inside the
 * room, and no name, no room contents.
 */
function cancelPendingJoin(requesterId, roomId) {
  pendingJoins.delete(requesterId);
  for (const [memberSocketId] of rooms.members(roomId)) {
    io.to(memberSocketId).emit('join-request-cancelled', { requesterId });
  }
}

function admitToRoom(socket, roomId, displayName) {
  const existingMembers = rooms.members(roomId);
  rooms.addMember(roomId, socket.id, displayName);
  socket.join(roomId);

  socket.emit('join-approved', {
    selfId: socket.id,
    members: existingMembers.map(([id, info]) => ({ id, displayName: info.displayName })),
    maxParticipants: MAX_PARTICIPANTS,
  });

  socket.to(roomId).emit('peer-joined', { peerId: socket.id, displayName });
}

function leaveCurrentRoom(socket) {
  const roomId = rooms.findRoomOf(socket.id);
  if (!roomId) return;
  rooms.removeMember(roomId, socket.id);
  socket.leave(roomId);
  socket.to(roomId).emit('peer-left', { peerId: socket.id });
}

server.listen(PORT, () => {
  console.log(`wtk-meet signaling server listening on :${PORT} (in-memory only, no persistence)`);
  // O aviso é no boot, e não na primeira requisição, porque é no boot que
  // alguém está olhando: subir sem TURN não degrada o produto, desliga-o
  // inteiro (sob `relay` não há plano B), e descobrir isso pelo relato de um
  // usuário custa uma reunião.
  if (!isTurnConfigured()) {
    console.warn(
      '[turn] ATENÇÃO: CF_TURN_TOKEN_ID/CF_TURN_API_TOKEN não configurados. ' +
        'O client usa iceTransportPolicy:"relay" — sem TURN, NENHUMA chamada vai conectar. ' +
        '/turn-credentials responderá 503 e /health reportará turn.configured:false.',
    );
  }
});
