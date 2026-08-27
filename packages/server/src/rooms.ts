export const MAX_PARTICIPANTS = 6;

/**
 * All state lives in memory only. Nothing here is ever written to disk or a
 * database — when a room empties out (last socket leaves/disconnects) it is
 * deleted, and a server restart wipes every room.
 */
/** O que se guarda de cada participante. Só isto — nada de nome real, nada de IP. */
export interface Member {
  displayName: string;
}

/** Uma sala: `socketId` → membro, na ordem de entrada. */
export type Room = Map<string, Member>;

export class RoomStore {
  /** `roomId` → sala. É o único estado do produto, e ele vive só aqui. */
  rooms: Map<string, Room>;

  constructor() {
    this.rooms = new Map();
  }

  ensureRoom(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Map();
      this.rooms.set(roomId, room);
    }
    return room;
  }

  getRoom(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  isEmpty(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    return !room || room.size === 0;
  }

  isFull(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    return !!room && room.size >= MAX_PARTICIPANTS;
  }

  addMember(roomId: string, socketId: string, displayName: string): Room {
    const room = this.ensureRoom(roomId);
    room.set(socketId, { displayName });
    return room;
  }

  removeMember(roomId: string, socketId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.delete(socketId);
    if (room.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  members(roomId: string): [string, Member][] {
    const room = this.rooms.get(roomId);
    return room ? Array.from(room.entries()) : [];
  }

  findRoomOf(socketId: string): string | null {
    for (const [roomId, room] of this.rooms.entries()) {
      if (room.has(socketId)) return roomId;
    }
    return null;
  }
}
