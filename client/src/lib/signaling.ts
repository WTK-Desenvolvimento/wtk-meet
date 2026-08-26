import { io, type Socket } from 'socket.io-client';
import { SIGNALING_URL } from '../config.js';

/**
 * Thin wrapper over the raw Socket.IO connection. It never carries the
 * E2EE passphrase (that stays in the URL fragment, client-side only) —
 * only room membership metadata and opaque SDP/ICE payloads.
 */
/** Tudo que o `Room` usa da sinalização. */
export interface SignalingClient {
  socket: Socket;
  connect(): void;
  disconnect(): void;
  requestJoin(roomId: string, displayName: string): void;
  approveJoin(requesterId: string): void;
  denyJoin(requesterId: string): void;
  sendSignal(to: string, data: unknown): void;
  leaveRoom(): void;
}

export function createSignalingClient(): SignalingClient {
  const socket = io(SIGNALING_URL, { autoConnect: false });

  return {
    socket,
    connect: () => {
      socket.connect();
    },
    disconnect: () => {
      socket.disconnect();
    },
    requestJoin: (roomId: string, displayName: string) => {
      socket.emit('join-request', { roomId, displayName });
    },
    approveJoin: (requesterId: string) => {
      socket.emit('approve-join', { requesterId });
    },
    denyJoin: (requesterId: string) => {
      socket.emit('deny-join', { requesterId });
    },
    sendSignal: (to: string, data: unknown) => {
      socket.emit('signal', { to, data });
    },
    leaveRoom: () => {
      socket.emit('leave-room');
    },
  };
}
