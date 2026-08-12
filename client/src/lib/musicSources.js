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

export const SOURCE_KINDS = new Set(['youtube', 'file', 'url']);

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isHttp(url) {
  return url.protocol === 'http:' || url.protocol === 'https:';
}

function clampTitle(value, fallback = 'Faixa') {
  const text = String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, MAX_TITLE);
  return text || fallback;
}

/**
 * Extrai o videoId de qualquer uma das formas que o YouTube usa hoje
 * (`watch?v=`, `youtu.be/`, `/embed/`, `/shorts/`, `/live/`) ou de um id cru.
 * Devolve `null` para qualquer coisa fora disso — inclusive links de playlist
 * sem vídeo, que não têm o que tocar.
 */
export function parseYouTubeId(raw) {
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
export function titleFromUrl(raw) {
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
export function titleFromFileName(name) {
  return clampTitle(String(name ?? '').replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[_+]/g, ' '), 'Arquivo local');
}

/**
 * Diz se a URL *parece* áudio direto. Não é uma garantia (só o `Content-Type` da
 * resposta seria), mas serve para avisar o usuário antes de a faixa entrar na
 * fila e falhar para a sala inteira.
 */
export function looksLikeAudioUrl(raw) {
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
export function parseSource(raw, { allowYouTube = true } = {}) {
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

/** Entrada a partir de um `File` escolhido no disco. O arquivo nunca sai daqui. */
export function parseFileSource(file) {
  if (!file || typeof file !== 'object') return { ok: false, reason: 'empty' };
  const name = typeof file.name === 'string' ? file.name : '';
  const type = typeof file.type === 'string' ? file.type : '';
  if (type && !type.startsWith('audio/') && !type.startsWith('video/')) {
    return { ok: false, reason: 'not-audio' };
  }
  return { ok: true, kind: 'file', sourceRef: '', title: titleFromFileName(name) };
}

/** `125` → `2:05`; `3725` → `1:02:05`; nada → `--:--`. */
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--:--';
  const total = Math.floor(seconds);
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Mensagens de recusa, em um lugar só — UI e testes leem daqui. */
export const SOURCE_ERRORS = {
  empty: 'Cole um link do YouTube ou uma URL de áudio.',
  'too-long': 'Esse link é longo demais.',
  unsupported: 'Não reconheci esse link.',
  'unsupported-scheme': 'Só links http(s) são aceitos.',
  'youtube-disabled': 'YouTube está desativado nesta instalação.',
  'not-audio': 'Esse arquivo não parece ser de áudio.',
  'queue-full': 'A fila da sala está cheia.',
  'peer-limit': 'Você já tem o máximo de faixas na fila.',
  duplicate: 'Essa faixa já está na fila.',
};
