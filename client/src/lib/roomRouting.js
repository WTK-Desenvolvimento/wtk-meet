/**
 * Quem é sala e quem é aplicação.
 *
 * A regra cabe numa linha: **primeiro segmento reservado ⇒ app; senão ⇒ sala**.
 * Ela vive aqui porque três consumidores dependem dela — o roteador
 * (`App.jsx`), a validação do campo de endereço (`Home.jsx`) e a
 * canonicalização da sala (`Room.jsx`).
 */
import { isValidRoomPath, normalizeRoomPath } from './roomSlug.js';

/**
 * Rotas da aplicação. `app` é o namespace das telas; `room` fica preso ao
 * redirect legado; o resto é servido pelo backend de sinalização.
 */
export const RESERVED_SEGMENTS = Object.freeze([
  'app',
  'room',
  'api',
  'health',
  'turn-credentials',
]);

/**
 * Paths que a camada estática já possui — nenhum deles chega ao React.
 *
 * `assets`, `static` e `public` são diretórios reais em produção e o
 * `try_files $uri/` do nginx casa `$uri/` **antes** do fallback do SPA. Os
 * nomes com ponto entram na forma já normalizada (`favicon.ico` →
 * `favicon-ico`), que é como chegariam aqui vindos do campo da Home.
 *
 * Derivar esta lista das rotas do react-router não serviria: os paths perigosos
 * são exatamente os que o nginx atende antes do SPA.
 */
export const BLOCKED_SEGMENTS = Object.freeze([
  'assets',
  'static',
  'public',
  'socket-io',
  'well-known',
  'favicon',
  'favicon-ico',
  'robots-txt',
  'index-html',
  'manifest-json',
  'sw-js',
]);

/**
 * O mapa de rotas, sem componente nenhum — `App.jsx` liga cada `screen` ao seu
 * elemento. Ficar aqui, e não em JSX, é o que permite ao teste rodar o matcher
 * de verdade do react-router sem arrastar a sala inteira (e o `import.meta.env`
 * do Vite) para dentro do `node --test`.
 *
 * A ordem de precedência quem decide é o react-router (estático ganha de
 * dinâmico, dinâmico ganha de splat), não a ordem desta lista.
 */
export const ROUTE_TABLE = Object.freeze([
  { path: '/', screen: 'home' },
  { path: '/app', screen: 'home' },
  { path: '/app/*', screen: 'app-namespace' },
  { path: '/room/:roomId', screen: 'legacy-room' },
  { path: '/:roomSlug', screen: 'room' },
  { path: '*', screen: 'not-found' },
]);

/** Segmentos que o cliente nunca deve tratar como sala. */
export function isReservedPath(path) {
  return RESERVED_SEGMENTS.includes(path) || BLOCKED_SEGMENTS.includes(path);
}

/** Path utilizável como sala: normalizado, dentro do charset e não reservado. */
export function isRoomPath(path) {
  return isValidRoomPath(path) && !isReservedPath(path);
}

/**
 * Path canônico da sala a partir de um `location.pathname`.
 *
 * Devolve `''` para tudo que não é sala — raiz, rota reservada, multi-segmento
 * (`/a/b`) e path que normaliza para nada. Multi-segmento fica de fora de
 * propósito: com hierarquia, reservar namespace no futuro (`/app/algo` novo)
 * passaria a roubar a sala de alguém.
 */
export function roomPathFromLocation(pathname) {
  if (typeof pathname !== 'string') return '';
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length !== 1) return '';
  const path = normalizeRoomPath(segments[0]);
  return isRoomPath(path) ? path : '';
}

/**
 * Destino do redirect dos links antigos `/room/:roomId#chave`.
 *
 * O fragmento chega intacto porque ele **é** a chave da sala: perder o `#` aqui
 * transformaria um link antigo válido numa sala nova e vazia. O UUID legado
 * (minúsculo, alfanumérico com hífen) atravessa a normalização sem mudar, então
 * o redirect preserva a sala e não só a página.
 */
export function legacyRoomRedirect(roomId, hash = '') {
  const path = normalizeRoomPath(roomId);
  if (!isRoomPath(path)) return '/';
  return `/${path}${hash || ''}`;
}

/**
 * Lê um convite colado por gente: URL completa, URL sem esquema
 * (`meet.exemplo.com/daily#k`), path puro (`/daily#k`) e o formato legado
 * `/room/:id#k`. Devolve `null` quando falta path ou chave — **nunca lança**,
 * porque `new URL()` sozinho quebra nos dois formatos sem esquema e a exceção
 * escaparia para o render.
 */
export function parseInviteLink(text) {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const hashAt = trimmed.indexOf('#');
  if (hashAt === -1) return null;
  const passphrase = trimmed.slice(hashAt + 1).trim();
  if (!passphrase) return null;

  let pathname = trimmed.slice(0, hashAt);
  // Descarta esquema e host quando houver; o que sobra é sempre o caminho.
  pathname = pathname.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  if (!pathname.startsWith('/')) {
    const firstSlash = pathname.indexOf('/');
    pathname = firstSlash === -1 ? '' : pathname.slice(firstSlash);
  }
  // Query string não faz parte do endereço da sala.
  pathname = pathname.split('?')[0];

  const segments = pathname.split('/').filter(Boolean);
  // Formato legado: `/room/<id>` — o `room` some e o id vira o path.
  const candidate = segments.length === 2 && segments[0] === 'room' ? segments[1] : segments[0];
  if (segments.length > 2 || (segments.length === 2 && segments[0] !== 'room')) return null;

  const path = normalizeRoomPath(candidate);
  if (!isRoomPath(path)) return null;
  return { path, passphrase };
}
