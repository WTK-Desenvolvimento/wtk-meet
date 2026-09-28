import { io, type Socket } from 'socket.io-client';
import { SIGNALING_URL } from '../config.js';
import {
  clearResumeToken,
  readResumeToken,
  writeResumeToken,
  type ResumeStorage,
} from './resumeToken.js';

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
  leaveRoom(roomId: string): void;
}

export interface SignalingOptions {
  /**
   * Onde o token de retorno mora. Default: o `sessionStorage` da aba.
   *
   * Injetável para que o ciclo do token (grava no `join-approved`, reenvia no
   * `join-request`, apaga na saída) seja testável em `node --test` sem jsdom.
   */
  storage?: ResumeStorage | null;
}

/**
 * O `sessionStorage` da aba, ou `null` fora do navegador.
 *
 * O acesso à propriedade em si já pode lançar (modo privado, política de
 * cookies de terceiros), e isso não pode derrubar a criação do client — sem
 * storage o produto só perde a retomada, que é um atalho.
 */
function defaultStorage(): ResumeStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * O token de retorno é responsabilidade **deste** módulo, e não do `Room`.
 *
 * Divergência consciente em relação ao §4 do documento de arquitetura, que
 * punha a gravação no handler de `join-approved` do `Room.tsx`: lá ela só seria
 * exercitável com jsdom, e o DoD pede o teste sem jsdom. Aqui os três momentos
 * do ciclo — gravar na admissão, reenviar na reconexão, apagar na saída — ficam
 * no mesmo objeto, com a `Storage` injetada, e o `Room` não precisa saber que
 * existe token. O motivo está registrado em `docs/progress/WTK-MEET-25.md`.
 */
export function createSignalingClient(options: SignalingOptions = {}): SignalingClient {
  const socket = io(SIGNALING_URL, { autoConnect: false });
  const storage = options.storage === undefined ? defaultStorage() : options.storage;

  /**
   * A sala do último `join-request`, porque o `join-approved` não diz de qual
   * sala ele é — e a chave do token é por sala, de propósito: é o que impede o
   * token da sala A de ser apresentado na B.
   */
  let currentRoomId: string | null = null;
  let hasConnected = false;

  socket.on('connect', () => {
    hasConnected = true;
  });

  socket.on('join-approved', (payload: { resumeToken?: unknown } = {}) => {
    if (!currentRoomId) return;
    // Rotação: o servidor emite um token novo a cada admissão e invalida o
    // anterior na hora, então sobrescrever é o que mantém os dois lados de
    // acordo. Um payload sem token (servidor antigo) não apaga o que havia —
    // `writeResumeToken` ignora o que não é string não-vazia.
    writeResumeToken(storage, currentRoomId, payload?.resumeToken);
  });

  return {
    socket,
    connect: () => {
      socket.connect();
    },
    disconnect: () => {
      socket.disconnect();
    },
    requestJoin: (roomId: string, displayName: string) => {
      currentRoomId = roomId;
      const resumeToken = readResumeToken(storage, roomId);
      // O campo só entra no payload quando existe: um `resumeToken: null` no
      // fio seria ruído, e o servidor trata ausente e inválido do mesmo jeito.
      socket.emit('join-request', resumeToken ? { roomId, displayName, resumeToken } : { roomId, displayName });
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
    /**
     * Saída intencional: o token daquela sala deixa de existir na aba.
     *
     * A guarda usa `hasConnected`, não `socket.connected`. Em desenvolvimento,
     * o `React.StrictMode` monta → limpa → monta: na limpeza fantasma o socket
     * ainda não conectou (`hasConnected === false`), então o token sobrevive para
     * a segunda montagem. Na saída real — inclusive quando o socket caiu antes de
     * o usuário clicar "Sair" — `hasConnected` é `true`, e a chave some.
     */
    leaveRoom: (roomId: string) => {
      if (!hasConnected) return;
      if (socket.connected) socket.emit('leave-room');
      clearResumeToken(storage, roomId);
    },
  };
}
