/**
 * O lado da UI da conversa com o motor — usado pelo popup e pela página
 * `manager`, com o mesmo código nos dois.
 *
 * **Porta, e não `sendMessage`.** `chrome.runtime.sendMessage` sem receptor
 * rejeita com *"Could not establish connection. Receiving end does not exist"* —
 * o erro mais frequente de extensão MV3 — e cada tentativa do motor de empurrar
 * estado com o popup fechado viraria um `unhandledrejection`. A porta resolve
 * isso por construção: ela existe ou não existe, e `onDisconnect` avisa. De
 * quebra, a posição da faixa (que muda a cada 250 ms) só é calculada e enviada
 * quando há alguém olhando.
 *
 * A ordem importa: **primeiro** `ensure-engine` no service worker (que cria o
 * documento offscreen), **depois** a porta. Conectar antes é conectar a um
 * `onConnect` que ainda não tem listener.
 */

import { PORT_NAME, emptyState, isFor } from '../lib/protocol.js';
import type { EngineCommand, EngineState, NoticeMessage, PrefillMessage } from '../lib/protocol.js';

export interface EngineClientHandlers {
  onState(state: EngineState): void;
  onNotice(notice: { kind: 'error' | 'info'; text: string }): void;
  /** O motor caiu (documento offscreen fechado pelo Chrome, por exemplo). */
  onLost(): void;
}

export class EngineClient {
  // `ChromePort` é a interface global de `src/types/chrome.d.ts`.
  private port: ChromePort | null = null;
  private state: EngineState = emptyState();
  /**
   * Comandos disparados antes de a porta abrir.
   *
   * `start()` é assíncrono (ele espera o service worker garantir o motor), e uma
   * página é clicável antes disso — clicar em "adicionar à fila" um instante
   * depois de abrir a `manager` caía num `this.port?.postMessage` e sumia. Um
   * botão que não faz nada, sem erro, é a pior forma de perder um comando.
   */
  private pendentes: EngineCommand[] = [];
  private handlers: EngineClientHandlers;

  constructor(handlers: EngineClientHandlers) {
    this.handlers = handlers;
  }

  async start(): Promise<void> {
    await chrome.runtime.sendMessage({ target: 'sw', type: 'ensure-engine' });
    const port = chrome.runtime.connect({ name: PORT_NAME });
    this.port = port;

    port.onMessage.addListener((message) => {
      if (!isFor('ui', message)) return;
      if (message.type === 'state') {
        this.state = message.state;
        this.handlers.onState(this.state);
        return;
      }
      if (message.type === 'patch') {
        // O delta vem por cima do que já havia: é isso que faz a posição da
        // faixa andar sem reenviar a fila inteira a cada 250 ms.
        this.state = { ...this.state, ...message.patch };
        this.handlers.onState(this.state);
        return;
      }
      if (message.type === 'notice') {
        const notice = message as NoticeMessage;
        this.handlers.onNotice({ kind: notice.kind, text: notice.text });
      }
    });

    port.onDisconnect.addListener(() => {
      this.port = null;
      this.handlers.onLost();
    });

    for (const comando of this.pendentes.splice(0)) port.postMessage(comando);
  }

  send(command: EngineCommand): void {
    if (!this.port) {
      this.pendentes.push(command);
      return;
    }
    this.port.postMessage(command);
  }

  /** O endereço sugerido para o campo de sala. Só o service worker sabe. */
  static async prefill(): Promise<PrefillMessage> {
    const response = (await chrome.runtime.sendMessage({ target: 'sw', type: 'prefill' })) as
      | PrefillMessage
      | undefined;
    return (
      response ?? { target: 'ui', type: 'prefill', value: '', fromMeet: false, notice: null }
    );
  }

  static openManager(): void {
    void chrome.runtime.sendMessage({ target: 'sw', type: 'open-manager' });
  }
}
