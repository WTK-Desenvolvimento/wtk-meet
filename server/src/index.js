import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { RoomStore, MAX_PARTICIPANTS } from './rooms.js';
import { issueTurnCredentials } from './turnCredentials.js';

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Short-lived TURN credentials (HMAC over a shared secret) — never a static
// username/password, never persisted. STUN URL is public info, no auth needed.
app.get('/turn-credentials', (_req, res) => {
  const stunUrl = process.env.STUN_URL || null;
  const turn = issueTurnCredentials();
  res.json({ stunUrl, turn });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: CLIENT_ORIGIN },
});

const rooms = new RoomStore();
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
      pendingJoins.delete(requesterId);
      return;
    }

    pendingJoins.delete(requesterId);
    const requesterSocket = io.sockets.sockets.get(requesterId);
    if (!requesterSocket) return; // requester disconnected while waiting
    admitToRoom(requesterSocket, pending.roomId, pending.displayName);
  });

  socket.on('deny-join', ({ requesterId } = {}) => {
    const pending = pendingJoins.get(requesterId);
    if (!pending) return;
    const approverRoom = rooms.findRoomOf(socket.id);
    if (approverRoom !== pending.roomId) return;

    pendingJoins.delete(requesterId);
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
    pendingJoins.delete(socket.id);
    leaveCurrentRoom(socket);
  });
});

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
});
