/**
 * Favoritos do soundboard: parsing do que a pessoa cola e persistência da lista
 * daquele navegador.
 *
 * Módulo **puro**: sem DOM, sem rede, sem `localStorage`. Ele recebe um objeto
 * storage-like e devolve estruturas — o mesmo padrão de `lib/devices.js` e
 * `lib/noiseSuppression.js`, e o que permite cobrir storage corrompido, limite
 * de itens e URL hostil em `node:test`, sem navegador.
 *
 * **Terceira (e última) exceção à regra de zero persistência do produto.** Um
 * favorito é preferência de UI do navegador: não é conteúdo de chamada, não é
 * metadado de chamada, e não sai da aba — ninguém mais vê a sua lista. A lista
 * de participantes silenciados **não** entra aqui de propósito: `peerId` é o
 * socket id daquela sessão e não sobrevive a um reload, então persisti-la seria
 * gravar lixo que, na pior das hipóteses, silencia a pessoa errada na próxima
 * sala. Ver `ARCHITECTURE.md` §6.10.
 *
 * A validação da URL não é própria: ela é a de `musicSources.parseSource`, a
 * mesma que já decide o que entra na fila do player colaborativo. Duas tabelas
 * de esquemas aceitos divergiriam, e a que divergisse para o lado permissivo
 * seria a porta de `javascript:` num `href`.
 */

import { MAX_SOURCE_REF, MAX_TITLE, parseSource, titleFromUrl } from './musicSources.js';

export const STORAGE_KEY = 'wtk-meet:soundboard';

/** Versão do formato gravado. Versão desconhecida ⇒ defaults, sem lançar. */
export const SCHEMA_VERSION = 1;

/**
 * Teto de favoritos. Existe porque `localStorage` tem cota (~5 MB por origem,
 * compartilhada com as outras duas chaves) e porque uma grade de botões que não
 * cabe na tela deixa de ser um soundboard. Estourar é **recusa com mensagem**,
 * nunca gravação truncada em silêncio: a pessoa precisa saber que o favorito que
 * ela acabou de colar não vai estar lá amanhã.
 */
export const MAX_FAVORITES = 50;

/**
 * Duração máxima de um efeito, em ms. Vale ao tocar (o disparo é cortado no fim
 * da janela) e ao sanitizar o `durationMs` que chega de outro peer. Um efeito é
 * um efeito: um mp3 de 40 minutos favoritado por engano travaria o canal de
 * música de quem disparou e a janela de mute de todo mundo.
 */
export const MAX_SOUND_MS = 15_000;

export { MAX_SOURCE_REF, MAX_TITLE };

/** Um efeito favoritado, do navegador de quem favoritou. */
export interface Favorite {
  id: string;
  title: string;
  /**
   * URL `http(s)` do áudio (quando `kind` é `'url'` ou `undefined`).
   * Vazio (`''`) quando `kind` é `'file'` — o conteúdo fica no IndexedDB.
   */
  sourceRef: string;
  addedAt: number;
  /**
   * Origem do efeito. `undefined` equivale a `'url'` (retrocompatibilidade
   * com favoritos gravados antes desta versão).
   */
  kind?: 'url' | 'file';
  /**
   * Chave no IndexedDB (`audioFileStorage`). Presente apenas quando
   * `kind === 'file'`.
   */
  fileId?: string;
}

/** O que fica em `localStorage` sob `wtk-meet:soundboard`. */
export interface SoundboardPreferences {
  version: number;
  favorites: Favorite[];
  /** Mute global **do ouvinte**. Nunca trafega (ver `useMusicRoom`). */
  mutedAll: boolean;
  /** Volume de monitoração: só o que **quem dispara** ouve de si. */
  monitorVolume: number;
}

/** Uma `Storage` mínima: só o que este módulo chama, e tudo opcional. */
export interface PreferenceStorage {
  getItem?(key: string): string | null;
  setItem?(key: string, value: string): void;
}

/** Um favorito aceito, ainda sem `id` e sem `addedAt` — quem grava os põe. */
export interface ParsedFavoriteOk {
  ok: true;
  title: string;
  sourceRef: string;
}

/** Uma entrada recusada. `reason` é chave de `SOUNDBOARD_ERRORS`. */
export interface ParsedFavoriteFail {
  ok: false;
  reason: string;
}

export type ParsedFavorite = ParsedFavoriteOk | ParsedFavoriteFail;

/** O resultado de uma gravação: o estado efetivo e, se recusou, por quê. */
export interface FavoriteWriteResult {
  ok: boolean;
  prefs: SoundboardPreferences;
  reason?: string;
  favorite?: Favorite;
}

export const DEFAULT_PREFERENCES: SoundboardPreferences = {
  version: SCHEMA_VERSION,
  favorites: [],
  mutedAll: false,
  monitorVolume: 1,
};

function defaults(): SoundboardPreferences {
  return { ...DEFAULT_PREFERENCES, favorites: [] };
}

function clampTitle(value: unknown, fallback: string): string {
  const text = String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, MAX_TITLE);
  return text || fallback;
}

/**
 * Converte o que a pessoa colou num favorito.
 *
 * O trabalho pesado é de `parseSource`, com `allowYouTube: false`: um efeito
 * precisa virar `AudioBuffer`, e o áudio do YouTube mora num iframe cross-origin
 * fora do alcance de qualquer API de captura (ver `youtubePlayer.js`). Só
 * `http:` e `https:` passam; `javascript:`, `data:`, `blob:` e `file:` são
 * recusados com mensagem — e o texto colado continua no campo, para a pessoa
 * poder corrigi-lo.
 */
export function parseFavoriteInput(raw: unknown): ParsedFavorite {
  const parsed = parseSource(raw, { allowYouTube: false });
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  // `parseSource` só devolve `youtube`, `file` ou `url`; sem YouTube e sem
  // `File` na entrada, sobra `url`. O `if` é a trava para o dia em que ele
  // aprender uma quarta origem.
  if (parsed.kind !== 'url') return { ok: false, reason: 'unsupported' };
  return {
    ok: true,
    // Default derivado do nome do arquivo (último segmento do caminho, sem
    // extensão), truncado em `MAX_TITLE`. É editável depois.
    title: clampTitle(parsed.title || titleFromUrl(parsed.sourceRef), 'Efeito'),
    sourceRef: parsed.sourceRef,
  };
}

function sanitizeFavorite(candidate: unknown): Favorite | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const bruto = candidate as Partial<Record<keyof Favorite, unknown>>;

  const id = typeof bruto.id === 'string' && bruto.id ? bruto.id.slice(0, 80) : '';
  if (!id) return null;

  const addedAt =
    typeof bruto.addedAt === 'number' && Number.isFinite(bruto.addedAt) && bruto.addedAt >= 0
      ? Math.floor(bruto.addedAt)
      : 0;

  // Favorito de arquivo local: não valida sourceRef pela URL, mas exige fileId.
  if (bruto.kind === 'file') {
    const fileId = typeof bruto.fileId === 'string' && bruto.fileId ? bruto.fileId : '';
    if (!fileId) return null;
    return {
      id,
      title: clampTitle(bruto.title, 'Efeito'),
      sourceRef: '',
      addedAt,
      kind: 'file',
      fileId,
    };
  }

  const sourceRef = typeof bruto.sourceRef === 'string' ? bruto.sourceRef : '';
  // Revalidado na leitura, não só na gravação: o que está no storage pode ter
  // sido escrito por outra versão do produto — ou à mão, pelo console.
  const parsed = parseFavoriteInput(sourceRef);
  if (!parsed.ok) return null;
  return { id, title: clampTitle(bruto.title, parsed.title), sourceRef: parsed.sourceRef, addedAt };
}

/**
 * Valida o que veio do storage. Item malformado é **descartado**, não corrige a
 * lista inteira para vazia: perder um favorito é melhor que perder os outros 49.
 * JSON inválido, sim, resolve para a lista vazia — ali não há o que salvar.
 */
function sanitize(candidate: unknown): SoundboardPreferences {
  const out = defaults();
  if (!candidate || typeof candidate !== 'object') return out;
  const bruto = candidate as Partial<Record<keyof SoundboardPreferences, unknown>>;
  // Versão desconhecida (de uma versão futura, ou de um valor plantado à mão)
  // cai nos defaults inteiros: adivinhar a forma de um formato que este código
  // não conhece é como um favorito vira uma exceção no meio da montagem.
  if (typeof bruto.version === 'number' && bruto.version !== SCHEMA_VERSION) return out;

  const lista: readonly unknown[] = Array.isArray(bruto.favorites) ? bruto.favorites : [];
  const vistos = new Set<string>();
  for (const item of lista) {
    if (out.favorites.length >= MAX_FAVORITES) break;
    const favorite = sanitizeFavorite(item);
    // Chave de deduplicação: para arquivos usa o fileId; para URLs usa a URL.
    const dedupKey = favorite?.kind === 'file' ? `file:${favorite.fileId}` : favorite?.sourceRef;
    if (!favorite || !dedupKey || vistos.has(dedupKey)) continue;
    vistos.add(dedupKey);
    out.favorites.push(favorite);
  }

  if (typeof bruto.mutedAll === 'boolean') out.mutedAll = bruto.mutedAll;
  if (typeof bruto.monitorVolume === 'number' && Number.isFinite(bruto.monitorVolume)) {
    out.monitorVolume = Math.min(1, Math.max(0, bruto.monitorVolume));
  }
  return out;
}

/**
 * Lê e valida as preferências. **Nunca lança**: storage ausente, `getItem`
 * lançando (modo privado), JSON inválido, item malformado ou versão desconhecida
 * caem todos nos defaults — o painel abre vazio e funcional.
 */
export function readSoundboard(storage?: PreferenceStorage | null): SoundboardPreferences {
  try {
    const raw = storage?.getItem?.(STORAGE_KEY);
    if (!raw) return defaults();
    return sanitize(JSON.parse(raw));
  } catch {
    return defaults();
  }
}

/**
 * Faz merge do patch sobre o que já está gravado, valida, grava e devolve o
 * resultado efetivo. `setItem` lançando (cota, modo privado) é engolido: a
 * preferência não persiste e a sessão corrente continua igual.
 */
export function writeSoundboard(
  storage: PreferenceStorage | null | undefined,
  patch?: Partial<SoundboardPreferences> | null,
): SoundboardPreferences {
  const next = sanitize({ ...readSoundboard(storage), ...(patch || {}) });
  try {
    storage?.setItem?.(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // sem persistência nesta sessão — não é motivo para quebrar a chamada
  }
  return next;
}

/**
 * Acrescenta um favorito às preferências **em memória** (quem grava é quem
 * chama, com `writeSoundboard`).
 *
 * As três recusas possíveis são explícitas e têm mensagem: URL inválida, lista
 * cheia e duplicata. Nenhuma delas é silenciosa — um teto que ignora o clique
 * sem dizer nada é indistinguível de um bug.
 */
export function addFavorite(
  prefs: SoundboardPreferences | null | undefined,
  input: unknown,
  { now = 0, id = '' }: { now?: number; id?: string } = {},
): FavoriteWriteResult {
  const base = sanitize(prefs);
  const parsed = parseFavoriteInput(input);
  if (!parsed.ok) return { ok: false, prefs: base, reason: parsed.reason };
  if (base.favorites.some((item) => item.sourceRef === parsed.sourceRef)) {
    return { ok: false, prefs: base, reason: 'duplicate' };
  }
  if (base.favorites.length >= MAX_FAVORITES) {
    return { ok: false, prefs: base, reason: 'full' };
  }
  const favorite: Favorite = {
    id: id || `s-${Math.random().toString(36).slice(2)}-${Math.floor(now)}`,
    title: parsed.title,
    sourceRef: parsed.sourceRef,
    addedAt: Math.max(0, Math.floor(now)),
  };
  return { ok: true, favorite, prefs: { ...base, favorites: [...base.favorites, favorite] } };
}

/**
 * Acrescenta um favorito de **arquivo local** às preferências em memória.
 *
 * Não valida URL — o arquivo já está na máquina do usuário. Deriva o título
 * do nome do arquivo (remove extensão, trunca em `MAX_TITLE`).
 */
export function addFileFavorite(
  prefs: SoundboardPreferences | null | undefined,
  file: { name: string },
  { id = '', fileId, now = 0 }: { id?: string; fileId: string; now?: number },
): FavoriteWriteResult {
  const base = sanitize(prefs);
  if (base.favorites.length >= MAX_FAVORITES) {
    return { ok: false, prefs: base, reason: 'full' };
  }
  // Deriva título: retira extensão e trunca.
  const nameWithoutExt = file.name.replace(/\.[^.]+$/, '').trim() || 'Efeito';
  const title = clampTitle(nameWithoutExt, 'Efeito');
  const favorite: Favorite = {
    id: id || `sf-${Math.random().toString(36).slice(2)}-${Math.floor(now)}`,
    title,
    sourceRef: '',
    addedAt: Math.max(0, Math.floor(now)),
    kind: 'file',
    fileId,
  };
  return { ok: true, favorite, prefs: { ...base, favorites: [...base.favorites, favorite] } };
}

/** Remove por `id`. Id inexistente devolve o estado intacto, sem recusa. */
export function removeFavorite(
  prefs: SoundboardPreferences | null | undefined,
  id: unknown,
): SoundboardPreferences {
  const base = sanitize(prefs);
  return { ...base, favorites: base.favorites.filter((item) => item.id !== id) };
}

/** Renomeia por `id`. Título vazio volta ao default derivado da URL. */
export function renameFavorite(
  prefs: SoundboardPreferences | null | undefined,
  id: unknown,
  title: unknown,
): SoundboardPreferences {
  const base = sanitize(prefs);
  return {
    ...base,
    favorites: base.favorites.map((item) =>
      item.id === id ? { ...item, title: clampTitle(title, titleFromUrl(item.sourceRef)) } : item,
    ),
  };
}

/** Mensagens de recusa, em um lugar só — UI e testes leem daqui. */
export const SOUNDBOARD_ERRORS: Record<string, string> = {
  empty: 'Cole a URL de um efeito de áudio.',
  'too-long': `Essa URL passa de ${MAX_SOURCE_REF} caracteres.`,
  unsupported: 'Não reconheci essa URL.',
  'unsupported-scheme': 'Só URLs http(s) são aceitas.',
  'youtube-disabled': 'Link de YouTube não serve como efeito — cole a URL do áudio.',
  duplicate: 'Esse efeito já está nos seus favoritos.',
  full: `Você chegou ao limite de ${MAX_FAVORITES} favoritos. Apague um para adicionar outro.`,
  // As duas de rede, produzidas pelo disparo (ver `soundboardPlayer.js`).
  cors: 'Esse endereço não libera CORS, então a sala ouviria silêncio. Hospede o efeito num lugar que libere.',
  'fetch-failed': 'Não consegui baixar esse efeito.',
  'decode-failed': 'Não consegui decodificar esse áudio.',
  'rate-limited': 'Espere um instante antes de disparar de novo.',
  // Arquivo local.
  'file-pick-failed': 'Não consegui abrir o arquivo.',
};
