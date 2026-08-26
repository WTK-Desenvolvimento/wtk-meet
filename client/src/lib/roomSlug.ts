/**
 * Gramática do endereço da sala: geração do slug, normalização do endereço
 * escolhido por humano e a chave que nunca sai do fragmento.
 *
 * Fonte única de verdade — o roteador, a Home e a sala consomem daqui. Duplicar
 * a regra em qualquer um dos três parte a sala em duas: o path é a **chave da
 * sala no servidor** e o salt do PBKDF2 (`lib/e2ee.js`), então dois
 * participantes que normalizam diferente entram em salas de sinalização
 * distintas e cada um vê uma sala vazia, sem nenhum erro na tela.
 */

/**
 * base32 estilo Crockford, minúsculo, sem `i`, `l`, `o` e `u`.
 *
 * São **exatamente 32 símbolos**, e isso não é estética: 256 é múltiplo de 32,
 * então `byte % 32` é uniforme e o sorteio dispensa rejection sampling. Os
 * caracteres removidos são justamente os que se confundem ao ditar por telefone
 * (`0`/`o`, `1`/`l`/`i`) — e sem `u` não sobra vogal para formar palavra feia.
 */
export const ROOM_SLUG_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** 9 caracteres × 5 bits = 45 bits (~35 trilhões de salas). */
export const ROOM_SLUG_LENGTH = 9;

/**
 * Teto do endereço personalizado. Não é regra de produto — é guarda contra path
 * patológico (limite prático de URL, chave de `Map` no servidor, o link cabendo
 * numa linha da UI). 64 caracteres é longe do que alguém encosta sem querer.
 */
export const MAX_ROOM_PATH_LENGTH = 64;

/**
 * Charset final aceito como sala. Começa por alfanumérico de propósito: hífen
 * inicial vira `-foo` na barra de endereço, que lê como flag e não como nome.
 */
export const ROOM_PATH_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Slug aleatório, sem viés de módulo (ver comentário do alfabeto). */
export function generateRoomSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ROOM_SLUG_LENGTH));
  let slug = '';
  for (const byte of bytes) slug += ROOM_SLUG_ALPHABET[byte % ROOM_SLUG_ALPHABET.length];
  return slug;
}

/**
 * Passphrase de 128 bits em base64url (22 caracteres).
 *
 * Mora aqui, e não na Home, porque a sala também precisa dela: abrir um path sem
 * `#` gera chave nova (ver `Room.jsx`). Duas implementações de geração de chave
 * em arquivos diferentes é o tipo de divergência que não aparece em review.
 */
export function generatePassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); // 128 bits
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Slugifica o que a pessoa digitou. **Nunca lança** e nunca rejeita: devolve
 * `''` quando não sobra nada utilizável, e quem chamou decide o que dizer.
 *
 * "Sala do Nícolas!" → "sala-do-nicolas". Ninguém deveria ter que descobrir a
 * regra sozinho — as pessoas digitam com acento, espaço e maiúscula porque é
 * assim que se escreve.
 *
 * **Não corta por tamanho de propósito.** Truncar seria pior que recusar: quem
 * colasse um endereço de 200 caracteres entraria numa sala diferente da que
 * pediu, sem nada na tela dizendo isso, e ditaria para o time um link que
 * aponta para outro lugar. Quem valida tamanho é `isValidRoomPath`; quem avisa
 * é o campo da Home.
 */
export function normalizeRoomPath(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .trim()
    .normalize('NFD')
    // Remove os diacríticos que o NFD acabou de separar da letra base.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Tudo que não é [a-z0-9] vira hífen: espaço, `_`, ponto, barra, emoji.
    // Ponto é caso obrigatório — `/minha.sala.js` casaria o bloco de cache do
    // nginx, que não tem `try_files`, e devolveria 404 em produção.
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Versão da normalização para usar **enquanto a pessoa digita**.
 *
 * Igual a `normalizeRoomPath`, com uma concessão: se o que foi digitado termina
 * em espaço, `_` ou `-`, o hífen correspondente fica. Sem isso, digitar "uma
 * sala" seria impossível — o espaço apagaria a si mesmo a cada tecla e sairia
 * "umasala". O valor que vira endereço de verdade sempre passa por
 * `normalizeRoomPath`, que apara essa ponta.
 */
export function normalizeRoomPathInput(input: unknown): string {
  const normalized = normalizeRoomPath(input);
  if (!normalized) return '';
  return /[^a-z0-9]$/.test(String(input)) ? `${normalized}-` : normalized;
}

/** Path já normalizado que serve como sala. */
export function isValidRoomPath(path: unknown): path is string {
  return typeof path === 'string' && ROOM_PATH_PATTERN.test(path);
}

/** `${origin}/${path}#${passphrase}` — o link de convite, inteiro. */
export function buildRoomUrl(origin: string, path: string, passphrase: string): string {
  return `${origin}/${path}#${passphrase}`;
}
