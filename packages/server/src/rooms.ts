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

/**
 * Contabilidade efêmera de uma sala, para telemetria — e **só** para telemetria.
 *
 * Vive e morre com o `Map` de membros: quando a sala esvazia e é deletada, isto
 * some junto. Nada aqui é durável, nada aqui identifica ninguém, e nada aqui
 * sai do processo como valor — o que sai são agregados (duração, pico) sem
 * label de sala.
 *
 * Por que fica **ao lado** de `Room`, e não dentro de `Member` (divergência
 * consciente em relação ao §4.1 do documento de arquitetura, que sugeria
 * `Member.joinedAt`): `Member` é o estado do produto e é ele que descreve o que
 * o servidor guarda de cada pessoa. Misturar a bookkeeping do observador no
 * mesmo objeto acopla os dois — exatamente o acoplamento que o §3.6 do
 * documento existe para evitar — e mudaria a forma que `test/rooms.test.ts`
 * caracteriza hoje.
 */
interface RoomMeta {
  /** Instante em que a sala nasceu (primeiro membro). */
  openedAt: number;
  /** Maior número de membros simultâneos que a sala já teve. */
  peak: number;
  /** `socketId` → instante de entrada. Nunca lido junto com o `displayName`. */
  joinedAt: Map<string, number>;
}

/** O que o `index.ts` lê no fechamento de uma sala. Números, e só números. */
export interface RoomStats {
  size: number;
  peak: number;
  openedAt: number;
}

export class RoomStore {
  /** `roomId` → sala. É o único estado do produto, e ele vive só aqui. */
  rooms: Map<string, Room>;

  /** `roomId` → contabilidade de telemetria. Espelha exatamente `rooms`. */
  private meta: Map<string, RoomMeta>;

  /** Relógio injetável: os testes de duração precisam de tempo determinístico. */
  private now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.rooms = new Map();
    this.meta = new Map();
    this.now = now;
  }

  ensureRoom(roomId: string): Room {
    let room = this.rooms.get(roomId);
    if (!room) {
      room = new Map();
      this.rooms.set(roomId, room);
      this.meta.set(roomId, { openedAt: this.now(), peak: 0, joinedAt: new Map() });
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
    const meta = this.meta.get(roomId);
    if (meta) {
      // Reentrada do mesmo socket **não** reinicia o relógio: `admitToRoom`
      // sobrescreve o membro (é o caso do `displayName` renomeado), e zerar o
      // `joinedAt` ali faria a sessão daquele socket ser contada em pedaços.
      if (!meta.joinedAt.has(socketId)) meta.joinedAt.set(socketId, this.now());
      if (room.size > meta.peak) meta.peak = room.size;
    }
    return room;
  }

  removeMember(roomId: string, socketId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.delete(socketId);
    this.meta.get(roomId)?.joinedAt.delete(socketId);
    if (room.size === 0) {
      this.rooms.delete(roomId);
      // A contabilidade morre junto com a sala. Quem quiser o tempo de vida
      // precisa ler `roomStats` **antes** de chamar isto — é o que `index.ts`
      // faz, e é o que mantém este método sem saber que telemetria existe.
      this.meta.delete(roomId);
    }
  }

  /**
   * Contabilidade da sala **enquanto ela existe**. `null` depois de deletada.
   *
   * Existe para o `index.ts` ler no instante da saída de alguém, antes de
   * `removeMember`: duração de vida e pico de ocupação não são deriváveis do
   * estado que sobra.
   */
  roomStats(roomId: string): RoomStats | null {
    const room = this.rooms.get(roomId);
    const meta = this.meta.get(roomId);
    if (!room || !meta) return null;
    return { size: room.size, peak: meta.peak, openedAt: meta.openedAt };
  }

  /** Instante em que aquele socket entrou naquela sala, ou `null`. */
  memberJoinedAt(roomId: string, socketId: string): number | null {
    return this.meta.get(roomId)?.joinedAt.get(socketId) ?? null;
  }

  /**
   * O que os `ObservableGauge` leem a cada coleta.
   *
   * Total por construção — só soma `size` de `Map`s, sem I/O e sem `await`.
   * O callback do gauge roda dentro do ciclo de exportação, e um `throw` aqui
   * viraria erro a cada janela, para sempre.
   */
  snapshot(): { rooms: number; participants: number } {
    let participants = 0;
    let occupied = 0;
    for (const room of this.rooms.values()) {
      // Salas vazias não contam. Elas só existem se alguém chamar `ensureRoom`
      // sem entrar em seguida — hoje ninguém chama, e a métrica não deve passar
      // a mentir no dia em que alguém chamar.
      if (room.size === 0) continue;
      occupied += 1;
      participants += room.size;
    }
    return { rooms: occupied, participants };
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
