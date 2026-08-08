import { createShareLock } from '../src/lib/share-lock.js';
import { normalizeMessage, normalizeName } from '../src/lib/text.js';

/**
 * Registro de salas em memoria.
 *
 * NAO EXISTE PERSISTENCIA AQUI — nem de mensagens, nem de participantes. Sala
 * vazia e destruida. Isso e requisito do chat efemero, nao um atalho.
 */

const CHAT_BURST = 5; // mensagens...
const CHAT_WINDOW_MS = 3000; // ...por janela

export function createRoomRegistry() {
  /** @type {Map<string, Room>} */
  const rooms = new Map();

  function getOrCreate(roomId) {
    let room = rooms.get(roomId);
    if (!room) {
      room = {
        id: roomId,
        peers: new Map(),
        shareLock: createShareLock(),
      };
      rooms.set(roomId, room);
    }
    return room;
  }

  return {
    join(roomId, peerId, name, socket) {
      const room = getOrCreate(roomId);
      const peer = {
        id: peerId,
        name: normalizeName(name),
        socket,
        state: { cam: false, mic: true, screen: false },
        chatTimestamps: [],
      };
      room.peers.set(peerId, peer);
      return { room, peer };
    },

    leave(roomId, peerId) {
      const room = rooms.get(roomId);
      if (!room) return null;
      const peer = room.peers.get(peerId);
      room.peers.delete(peerId);
      const releasedShare = room.shareLock.release(peerId);
      if (room.peers.size === 0) rooms.delete(roomId); // sala vazia some, historico junto
      return { room, peer, releasedShare };
    },

    get(roomId) {
      return rooms.get(roomId) ?? null;
    },

    /**
     * Verifica limite de tamanho e rajada. O cliente tambem valida, mas o
     * servidor e quem decide — cliente e territorio hostil.
     */
    checkChat(peer, rawText, now) {
      const result = normalizeMessage(rawText);
      if (!result.ok) return { ok: false, reason: result.reason };

      peer.chatTimestamps = peer.chatTimestamps.filter((t) => now - t < CHAT_WINDOW_MS);
      if (peer.chatTimestamps.length >= CHAT_BURST) {
        return { ok: false, reason: 'rate-limit' };
      }
      peer.chatTimestamps.push(now);
      return { ok: true, text: result.text };
    },

    get size() {
      return rooms.size;
    },
  };
}

/** Vista publica de um participante — nunca vaza o socket. */
export function publicPeer(peer) {
  return { id: peer.id, name: peer.name, state: { ...peer.state } };
}
