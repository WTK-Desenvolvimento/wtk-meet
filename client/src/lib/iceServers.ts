/**
 * O provedor de ICE servers: cache com prazo, renovação e um motivo legível
 * quando não há TURN.
 *
 * Por que existe um módulo só para isto. O client roda
 * `iceTransportPolicy: 'relay'` (`webrtcMesh.js`), então o TURN não é fallback,
 * é o caminho único: sem credencial **válida** o navegador não gera candidato
 * nenhum — nem host, nem srflx — e a conexão simplesmente nunca fecha. O código
 * anterior guardava a credencial num módulo-singleton **sem prazo**, pela sessão
 * inteira da aba, enquanto a credencial da Cloudflare vence em algumas horas.
 * Uma aba aberta desde ontem seguia criando `RTCPeerConnection` nova com
 * credencial morta; as conexões antigas continuavam de pé (a alocação de relay
 * já existia) e só as **novas** falhavam. É o padrão exato do sintoma relatado:
 * intermitente, contra um participante específico, com o resto da sala normal —
 * quem tem a aba velha é o incumbente, quem sofre é o entrante.
 *
 * Três escolhas carregam o arquivo:
 *
 * 1. **O prazo vem da duração, não do instante.** O servidor manda `ttl` em
 *    segundos e o vencimento é calculado com o relógio **local**, no instante da
 *    resposta. O relógio do navegador não está sincronizado com o do servidor: um
 *    `expiresAt` absoluto viraria renovação em laço numa máquina adiantada e
 *    credencial eterna numa atrasada. `expiresAt` só é lido para log humano.
 * 2. **Não existe fallback para STUN público.** Sob `relay`, STUN puro gera zero
 *    candidatos utilizáveis: não é resiliência degradada, é falha com aparência
 *    de sucesso — e pior que a falha crua, porque consome o orçamento de tempo do
 *    ICE antes de morrer e ainda fala com um terceiro (contra `ARCHITECTURE.md`
 *    §5 e §7). Em qualquer erro a lista volta **vazia**, e o `status` diz por quê.
 * 3. **Nunca rejeita.** `Room.jsx` chama isto dentro de um `Promise.all` cujo
 *    `catch` leva a sala para a tela de acesso negado *sem motivo*. Uma promise
 *    rejeitada aqui viraria "acesso negado" para um TURN fora do ar. Quem
 *    transforma a falha em sinal visível é o mesh, via `onPeerStateChange`.
 *
 * Sem `import.meta.env` e sem DOM de propósito: `fetch` e relógio são
 * injetáveis, no mesmo espírito de `lib/devices.js` e `lib/gridLayout.js`, e os
 * testes rodam em `node --test` puro. Quem conhece a URL do servidor de
 * sinalização é `config.js`, que configura este módulo no load.
 */

/**
 * Margem de renovação: renova-se **antes** de vencer, nunca em cima da hora.
 *
 * Proporcional ao TTL, com teto — e nunca igual ao próprio TTL. Uma margem fixa
 * de 60s contra um `ttl` de 60s consideraria a credencial "quase vencida" no
 * instante em que ela chega, e o resultado seria um laço de requisições.
 */
export function renewMarginMs(ttlSeconds: number): number {
  return Math.min(60_000, ttlSeconds * 100); // min(60s, 10% do ttl), em ms
}

/**
 * TTL assumido quando a resposta não traz um utilizável.
 *
 * Acontece com um servidor anterior a esta entrega (que respondia só
 * `{ iceServers }`) e com qualquer valor patológico — `0`, negativo, `NaN`,
 * string. Curto de propósito: renovar à toa custa uma requisição, e usar uma
 * credencial de validade desconhecida custa uma conexão que não fecha.
 */
export const FALLBACK_TTL_SECONDS = 300;

/** Espera mínima entre tentativas depois de uma falha. */
export const DEFAULT_MIN_RETRY_MS = 5_000;

/**
 * "Esta lista consegue conectar alguém sob `relay`?"
 *
 * Uma lista só de `stun:` responde `false`, que é o ponto: sob `relay` ela é
 * indistinguível de uma lista vazia na prática, e distinguí-las na aparência é
 * o que fazia a falha passar por sucesso.
 */
/** Um item de `RTCConfiguration.iceServers`, como o servidor o entrega. */
export type IceServer = RTCIceServer & { url?: string };

/** O motivo corrente do provedor — vale como diagnóstico e vai para o log. */
export type IceStatus = 'idle' | 'ok' | 'stale' | 'unconfigured' | 'upstream' | 'unreachable';

export interface IceServerProviderOptions {
  endpoint?: string | null;
  fetchImpl?: typeof fetch | null;
  now?: () => number;
  minRetryMs?: number;
  warn?: (...args: unknown[]) => void;
}

export interface IceDescription {
  status: IceStatus;
  lastFailureKind: IceStatus | null;
  hasTurn: boolean;
  ttl: number | null;
  msUntilRenew: number | null;
}

export interface IceServerProvider {
  configure(options: { endpoint?: string | null }): void;
  get(opts?: { force?: boolean }): Promise<IceServer[]>;
  status(): IceStatus;
  describe(): IceDescription;
  reset(): void;
}

/** O que fica em cache entre renovações. */
interface IceCache {
  iceServers: IceServer[];
  renewAt: number;
  expiresAt: number;
  ttl: number;
}

/**
 * A mensagem de um erro capturado. Sob `strict`, o `catch` entrega `unknown` —
 * e é honesto: nada garante que o que foi lançado seja um `Error`.
 */
function mensagemDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function hasTurnServer(iceServers: unknown): boolean {
  if (!Array.isArray(iceServers)) return false;
  return iceServers.some((server) => {
    const urls = server?.urls ?? server?.url;
    const list = Array.isArray(urls) ? urls : [urls];
    return list.some((url) => typeof url === 'string' && /^turns?:/i.test(url.trim()));
  });
}

/**
 * Cria um provedor independente. A aplicação usa o singleton do fim do arquivo;
 * os testes criam o seu, com relógio e `fetch` dublês.
 *
 * `status` é o motivo corrente, e vale a pena listar porque cada valor pede uma
 * ação diferente de quem opera:
 *
 * - `idle` — ainda não se buscou nada.
 * - `ok` — credencial válida em mãos.
 * - `unconfigured` — o servidor respondeu 503: falta `CF_TURN_TOKEN_ID` /
 *   `CF_TURN_API_TOKEN` no deploy. Nenhuma chamada vai conectar, para ninguém.
 * - `upstream` — 502: a Cloudflare falhou. Tende a ser transitório.
 * - `unreachable` — o próprio servidor de sinalização não respondeu, ou
 *   respondeu algo inesperado.
 * - `stale` — a renovação falhou, mas a credencial anterior ainda está dentro da
 *   validade e está sendo usada. É o estado que evita derrubar uma sala inteira
 *   por causa de um soluço de rede.
 */
export function createIceServerProvider({
  endpoint = null,
  fetchImpl = null,
  now = () => Date.now(),
  minRetryMs = DEFAULT_MIN_RETRY_MS,
  warn = (...args: unknown[]) => console.warn(...args),
}: IceServerProviderOptions = {}): IceServerProvider {
  let url = endpoint;
  let cache: IceCache | null = null;
  let status: IceStatus = 'idle';
  let lastFailureKind: IceStatus | null = null;
  let lastFailureAt = -Infinity;
  let inFlight: Promise<IceServer[]> | null = null;

  function currentFetch() {
    return fetchImpl || globalThis.fetch;
  }

  function resolveTtl(raw: unknown): number {
    const ttl = Number(raw);
    if (!Number.isFinite(ttl) || ttl <= 0) return FALLBACK_TTL_SECONDS;
    return ttl;
  }

  /**
   * O que devolver quando a renovação falha.
   *
   * Credencial vencida **não** é servida: sob `relay` ela é tão inútil quanto
   * lista vazia, e devolvê-la só adiaria a descoberta do problema em algumas
   * dezenas de segundos de ICE.
   */
  function fallbackAfterFailure(kind: IceStatus): IceServer[] {
    lastFailureKind = kind;
    lastFailureAt = now();
    if (cache && now() < cache.expiresAt) {
      status = 'stale';
      return cache.iceServers;
    }
    cache = null;
    status = kind;
    return [];
  }

  async function request() {
    if (!url) {
      // Só acontece se alguém importar este módulo sem passar por `config.js`.
      warn('[ice] provedor sem endpoint configurado — chame configureIceServers().');
      return fallbackAfterFailure('unreachable');
    }

    let res: Response;
    try {
      res = await currentFetch()(url);
    } catch (err) {
      warn('[ice] servidor de sinalização inacessível:', mensagemDe(err));
      return fallbackAfterFailure('unreachable');
    }

    if (!res?.ok) {
      // 503 e 502 são o contrato do servidor (`server/src/index.js`): "não
      // provisionado" e "meu upstream falhou" pedem respostas operacionais
      // diferentes, e é por isso que eles não são o mesmo código.
      const kind = res?.status === 503 ? 'unconfigured' : res?.status === 502 ? 'upstream' : 'unreachable';
      warn(`[ice] /turn-credentials respondeu ${res?.status}: ${kind}`);
      return fallbackAfterFailure(kind);
    }

    let body: { iceServers?: unknown; ttl?: unknown } | null;
    try {
      body = (await res.json()) as { iceServers?: unknown; ttl?: unknown } | null;
    } catch (err) {
      warn('[ice] corpo ilegível em /turn-credentials:', mensagemDe(err));
      return fallbackAfterFailure('unreachable');
    }

    const iceServers = body?.iceServers as IceServer[] | undefined;
    if (!Array.isArray(iceServers) || iceServers.length === 0) {
      warn('[ice] /turn-credentials respondeu 200 com lista vazia.');
      return fallbackAfterFailure('unreachable');
    }
    // Uma lista **sem nenhum TURN** é o mesmo que uma lista vazia, sob `relay`:
    // zero candidatos utilizáveis. Ela precisa de menção própria porque é o
    // formato mais enganoso de todos — parece uma configuração de ICE legítima,
    // sobrevive a qualquer validação de tipo, e era exatamente o que o antigo
    // fallback de STUN público produzia. Cachear isso por um TTL inteiro
    // reintroduziria o silêncio pela porta dos fundos.
    if (!hasTurnServer(iceServers)) {
      warn('[ice] /turn-credentials respondeu sem nenhum servidor TURN — inútil sob relay.');
      return fallbackAfterFailure('unreachable');
    }

    const ttl = resolveTtl(body?.ttl);
    if (ttl !== Number(body?.ttl)) {
      warn(`[ice] ttl ausente ou inválido na resposta (${body?.ttl}); assumindo ${ttl}s.`);
    }

    const obtainedAt = now();
    cache = {
      iceServers,
      ttl,
      // O vencimento vem do relógio local + duração. `body.expiresAt` fica de
      // fora da decisão de propósito (ver o cabeçalho do arquivo).
      expiresAt: obtainedAt + ttl * 1000,
      renewAt: obtainedAt + Math.max(0, ttl * 1000 - renewMarginMs(ttl)),
    };
    status = 'ok';
    lastFailureKind = null;
    lastFailureAt = -Infinity;
    return iceServers;
  }

  return {
    configure({ endpoint: next }: { endpoint?: string | null }) {
      if (next && next !== url) {
        url = next;
        cache = null;
        status = 'idle';
      }
    },

    /**
     * Devolve a lista corrente, renovando se preciso. **Nunca rejeita.**
     *
     * `force` é o que a recuperação de conexão usa: ela precisa de credencial
     * nova mesmo que a cacheada ainda não tenha vencido, porque "a conexão caiu"
     * é justamente a evidência de que a premissa do cache pode estar errada.
     * Ainda assim `force` respeita o intervalo mínimo entre tentativas — senão o
     * backoff de recuperação viraria uma enxurrada de requisições contra um
     * servidor que já está com problema.
     */
    async get({ force = false }: { force?: boolean } = {}): Promise<IceServer[]> {
      // Coalescência: cinco `addPeer` quase simultâneos (a entrada numa sala
      // cheia) compartilham UMA requisição.
      if (inFlight) return inFlight;

      // `ok` aqui sobrescreve um `stale` de uma renovação que falhou antes — e
      // isso é intencional: o que se devolve é uma credencial dentro da própria
      // validade, que é o que `ok` afirma. O histórico da falha não se perde,
      // continua em `describe().lastFailureKind`.
      if (!force && cache && now() < cache.renewAt) {
        status = 'ok';
        return cache.iceServers;
      }

      if (now() - lastFailureAt < minRetryMs) {
        if (cache && now() < cache.expiresAt) {
          status = 'stale';
          return cache.iceServers;
        }
        status = lastFailureKind || 'unreachable';
        return [];
      }

      inFlight = request().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },

    /** O motivo corrente, para log. Sempre síncrono. */
    status() {
      return status;
    },

    /** Diagnóstico: o que se sabe da credencial em mãos. Nunca inclui segredo derivado. */
    describe() {
      return {
        status,
        lastFailureKind,
        hasTurn: hasTurnServer(cache?.iceServers),
        ttl: cache?.ttl ?? null,
        msUntilRenew: cache ? Math.max(0, cache.renewAt - now()) : null,
      };
    },

    /** Só para teste: esquece tudo o que se sabe. */
    reset() {
      cache = null;
      status = 'idle';
      lastFailureKind = null;
      lastFailureAt = -Infinity;
      inFlight = null;
    },
  };
}

/**
 * O provedor da aplicação. É um singleton porque a credencial é da aba, não da
 * sala nem da conexão: renovar uma vez serve todos os pares.
 */
const provider = createIceServerProvider();

export function configureIceServers({ endpoint }: { endpoint?: string | null }): void {
  provider.configure({ endpoint });
}

/** Assinatura combinada com `webrtcMesh.js`: `(opts?) => Promise<Array>`. */
export function getIceServers(opts?: { force?: boolean }): Promise<IceServer[]> {
  return provider.get(opts);
}

export function getIceServersStatus(): IceStatus {
  return provider.status();
}

export function describeIceServers(): IceDescription {
  return provider.describe();
}
