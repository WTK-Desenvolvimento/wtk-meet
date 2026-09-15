import { randomBytes } from 'node:crypto';

export const MAX_PARTICIPANTS = 6;

/**
 * Janela de graça do token de retorno, contada **a partir da desconexão**.
 *
 * Exportada porque os testes precisam do número sem repeti-lo, e porque a
 * janela é sempre medida com o relógio injetado do `RoomStore` — nenhum teste
 * desta constante espera 60 segundos de relógio de parede.
 *
 * A janela é "há quanto tempo você sumiu", e não "há quanto tempo você entrou":
 * o `expiresAt` de uma entrada nasce `null` e só vira prazo quando aquele
 * socket cai. Uma reunião de duas horas não pode expirar o token de quem está
 * dentro dela.
 */
export const RESUME_GRACE_MS = 60_000;

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

/**
 * Uma admissão que pode ser retomada sem nova aprovação.
 *
 * Existe **para descrever uma ausência**: o membro não está mais na sala, e é
 * justamente por isso que o registro não pode morar dentro de `Member`. O
 * `socketId` é o do socket que caiu — guardado para provar que ele **não** está
 * mais conectado (regra anti-clone), nunca para reaproveitar identidade.
 *
 * `expiresAt: null` significa "aquele socket ainda está na sala": a entrada
 * existe, mas não é retomável. Só a desconexão a arma.
 */
export interface ResumeEntry {
  roomId: string;
  socketId: string;
  displayName: string;
  expiresAt: number | null;
}

export class RoomStore {
  /** `roomId` → sala. É o único estado do produto, e ele vive só aqui. */
  rooms: Map<string, Room>;

  /** `roomId` → contabilidade de telemetria. Espelha exatamente `rooms`. */
  private meta: Map<string, RoomMeta>;

  /**
   * `token` → admissão retomável. Privado, e de propósito: a única porta de
   * leitura é `consumeResumeToken`, que **deleta** antes de devolver. Um getter
   * de conveniência ao lado dele seria o caminho por onde o uso único vazaria.
   *
   * Mora aqui, e não num `Map` de módulo no `index.ts`, porque a vida dele é a
   * vida da sala: quem deleta a sala é `removeMember`, e é ele que também
   * precisa apagar os tokens dela. De fora, isso viraria um segundo lugar que
   * tem que lembrar de limpar.
   */
  private resumeTokens: Map<string, ResumeEntry>;

  /** Relógio injetável: os testes de duração precisam de tempo determinístico. */
  private now: () => number;

  /**
   * Gerador de token injetável.
   *
   * O default é `randomBytes(32)` — 256 bits, 64 chars hex. A injeção existe
   * para o teste poder nomear os tokens que emite, sem stub de `node:crypto` e
   * sem depender da aleatoriedade para saber qual token é qual.
   */
  private createToken: () => string;

  constructor(
    now: () => number = () => Date.now(),
    createToken: () => string = () => randomBytes(32).toString('hex'),
  ) {
    this.rooms = new Map();
    this.meta = new Map();
    this.resumeTokens = new Map();
    this.now = now;
    this.createToken = createToken;
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

  /**
   * Cadeiras ocupadas, e não pessoas conectadas.
   *
   * A vaga de quem caiu conta durante a graça. Sem isso, quem cai de uma sala
   * de 6 volta e leva `room-full` — a pior versão possível do problema que o
   * token existe para resolver. A consequência é visível e aceita: um
   * desconhecido que chegue nesses 60s pode ser barrado numa sala que mostra 5
   * pessoas.
   */
  isFull(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    return room.size + this.reservedSeats(roomId) >= MAX_PARTICIPANTS;
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
      // E os tokens também. Sala vazia ⇒ nada resta, que é o que mantém o §5 do
      // `ARCHITECTURE.md` literalmente verdadeiro e o que faz "o servidor
      // reiniciou" significar "todo mundo pede aprovação de novo", de graça.
      // Quem voltar para uma sala que não existe mais é o **primeiro** a entrar
      // e é admitido sozinho — comportamento certo, e já existente.
      this.discardRoomTokens(roomId);
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
   *
   * **Não** soma vaga reservada, e isso não é esquecimento: o gauge se chama
   * `wtk_participants_active` e mede gente conectada agora, não cadeiras
   * ocupadas. Misturar as duas coisas faria um painel mentir sobre ocupação
   * real — se um teste de gauge mudar de valor por causa de reserva, a reserva
   * vazou para onde não devia.
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

  // ------------------------------------------------------- token de retorno

  /**
   * Emite o token daquela admissão e invalida o anterior do mesmo socket.
   *
   * Chamado em **toda** admissão — primeira da sala, aprovada e retomada. A
   * rotação é o que impede replay: um token que funcionasse duas vezes seria um
   * convite transferível que não expira ao ser usado, e o dono nem saberia.
   *
   * O valor devolvido só pode ir para um lugar: o `join-approved` do próprio
   * dono. Nunca para log, nunca para atributo de métrica, nunca para broadcast.
   */
  issueResumeToken(roomId: string, socketId: string, displayName: string): string {
    this.sweepExpired(roomId);
    for (const [token, entry] of this.resumeTokens) {
      if (entry.roomId === roomId && entry.socketId === socketId) this.resumeTokens.delete(token);
    }
    const token = this.createToken();
    this.resumeTokens.set(token, { roomId, socketId, displayName, expiresAt: null });
    return token;
  }

  /**
   * Arma a janela de graça do socket que **caiu**.
   *
   * Só a queda (`disconnect`) chega aqui. Quem clicou em "Sair da sala" decidiu
   * sair: reservar a vaga dele por 60s seguraria um lugar num teto de 6 sem que
   * ninguém tivesse pedido.
   */
  armResumeGrace(roomId: string, socketId: string): void {
    const expiresAt = this.now() + RESUME_GRACE_MS;
    for (const entry of this.resumeTokens.values()) {
      if (entry.roomId === roomId && entry.socketId === socketId) entry.expiresAt = expiresAt;
    }
    this.sweepExpired(roomId);
  }

  /**
   * Descarta os tokens daquele socket naquela sala, sem armar nada.
   *
   * É o caminho da saída intencional: sem isto, a entrada não-armada daquele
   * socket ficaria viva até a sala morrer. Ela não é retomável (nasce com
   * `expiresAt: null` e só a queda arma), então isto é higiene de memória e não
   * regra de admissão — mas é a higiene que falta quando uma sala de vida longa
   * tem rotatividade.
   */
  discardResumeTokens(roomId: string, socketId: string): void {
    for (const [token, entry] of this.resumeTokens) {
      if (entry.roomId === roomId && entry.socketId === socketId) this.resumeTokens.delete(token);
    }
  }

  /**
   * Valida, **deleta** e devolve a identidade retomada — ou `null`.
   *
   * A deleção acontece antes do retorno, e não depois da admissão: um `return`
   * antecipado ou uma exceção no meio do caminho deixaria a entrada viva e
   * reutilizável. É a única porta de leitura do registro, exatamente para que
   * esse "antes" não dependa de quem chama lembrar dele.
   *
   * `null` **nunca** significa negar entrada. Significa "este atalho não vale"
   * — o pedido segue para a fila de aprovação de sempre. Um token ruim que
   * negasse entrada criaria uma forma de bloquear alguém plantando lixo no
   * `sessionStorage` dele.
   */
  consumeResumeToken(token: string, roomId: string): { displayName: string } | null {
    const entry = this.resumeTokens.get(token);
    if (!entry) return null;
    // Token de outra sala não abre esta. A sala é parte do que o token prova.
    if (entry.roomId !== roomId) return null;
    // Nunca caiu ⇒ nunca foi armado ⇒ não é retomável. É esta linha que barra a
    // aba duplicada (o `sessionStorage` é copiado, o socket original segue vivo).
    if (entry.expiresAt === null) return null;
    if (this.now() >= entry.expiresAt) {
      this.resumeTokens.delete(token);
      return null;
    }
    const room = this.rooms.get(roomId);
    // Sala que não existe mais: quem volta entra como primeiro, por `admitted`.
    if (!room || room.size === 0) return null;
    // Cinto de segurança contra qualquer caminho que arme a graça sem remover o
    // membro: duas presenças a partir de uma aprovação só seria um clone.
    if (room.has(entry.socketId)) return null;

    this.resumeTokens.delete(token);
    return { displayName: entry.displayName };
  }

  /** Cadeiras guardadas por quem está na graça, naquela sala, agora. */
  private reservedSeats(roomId: string): number {
    const agora = this.now();
    let reserved = 0;
    for (const entry of this.resumeTokens.values()) {
      if (entry.roomId !== roomId) continue;
      if (entry.expiresAt !== null && agora < entry.expiresAt) reserved += 1;
    }
    return reserved;
  }

  /**
   * Varre as entradas vencidas daquela sala.
   *
   * Expiração preguiçosa, sem `setTimeout`: um timer por participante é um
   * handle por participante para cancelar no `disconnect`, no fechamento da
   * sala e no `gracefulShutdown` — e um deles sempre escapa. Aqui a leitura já
   * ignora o que venceu, e a varredura só impede que uma sala de vida longa
   * acumule entradas mortas. É O(tokens da sala), com a sala limitada a 6.
   */
  private sweepExpired(roomId: string): void {
    const agora = this.now();
    for (const [token, entry] of this.resumeTokens) {
      if (entry.roomId !== roomId) continue;
      if (entry.expiresAt !== null && agora >= entry.expiresAt) this.resumeTokens.delete(token);
    }
  }

  /** Todos os tokens da sala, quando a sala deixa de existir. */
  private discardRoomTokens(roomId: string): void {
    for (const [token, entry] of this.resumeTokens) {
      if (entry.roomId === roomId) this.resumeTokens.delete(token);
    }
  }
}
