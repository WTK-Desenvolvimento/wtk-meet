import { io } from 'socket.io-client';
import { SIGNALING_URL } from '../config.js';

/**
 * Thin wrapper over the raw Socket.IO connection. It never carries the
 * E2EE passphrase (that stays in the URL fragment, client-side only) —
 * only room membership metadata and opaque SDP/ICE payloads.
 */
export function createSignalingClient() {
  const socket = io(SIGNALING_URL, { autoConnect: false });

  return {
    socket,
    connect: () => socket.connect(),
    disconnect: () => socket.disconnect(),
    requestJoin: (roomId, displayName) =>
      socket.emit('join-request', { roomId, displayName }),
    approveJoin: (requesterId) => socket.emit('approve-join', { requesterId }),
    denyJoin: (requesterId) => socket.emit('deny-join', { requesterId }),
    sendSignal: (to, data) => socket.emit('signal', { to, data }),
    leaveRoom: () => socket.emit('leave-room'),
  };
}
