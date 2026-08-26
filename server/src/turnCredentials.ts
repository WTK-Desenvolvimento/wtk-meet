const CF_API_URL = 'https://rtc.live.cloudflare.com/v1/turn/keys';

/**
 * TTL da credencial efêmera, em segundos.
 *
 * O default era 86400 (24h) e isso contradizia `docs/architecture.md` §7
 * ("credenciais efêmeras … TTL curto, ex. 1h"). Vinte e quatro horas é também a
 * janela exata do defeito que esta entrega corrige: uma aba aberta ontem criava
 * `RTCPeerConnection` nova com credencial vencida, e como o client roda
 * `iceTransportPolicy: 'relay'`, credencial vencida significa zero candidato —
 * conexão que nunca fecha, sem log e sem UI. Agora que o client renova sozinho
 * (`client/src/lib/iceServers.js`), TTL curto não custa nada em usabilidade e
 * encurta tanto a janela de credencial morta quanto o raio de dano de um
 * vazamento.
 *
 * O piso existe porque abaixo de 10 minutos a renovação começa a competir com a
 * duração de uma negociação; o teto é o máximo que a Cloudflare aceita.
 */
export const DEFAULT_TTL = 3600;
export const MIN_TTL = 600;
export const MAX_TTL = 86400;

/** Timeout da chamada à Cloudflare. Ver `resolveTimeoutMs`. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Troca qualquer ocorrência dos segredos por `***`.
 *
 * A mensagem de erro de um `fetch` pode carregar a URL, e a URL da Cloudflare
 * carrega o `CF_TURN_TOKEN_ID` no caminho. Como toda mensagem daqui termina em
 * log de servidor (e o log de servidor termina em algum agregador), a
 * sanitização é feita na saída, não na confiança de que nenhum caminho vaza.
 */
/** As variáveis que este módulo lê. Um subconjunto de `process.env`. */
export interface TurnEnv {
  CF_TURN_TOKEN_ID?: string | undefined;
  CF_TURN_API_TOKEN?: string | undefined;
  CF_TURN_TTL?: string | undefined;
  CF_TURN_TIMEOUT_MS?: string | undefined;
}

/** Um item de `iceServers`, como a Cloudflare o devolve. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** Credencial obtida. `ttl` é autoritativo; `expiresAt` é informativo. */
export interface TurnCredentials {
  iceServers: IceServer[];
  ttl: number;
  expiresAt: string;
}

/** A mensagem de um erro capturado — sob `strict`, o `catch` entrega `unknown`. */
function mensagemDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function redact(message: unknown, env: TurnEnv): string {
  let out = String(message ?? '');
  for (const secret of [env.CF_TURN_TOKEN_ID, env.CF_TURN_API_TOKEN]) {
    if (secret) out = out.split(secret).join('***');
  }
  return out;
}

/**
 * "As duas variáveis estão presentes?" — booleano, e nada além disso.
 *
 * Serve ao `/health`: um deploy sem as credenciais respondia `{"ok":true}`
 * alegremente enquanto nenhuma chamada da instância conseguia conectar. Lê
 * apenas *presença*; nunca o valor, nunca a validade, e nunca chama a
 * Cloudflare — um health check não pode depender de terceiro nem custar uma
 * credencial por requisição.
 */
export function isTurnConfigured(env: TurnEnv = process.env): boolean {
  return Boolean(env.CF_TURN_TOKEN_ID && env.CF_TURN_API_TOKEN);
}

/**
 * Resolve `CF_TURN_TTL` para um inteiro válido dentro da faixa suportada.
 *
 * Ausente é o caminho silencioso (é o default documentado). Valor presente e
 * inválido, ou fora da faixa, avisa em log: quem escreveu `CF_TURN_TTL=100`
 * esperando 100 segundos precisa descobrir que recebeu 600, e a alternativa
 * (aceitar calado) é a mesma classe de silêncio que esta task existe para
 * eliminar.
 */
export function resolveTurnTtl(env: TurnEnv = process.env, warn = console.warn): number {
  const raw = env.CF_TURN_TTL;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_TTL;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(`[turn] CF_TURN_TTL inválido (${JSON.stringify(raw)}); usando ${DEFAULT_TTL}s.`);
    return DEFAULT_TTL;
  }

  const ttl = Math.floor(parsed);
  if (ttl < MIN_TTL) {
    warn(`[turn] CF_TURN_TTL=${ttl} abaixo do mínimo; usando ${MIN_TTL}s.`);
    return MIN_TTL;
  }
  if (ttl > MAX_TTL) {
    warn(`[turn] CF_TURN_TTL=${ttl} acima do máximo; usando ${MAX_TTL}s.`);
    return MAX_TTL;
  }
  return ttl;
}

/** Mesmo espírito do TTL, sem clamp: um timeout absurdo cai no default. */
export function resolveTimeoutMs(env: TurnEnv = process.env, warn = console.warn): number {
  const raw = env.CF_TURN_TIMEOUT_MS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    warn(`[turn] CF_TURN_TIMEOUT_MS inválido (${JSON.stringify(raw)}); usando ${DEFAULT_TIMEOUT_MS}ms.`);
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.floor(parsed);
}

/**
 * Obtém ICE servers com credenciais efêmeras via Cloudflare TURN API.
 *
 * Três desfechos, e a distinção entre eles é o produto desta função:
 *
 * - **`null`** — as variáveis de ambiente não estão configuradas. Não é erro de
 *   execução, é capacidade não provisionada, e quem chama traduz isso em 503.
 * - **throw** — a Cloudflare respondeu não-OK, lançou, ou estourou o timeout.
 *   Vira 502.
 * - **`{ iceServers, ttl, expiresAt }`** — credencial obtida.
 *
 * O `ttl` é **autoritativo** e o client deriva o vencimento dele somando ao
 * próprio relógio no instante da resposta; `expiresAt` é informativo, para log
 * humano e aba de rede. A escolha é deliberada: o relógio do navegador não está
 * sincronizado com o do servidor, e um instante absoluto vira renovação em laço
 * (relógio adiantado) ou credencial morta para sempre (atrasado). Duração é
 * imune a offset de relógio.
 *
 * O timeout existe porque esta chamada deixou de ser uma vez por sessão e passou
 * a ser uma por TTL por aba: um upstream que aceita a conexão e não responde
 * prenderia a requisição do client indefinidamente — e o client espera por ela
 * antes de entrar na sala.
 */
export async function fetchCloudflareIceServers({
  env = process.env,
  fetchImpl = globalThis.fetch,
  warn = console.warn,
}: {
  env?: TurnEnv;
  fetchImpl?: typeof fetch;
  warn?: (...args: unknown[]) => void;
} = {}): Promise<TurnCredentials | null> {
  const tokenId = env.CF_TURN_TOKEN_ID;
  const apiToken = env.CF_TURN_API_TOKEN;

  if (!tokenId || !apiToken) return null;

  const ttl = resolveTurnTtl(env, warn);
  const timeoutMs = resolveTimeoutMs(env, warn);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetchImpl(`${CF_API_URL}/${tokenId}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl }),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Cloudflare TURN API timeout após ${timeoutMs}ms`);
    }
    throw new Error(`Cloudflare TURN API inacessível: ${redact(mensagemDe(err), env)}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) throw new Error(`Cloudflare TURN API error: ${res.status}`);

  let body: { iceServers?: unknown } | null;
  try {
    body = (await res.json()) as { iceServers?: unknown } | null;
  } catch (err) {
    throw new Error(`Cloudflare TURN API devolveu corpo ilegível: ${redact(mensagemDe(err), env)}`);
  }

  const iceServers = body?.iceServers as IceServer[] | undefined;
  // Lista vazia é tratada como erro de upstream, e não como sucesso magro: sob
  // `relay` ela não conecta ninguém, e responder 200 com ela seria reintroduzir
  // exatamente o silêncio que esta entrega remove.
  if (!Array.isArray(iceServers) || iceServers.length === 0) {
    throw new Error('Cloudflare TURN API devolveu iceServers vazio');
  }

  return {
    iceServers,
    ttl,
    expiresAt: new Date(Date.now() + ttl * 1000).toISOString(),
  };
}
