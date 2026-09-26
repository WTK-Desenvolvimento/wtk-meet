/**
 * O cliente de sinalização da extensão — os **mesmos** eventos de
 * `packages/client/src/lib/signaling.ts`, nem um a mais.
 *
 * **Contrato escrito em dois lugares — e o gêmeo é aquele arquivo.** Renomear um
 * evento lá (e no servidor) deixa a extensão silenciosamente fora da sala: o
 * socket conecta, o `join-request` sai com nome que ninguém escuta e o popup fica
 * em "entrando…" para sempre, sem erro. A defesa é o teste de caracterização em
 * `test/signalingContract.test.ts`, que afirma a lista de nomes e falha quando
 * alguém renomeia sem procurar o outro lado. Ver `ARCHITECTURE.md` §4.
 *
 * Por que não importar o módulo do client, já que o resto é reusado: ele importa
 * `../config.ts`, que lê `import.meta.env` e **executa efeitos de módulo na
 * importação** (`configureIceServers`, `configureTelemetry`). Arrastar isso para
 * cá ligaria a extensão ao beacon de telemetria do app — que é justamente o que
 * o §10 do `ARCHITECTURE.md` promete que não acontece fora dele.
 *
 * `transports: ['websocket']` não é ajuste fino: o handshake por *polling* é o
 * único que passa por CORS, e a origem `chrome-extension://<id>` não está na
 * allowlist de nenhum deploy (§11.7).
 */

import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';

/**
 * Os nomes de evento, numa constante só. Existe para o teste de caracterização
 * poder afirmá-los sem instanciar socket nenhum.
 */
export const SIGNALING_EVENTS = {
  out: ['join-request', 'approve-join', 'deny-join', 'signal', 'leave-room'],
  in: [
    'join-approved',
    'join-denied',
    'join-request',
    'join-request-cancelled',
    'peer-joined',
    'peer-left',
    'signal',
  ],
} as const;

/** Tudo que o motor usa da sinalização. Espelha a interface do client. */
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

export function createSignalingClient(signalingUrl: string): SignalingClient {
  const socket = io(signalingUrl, { autoConnect: false, transports: ['websocket'] });

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
