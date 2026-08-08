export const MAX_PARTICIPANTS = 6;

/**
 * All state lives in memory only. Nothing here is ever written to disk or a
 * database — when a room empties out (last socket leaves/disconnects) it is
 * deleted, and a server restart wipes every room.
 */
export class RoomStore {
  constructor() {
    this.rooms = new Map(); // roomId -> Map<socketId, { displayName }>
  }

  ensureRoom(roomId) {
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, new Map());
    }
    return this.rooms.get(roomId);
  }

  getRoom(roomId) {
    return this.rooms.get(roomId);
  }

  isEmpty(roomId) {
    const room = this.rooms.get(roomId);
    return !room || room.size === 0;
  }

  isFull(roomId) {
    const room = this.rooms.get(roomId);
    return !!room && room.size >= MAX_PARTICIPANTS;
  }

  addMember(roomId, socketId, displayName) {
    const room = this.ensureRoom(roomId);
    room.set(socketId, { displayName });
    return room;
  }

  removeMember(roomId, socketId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.delete(socketId);
    if (room.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  members(roomId) {
    const room = this.rooms.get(roomId);
    return room ? Array.from(room.entries()) : [];
  }

  findRoomOf(socketId) {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.has(socketId)) return roomId;
    }
    return null;
  }
}
