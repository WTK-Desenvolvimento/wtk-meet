import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';
import { RoomStore, MAX_PARTICIPANTS } from './rooms.js';
import { fetchCloudflareIceServers } from './turnCredentials.js';
import 'dotenv/config';

const PORT = process.env.PORT || 4000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const allowedOrigins = CLIENT_ORIGIN.split(',').map(o => o.trim());
const corsOrigin = allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins;

const app = express();
app.use(cors({ origin: corsOrigin }));
app.get('/health', (_req, res) => res.json({ ok: true }));

// Short-lived TURN credentials via Cloudflare TURN API — nunca persistidas.
app.get('/turn-credentials', async (_req, res) => {
  try {
    const iceServers = await fetchCloudflareIceServers();
    res.json({ iceServers: iceServers ?? [] });
  } catch (err) {
    console.error('TURN credentials error:', err.message);
    res.json({ iceServers: [] });
  }
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin },
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
});
