/**
 * O vocabulário do beacon do client — fechado, puro e sem I/O.
 *
 * Este arquivo é a fronteira de privacidade desta entrega, e ele é curto de
 * propósito: **não existe campo para `roomId`, para `displayName` ou para
 * qualquer identificador**, então não existe caminho por onde um deles vaze.
 * A proteção é do tipo, não da disciplina de quem revisa.
 *
 * `parseBeacon` constrói um objeto **novo**, campo a campo, e nunca faz spread
 * do corpo recebido: um beacon com `{ event, route, roomId, ip }` responde 204
 * e o `roomId` some no parse, sem virar atributo de métrica em lugar nenhum.
 *
 * Sem Express, sem `node:http`, sem OTel: roda em `node --test` puro, que é o
 * que permite ao teste do envelope ser instantâneo e exaustivo.
 *
 * **Restrição de linguagem:** o `tsconfig.base.json` liga `erasableSyntaxOnly`,
 * que proíbe `enum`. "Enum fechado" aqui é union type de literais + array
 * `as const` para a validação em runtime.
 */

/** As três telas que emitem page view. Nenhuma delas carrega o endereço da sala. */
export const PAGE_VIEW_ROUTES = ['home', 'room', 'legacy'] as const;
export type PageViewRoute = (typeof PAGE_VIEW_ROUTES)[number];

/**
 * Teto de duração aceita: 24h em milissegundos.
 *
 * Não é sanidade decorativa. Sem teto, um beacon com `durationMs: 1e18` entra
 * no histograma e o `sum` da série fica permanentemente contaminado — e como a
 * temporalidade é cumulativa, o único conserto seria reiniciar o processo.
 */
export const MAX_SESSION_DURATION_MS = 86_400_000;

/** Uma aba viu uma das três telas. */
export interface PageViewBeacon {
  event: 'page_view';
  route: PageViewRoute;
}

/** Uma aba deixou a sala, depois de `durationMs` nela. */
export interface ClientSessionEndBeacon {
  event: 'client_session_end';
  durationMs: number;
}

export type TelemetryBeacon = PageViewBeacon | ClientSessionEndBeacon;

function isRoute(value: unknown): value is PageViewRoute {
  return typeof value === 'string' && (PAGE_VIEW_ROUTES as readonly string[]).includes(value);
}

/**
 * Valida o corpo de `POST /telemetry`. Devolve `null` para tudo que não for
 * exatamente um dos dois envelopes.
 *
 * `null` — e não exceção — porque o chamador precisa responder 400 e contar
 * `rejected`; uma exceção atravessaria para o handler de erro do Express, que
 * loga a mensagem no stderr, e a mensagem do body-parser inclui trecho do corpo
 * recebido (§7.8 do documento). O caminho de erro é justamente o que ninguém
 * olha.
 *
 * `Array.isArray` tem que estar aqui: `typeof [] === 'object'` e `[].event` é
 * `undefined`, então um array chegaria à checagem de `event` sem ser barrado —
 * o que funciona, mas por acidente. A checagem explícita é o que faz o corpo
 * `"[]"` do critério 3 ser um `null` deliberado.
 */
export function parseBeacon(body: unknown): TelemetryBeacon | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;

  const candidate = body as Record<string, unknown>;

  if (candidate.event === 'page_view') {
    if (!isRoute(candidate.route)) return null;
    // Objeto novo: nenhuma chave desconhecida sobrevive a esta linha.
    return { event: 'page_view', route: candidate.route };
  }

  if (candidate.event === 'client_session_end') {
    const durationMs = candidate.durationMs;
    if (typeof durationMs !== 'number') return null;
    if (!Number.isFinite(durationMs)) return null;
    if (durationMs < 0 || durationMs > MAX_SESSION_DURATION_MS) return null;
    return { event: 'client_session_end', durationMs };
  }

  return null;
}
