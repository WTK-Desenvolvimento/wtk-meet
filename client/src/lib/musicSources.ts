/**
 * Parsing das três origens de faixa aceitas pelo player colaborativo.
 *
 * Módulo **puro**: sem DOM, sem rede, sem WebAudio. Tudo o que decide "isto é um
 * link de YouTube / uma URL de áudio / lixo" mora aqui, porque é exatamente o
 * tipo de código que precisa valer para entrada hostil vinda do data channel —
 * e entrada hostil se testa em `node:test`, não no navegador.
 *
 * A regra que atravessa o arquivo: **só `http:` e `https:` passam**. `javascript:`,
 * `data:`, `blob:` e `file:` são descarte imediato, tanto no que o usuário digita
 * quanto no que chega de outro peer (ver `musicProtocol.js`).
 */


/** As três origens de faixa aceitas pelo player. */
export type SourceKind = 'youtube' | 'file' | 'url';

/** Veredito de disponibilidade de uma origem. `unknown` é o padrão. */
export type Availability = 'ok' | 'embed-blocked' | 'not-found' | 'unknown';

/** Uma origem que deu certo. `warning` só existe para URL de extensão estranha. */
export interface ParsedSourceOk {
  ok: true;
  kind: SourceKind;
  sourceRef: string;
  title: string;
  warning?: string | null;
}

/** Uma origem recusada. `reason` é chave de `SOURCE_ERRORS`. */
export interface ParsedSourceFail {
  ok: false;
  reason: string;
}

export type ParsedSource = ParsedSourceOk | ParsedSourceFail;

/** O que dá para saber de uma origem sem tocá-la. */
export interface SourceMeta {
  title: string;
  availability: Availability;
}

export const MAX_TITLE = 120;
export const MAX_SOURCE_REF = 300;

/** O videoId do YouTube tem 11 caracteres do alfabeto base64url. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtube-nocookie.com',
  'youtu.be',
]);

/** Extensões que sabidamente são áudio decodificável por `<audio>`. */
const AUDIO_EXTENSION = /\.(mp3|ogg|oga|opus|wav|m4a|mp4|aac|flac|webm)(?:$|[?#])/i;

export const SOURCE_KINDS: ReadonlySet<string> = new Set(['youtube', 'file', 'url']);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isHttp(url: URL): boolean {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function clampTitle(value: unknown, fallback = 'Faixa'): string {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE);
  return text || fallback;
}

/**
 * Extrai o videoId de qualquer uma das formas que o YouTube usa hoje
 * (`watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`, `/live/`) ou de um id cru.
 * Devolve `null` para qualquer coisa fora disso — inclusive links de playlist
 * sem vídeo, que não têm o que tocar.
 */
export function parseYouTubeId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  if (YOUTUBE_ID.test(value)) return value;

  const url = parseUrl(value);
  if (!url || !isHttp(url)) return null;

  const host = url.hostname.replace(/^www\./i, '').toLowerCase();
  if (!YOUTUBE_HOSTS.has(host)) return null;

  if (host === 'youtu.be') {
    const first = url.pathname.split('/').filter(Boolean)[0];
    return first && YOUTUBE_ID.test(first) ? first : null;
  }

  const query = url.searchParams.get('v');
  if (query && YOUTUBE_ID.test(query)) return query;

  const path = url.pathname.match(/^\/(?:embed|shorts|v|live)\/([^/?#]+)/);
  if (path && YOUTUBE_ID.test(path[1])) return path[1];

  return null;
}

/** Último segmento legível da URL — o melhor título disponível sem baixar nada. */
export function titleFromUrl(raw: unknown): string {
  const url = parseUrl(String(raw ?? ''));
  if (!url) return 'Faixa';
  const segment = url.pathname.split('/').filter(Boolean).pop();
  if (!segment) return clampTitle(url.hostname);
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // sequência percent inválida: fica o cru mesmo
  }
  return clampTitle(decoded.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_+]/g, ' '));
}

/** Nome de arquivo sem extensão, limitado. */
export function titleFromFileName(name: unknown): string {
  return clampTitle(String(name ?? '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_+]/g, ' '), 'Arquivo local');
}

/**
 * Diz se a URL *parece* áudio direto. Não é uma garantia (só o `Content-Type` da
 * resposta seria), mas serve para avisar o usuário antes de a faixa entrar na
 * fila e falhar para a sala inteira.
 */
export function looksLikeAudioUrl(raw: unknown): boolean {
  const url = parseUrl(String(raw ?? ''));
  return !!url && isHttp(url) && AUDIO_EXTENSION.test(url.pathname + url.search);
}

/**
 * Converte o que o usuário colou numa entrada de fila (sem `id`/`lamport`, que
 * são responsabilidade de quem adiciona).
 *
 * Devolve `{ ok: true, kind, sourceRef, title }` ou `{ ok: false, reason }` —
 * nunca lança, e a razão é o que a UI mostra.
 */
export function parseSource(raw: unknown, { allowYouTube = true }: { allowYouTube?: boolean } = {}): ParsedSource {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, reason: 'empty' };
  if (value.length > MAX_SOURCE_REF) return { ok: false, reason: 'too-long' };

  const videoId = parseYouTubeId(value);
  if (videoId) {
    if (!allowYouTube) return { ok: false, reason: 'youtube-disabled' };
    return { ok: true, kind: 'youtube', sourceRef: videoId, title: `YouTube · ${videoId}` };
  }

  const url = parseUrl(value);
  if (!url) return { ok: false, reason: 'unsupported' };
  if (!isHttp(url)) return { ok: false, reason: 'unsupported-scheme' };

  return {
    ok: true,
    kind: 'url',
    sourceRef: url.toString().slice(0, MAX_SOURCE_REF),
    title: titleFromUrl(url.toString()),
    warning: looksLikeAudioUrl(url.toString()) ? null : 'unknown-extension',
  };
}

/**
 * Vereditos de disponibilidade que uma origem pode ter. `unknown` é o padrão de
 * tudo que não é prova — inclusive origem que não é YouTube, buscador não
 * injetado e qualquer falha do buscador.
 */
export const AVAILABILITY: ReadonlySet<string> = new Set(['ok', 'embed-blocked', 'not-found', 'unknown']);

/** Predicado sobre a tabela acima: ela continua sendo a fonte única da verdade. */
function isAvailability(value: unknown): value is Availability {
  return typeof value === 'string' && AVAILABILITY.has(value);
}

/**
 * Qual veredito recusa a faixa, e com que mensagem. **Só dois**: os dois em que
 * o vídeo provadamente não vai tocar.
 *
 * Mora aqui, e não em quem enfileira, para que "o que é recusável" seja uma
 * tabela testável em `node:test` em vez de um `if` espalhado pelo hook — e para
 * que `ok` e `unknown` sigam pelo mesmo caminho, que é entrar na fila.
 */
export const REFUSAL_BY_AVAILABILITY: Record<string, string | undefined> = {
  'not-found': 'youtube-unavailable',
  'embed-blocked': 'youtube-embed-blocked',
};

/**
 * Descobre o que dá para saber sobre uma origem sem tocá-la: o título de
 * verdade, que `parseSource` só consegue como `YouTube · <id>` sem sair da
 * máquina, e se o vídeo é incorporável.
 *
 * **Assíncrona, mas ainda pura:** o buscador vem por parâmetro. Quem faz rede é
 * `fetchYouTubeOEmbed`, em `youtubePlayer.js` — o arquivo onde a dependência do
 * terceiro está confinada e que a `VITE_ENABLE_YOUTUBE` desliga inteiro. Este
 * módulo continua sem DOM e sem rede, que é o que permite testá-lo com entrada
 * hostil em `node:test`; importar o buscador aqui, mesmo sem chamá-lo, já
 * arrastaria a dependência e mataria essa garantia.
 *
 * **Título e veredito são independentes.** Qualquer erro, valor que não é texto
 * ou título vazio mantém o fallback — enfileirar nunca dependeu de um nome
 * bonito — e um título ausente **não** vira veredito de indisponibilidade: quem
 * decide isso é o status HTTP, lá onde ele existe.
 */
export async function resolveSourceMeta(
  parsed: ParsedSource | null | undefined,
  {
    fetchMeta,
  }: {
    fetchMeta?: (
      sourceRef: string,
    ) => Promise<{ title?: unknown; availability?: unknown } | null | undefined>;
  } = {},
): Promise<SourceMeta> {
  const fallback = (parsed?.ok && parsed.title) || 'Faixa';
  const unresolved: SourceMeta = { title: fallback, availability: 'unknown' };
  if (!parsed?.ok || parsed.kind !== 'youtube') return unresolved;
  if (typeof fetchMeta !== 'function') return unresolved;

  let resolved: { title?: unknown; availability?: unknown } | null | undefined = null;
  try {
    resolved = await fetchMeta(parsed.sourceRef);
  } catch {
    return unresolved;
  }
  const availability = isAvailability(resolved?.availability) ? resolved.availability : 'unknown';
  const title = typeof resolved?.title === 'string' ? clampTitle(resolved.title, fallback) : fallback;
  return { title, availability };
}

/** Entrada a partir de um `File` escolhido no disco. O arquivo nunca sai daqui. */
export function parseFileSource(file: unknown): ParsedSource {
  if (!file || typeof file !== 'object') return { ok: false, reason: 'empty' };
  // `in` em vez de cast para `File`: o módulo é puro e o que ele usa do arquivo
  // são dois campos: quem chama passa um `File` de verdade, e o teste passa o
  // mínimo. O `in` estreita sem afirmar nada que não foi verificado.
  const name = 'name' in file && typeof file.name === 'string' ? file.name : '';
  const type = 'type' in file && typeof file.type === 'string' ? file.type : '';
  if (type && !type.startsWith('audio/') && !type.startsWith('video/')) {
    return { ok: false, reason: 'not-audio' };
  }
  return { ok: true, kind: 'file', sourceRef: '', title: titleFromFileName(name) };
}

/** `125` → `2:05`; `3725` → `1:02:05`; nada → `--:--`. */
export function formatDuration(seconds: unknown): string {
  // `typeof` primeiro só para estreitar: `Number.isFinite` já devolvia `false`
  // para o que não é número, então o resultado é o mesmo de antes.
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Mensagens de recusa, em um lugar só — UI e testes leem daqui. */
export const SOURCE_ERRORS: Record<string, string> = {
  empty: 'Cole um link do YouTube ou uma URL de áudio.',
  'too-long': 'Esse link é longo demais.',
  unsupported: 'Não reconheci esse link.',
  'unsupported-scheme': 'Só links http(s) são aceitos.',
  'youtube-disabled': 'YouTube está desativado nesta instalação.',
  'not-audio': 'Esse arquivo não parece ser de áudio.',
  'queue-full': 'A fila da sala está cheia.',
  'peer-limit': 'Você já tem o máximo de faixas na fila.',
  duplicate: 'Essa faixa já está na fila.',
  // As duas recusas de disponibilidade do YouTube são mensagens separadas porque
  // a saída do usuário é diferente: no primeiro caso o link está errado ou morto
  // e há o que corrigir; no segundo o vídeo existe, mas insistir não adianta.
  'youtube-unavailable': 'Esse vídeo foi removido, é privado ou não existe mais.',
  'youtube-embed-blocked': 'O dono desse vídeo não deixa tocá-lo fora do YouTube.',
};
