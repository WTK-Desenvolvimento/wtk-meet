/** Cliente WebSocket do signaling. Um emissor de eventos fino, sem mais nada. */

export function createSignaling() {
  /** @type {WebSocket|null} */
  let socket = null;
  /** @type {Map<string, Set<Function>>} */
  const handlers = new Map();

  function emit(type, payload) {
    for (const fn of handlers.get(type) ?? []) fn(payload);
  }

  return {
    connect({ room, name }) {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}`);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({ t: 'join', room, name }));
      });
      socket.addEventListener('message', (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        emit(msg.t, msg);
      });
      socket.addEventListener('close', () => emit('disconnected', {}));
      socket.addEventListener('error', () => emit('socket-error', {}));
    },

    on(type, fn) {
      if (!handlers.has(type)) handlers.set(type, new Set());
      handlers.get(type).add(fn);
      return () => handlers.get(type).delete(fn);
    },

    send(payload) {
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
    },

    close() {
      socket?.close();
      socket = null;
    },
  };
}
