/**
 * O espelho: uma verdade no motor, N abas olhando.
 *
 * Módulo **puro** — ele não conhece `chrome`, só uma `PortLike` com
 * `postMessage`. É o que permite provar em `node --test` a propriedade que o
 * produto promete: *fila, faixa corrente, posição e favoritos idênticos em todas
 * as abas*, sem abrir navegador nenhum.
 *
 * Três decisões moram aqui:
 *
 * 1. **Snapshot completo no `attach`, deltas depois.** Uma aba que abre no meio
 *    de uma faixa não pode montar a tela a partir de um delta — ela veria
 *    "meio estado". Quem chega recebe tudo; quem já estava recebe só o que
 *    mudou.
 * 2. **Só emite delta do que realmente mudou.** A posição da faixa muda a cada
 *    250 ms; a fila, quase nunca. Comparar antes de enviar é o que mantém o
 *    tráfego entre contextos proporcional ao que aconteceu, e não ao relógio.
 * 3. **Uma porta que falha ao receber é uma porta morta.** `postMessage` numa
 *    porta desconectada lança; engolir o erro e esquecer a porta é o
 *    comportamento correto — o popup fechou, e não há nada a recuperar. Sem
 *    isso, o primeiro popup fechado derruba o envio para todos os outros.
 */

import type { EngineState } from './protocol.js';

/** O mínimo de uma `chrome.runtime.Port` que este módulo usa. */
export interface PortLike {
  name: string;
  postMessage(message: unknown): void;
}

/**
 * Comparação rasa, campo a campo, com um passo a mais para os campos que são
 * array ou objeto: `JSON.stringify` neles.
 *
 * Um `deepEqual` completo seria exagero (o estado é raso e pequeno) e uma
 * comparação por identidade seria insuficiente — o motor reconstrói `queue` a
 * cada recálculo, e mandar a fila inteira a cada tique de posição é exatamente o
 * que a decisão 2 existe para evitar.
 */
function mudou(antes: unknown, depois: unknown): boolean {
  if (antes === depois) return false;
  if (typeof antes === 'object' || typeof depois === 'object') {
    return JSON.stringify(antes ?? null) !== JSON.stringify(depois ?? null);
  }
  return true;
}

/** O que mudou entre dois estados. `null` quando nada mudou. */
export function diffState(antes: EngineState, depois: EngineState): Partial<EngineState> | null {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(depois) as (keyof EngineState)[]) {
    if (mudou(antes[key], depois[key])) patch[key] = depois[key];
  }
  return Object.keys(patch).length ? (patch as Partial<EngineState>) : null;
}

export class UiHub {
  private ports = new Set<PortLike>();

  /** Quantas superfícies estão olhando agora. Zero é o caso comum. */
  get size(): number {
    return this.ports.size;
  }

  /** Registra a porta e manda o estado inteiro nela — nunca um delta. */
  attach(port: PortLike, state: EngineState): void {
    this.ports.add(port);
    this.send(port, { target: 'ui', type: 'state', state });
  }

  detach(port: PortLike): void {
    this.ports.delete(port);
  }

  /** Empurra um delta para todas as portas. No-op quando não há ninguém. */
  broadcast(patch: Partial<EngineState>): void {
    if (!this.ports.size) return;
    const message = { target: 'ui', type: 'patch', patch };
    for (const port of [...this.ports]) this.send(port, message);
  }

  /**
   * Uma mensagem para a UI que **não** é estado: a recusa de uma URL sem CORS, o
   * "estourou o limite", o "o YouTube só existe no app". O texto vem de
   * `SOURCE_ERRORS`/`SOUNDBOARD_ERRORS` — a extensão não inventa texto novo.
   *
   * `only` endereça a resposta a quem perguntou; sem ele, todas as abas veem o
   * aviso (é o certo para o que aconteceu na sala, e não no clique de alguém).
   */
  notice(kind: 'error' | 'info', text: string, only?: PortLike | null): void {
    const message = { target: 'ui', type: 'notice', kind, text };
    if (only) {
      this.send(only, message);
      return;
    }
    for (const port of [...this.ports]) this.send(port, message);
  }

  private send(port: PortLike, message: unknown): void {
    try {
      port.postMessage(message);
    } catch {
      // Porta morta (o popup fechou entre o cálculo e o envio). Esquecer é o
      // tratamento — ver a decisão 3 do cabeçalho.
      this.ports.delete(port);
    }
  }
}
