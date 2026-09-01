/**
 * O beacon anônimo do client — o que a aba conta, e o que ela se recusa a saber.
 *
 * Duas perguntas justificam a existência deste módulo, e são exatamente as duas
 * que o servidor **não** consegue responder sozinho: quem abriu a Home e
 * desistiu (nenhum socket é criado nesse caminho), e quanto tempo a aba ficou
 * na sala depois que o socket caiu.
 *
 * Nada além disso é medido, e a lista do que **não** existe aqui é o contrato:
 *
 * - Nenhum identificador. Nem cookie, nem `localStorage`, nem `sessionStorage`,
 *   nem UUID de aba, nem hash de sala. Este módulo não chama
 *   `crypto.randomUUID` e não chama `Math.random` — e há um teste que reprova
 *   se ele encostar em qualquer um deles. É por isso que não há banner de
 *   consentimento: a base legal para banner é o armazenamento/leitura de
 *   informação no terminal e o tratamento de dado pessoal, e um contador de
 *   page views por rota, sem identificador, não é nenhum dos dois.
 * - Nenhum endereço de sala. O corpo do beacon de `Room` é
 *   `{ event, durationMs }` — não existe campo para o slug, para o fragmento da
 *   URL (que carrega a passphrase) nem para o `displayName`.
 * - Nenhuma conversa com a stack de monitoramento. O destino é o **próprio
 *   servidor de sinalização**, com quem a aba já fala. O navegador nunca vê o
 *   endereço do collector.
 *
 * **Reintroduzir qualquer identificador — inclusive "só um id de sessão para
 * deduplicar" — reabre a exigência de consentimento e invalida esta decisão.
 * Quem reintroduzir tem que trazer o banner junto.**
 *
 * Puro no mesmo sentido de `lib/iceServers.ts`: sem `import.meta.env` e sem DOM
 * implícito. Transporte e relógio são injetáveis, os defaults só são resolvidos
 * quando existe `navigator`/`Date`, e por isso o módulo roda em `node --test`
 * sem jsdom. Quem conhece a URL do servidor e o ambiente é `config.ts`.
 */

/** As três telas. Espelha o enum fechado de `server/src/telemetryEvents.ts`. */
export type TelemetryRoute = 'home' | 'room' | 'legacy';

/** O corpo que viaja. Fechado: não há terceiro envelope, e não há campo extra. */
export type TelemetryBeacon =
  | { event: 'page_view'; route: TelemetryRoute }
  | { event: 'client_session_end'; durationMs: number };

/**
 * O transporte. Devolve `void` de propósito: telemetria é dispara-e-esquece, e
 * uma promise aqui viraria um `unhandledrejection` no `pagehide` de uma aba que
 * está morrendo.
 */
export type TelemetrySend = (endpoint: string, body: string) => void;

export interface TelemetryConfig {
  endpoint?: string | null;
  /**
   * `false` desliga **antes** de qualquer efeito: nenhuma requisição sai do
   * navegador, e o transporte injetado nunca é chamado.
   */
  enabled?: boolean;
  send?: TelemetrySend | null;
  now?: () => number;
}

/** O que `startSession` devolve. `end` é idempotente: a segunda chamada não faz nada. */
export interface TelemetrySession {
  end(): void;
}

let endpoint: string | null = null;
let enabled = false;
let sendImpl: TelemetrySend | null = null;
let clock: () => number = () => Date.now();

/**
 * O transporte default, com fallback — e o `text/plain` é a decisão que faz a
 * telemetria do client funcionar em vez de sumir.
 *
 * `text/plain;charset=UTF-8` é um Content-Type *CORS-safelisted*: a requisição
 * é simples e **não gera preflight**. Um `Blob` de `application/json` faria o
 * navegador tentar um `OPTIONS` antes — e no `pagehide`, com a aba morrendo, o
 * preflight frequentemente não completa e o beacon é descartado em silêncio. O
 * sintoma seria "o page view da Home aparece, o fim de sessão nunca", com zero
 * erro no console de quem investiga. O servidor sabe disso e valida o
 * **conteúdo**, não o cabeçalho.
 *
 * `keepalive: true` no fallback pelo mesmo motivo: sem ele, o `fetch` é
 * cancelado junto com o documento.
 */
function defaultSend(url: string, body: string): void {
  try {
    const nav = typeof navigator === 'undefined' ? null : navigator;
    if (nav?.sendBeacon) {
      const blob = new Blob([body], { type: 'text/plain;charset=UTF-8' });
      if (nav.sendBeacon(url, blob)) return;
    }
    if (typeof fetch === 'function') {
      void fetch(url, {
        method: 'POST',
        body,
        keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      }).catch(() => {
        // Servidor fora do ar não pode virar erro no console de quem só queria
        // entrar numa reunião.
      });
    }
  } catch {
    // Idem: nenhum caminho deste módulo pode lançar para dentro de um render.
  }
}

/**
 * Liga o módulo. Chamado uma vez, por `config.ts`, no load da aplicação.
 *
 * `enabled` chega como booleano já resolvido — a comparação com a **string**
 * `'false'` do `import.meta.env` mora em `config.ts`, e não aqui, porque
 * `import.meta.env.VITE_TELEMETRY_ENABLED` é string e `if ('false')` é `true`.
 */
export function configureTelemetry({
  endpoint: url = null,
  enabled: on = true,
  send = null,
  now = () => Date.now(),
}: TelemetryConfig = {}): void {
  endpoint = url;
  enabled = on === true && typeof url === 'string' && url.length > 0;
  sendImpl = send;
  clock = now;
}

/** Só para teste: volta ao estado de antes de qualquer configuração. */
export function resetTelemetry(): void {
  endpoint = null;
  enabled = false;
  sendImpl = null;
  clock = () => Date.now();
}

/** `true` quando um beacon sairia daqui. Existe para o teste e para diagnóstico. */
export function isTelemetryEnabled(): boolean {
  return enabled;
}

/**
 * Dispara e esquece. Nunca lança, nunca devolve promise que alguém precise
 * tratar — o chamador é um `useEffect` de página.
 */
function emit(beacon: TelemetryBeacon): void {
  if (!enabled || !endpoint) return;
  try {
    // `JSON.stringify` do objeto **construído aqui**: nada do estado da página
    // atravessa esta linha por acidente.
    (sendImpl ?? defaultSend)(endpoint, JSON.stringify(beacon));
  } catch {
    // Um transporte injetado que rejeite não pode derrubar a página.
  }
}

/** Uma das três telas foi montada. Nenhuma delas informa qual sala. */
export function trackPageView(route: TelemetryRoute): void {
  emit({ event: 'page_view', route });
}

/**
 * Começa a contar o tempo de uma aba na sala.
 *
 * `end` é idempotente porque há **dois** gatilhos legítimos e eles se
 * sobrepõem: o unmount do React e o `pagehide` da aba. Sem idempotência, fechar
 * a aba de dentro de uma sala contaria a mesma sessão duas vezes — e, pior, com
 * durações diferentes.
 *
 * Devolve um objeto mesmo com a telemetria desligada: o call site não deve
 * precisar de um `if`, e um `null` aqui viraria um `?.` esquecido em algum
 * lugar.
 */
export function startSession(): TelemetrySession {
  const startedAt = clock();
  let ended = false;
  return {
    end(): void {
      if (ended) return;
      ended = true;
      const durationMs = clock() - startedAt;
      // Relógio que anda para trás (ajuste de horário, suspensão) produziria
      // duração negativa, que o servidor recusa com 400. Barrar aqui evita um
      // beacon que só serve para virar `rejected`.
      if (!Number.isFinite(durationMs) || durationMs < 0) return;
      emit({ event: 'client_session_end', durationMs });
    },
  };
}
