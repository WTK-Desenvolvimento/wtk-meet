/**
 * Content script: ponte entre `window.localStorage` (app) e
 * `chrome.storage.local` (extensão) para a lista de favoritos do soundboard.
 *
 * Roda em http://localhost:5173/* (URL padrão do app wtk-meet). Só sincroniza
 * favoritos `kind:'url'` — favoritos `kind:'file'` ficam no IndexedDB da origem
 * do app, inacessível à extensão.
 *
 * Dois canais:
 * 1. `chrome.storage.onChanged` → `localStorage`  (extensão → app, tempo real)
 * 2. `setInterval` 10 s         → `chrome.storage` (app → extensão, por polling)
 *
 * Proteção de loop: `lastWrittenByUs` registra o JSON que este script escreveu
 * por último em `chrome.storage`. O handler de `onChanged` pula a rodada se o
 * novo valor é o que acabamos de escrever.
 */

import { readSoundboard, STORAGE_KEY } from '../../client/src/lib/soundboard.js';
import type { Favorite, SoundboardPreferences } from '../../client/src/lib/soundboard.js';

function parsePrefs(raw: string | null): SoundboardPreferences {
  return readSoundboard({ getItem: (_k: string) => raw });
}

function urlOnly(list: Favorite[]): Favorite[] {
  return list.filter((f) => !f.kind || f.kind === 'url');
}

/**
 * União dos favoritos de URL de dois lados.
 * Mesmo `id` → mais novo (`addedAt`) vence; resultado ordenado por `addedAt`.
 */
function mergeUrlFavorites(a: Favorite[], b: Favorite[]): Favorite[] {
  const byId = new Map<string, Favorite>();
  for (const f of [...urlOnly(a), ...urlOnly(b)]) {
    const existing = byId.get(f.id);
    if (!existing || f.addedAt > existing.addedAt) byId.set(f.id, f);
  }
  return [...byId.values()].sort((x, y) => x.addedAt - y.addedAt);
}

/** Último valor JSON que este script escreveu em `chrome.storage`. */
let lastWrittenByUs: string | null = null;

/**
 * Lê ambos os lados, calcula a união dos favoritos de URL e grava em
 * `chrome.storage`. Pula se o resultado já é o que está lá (sem mudança real).
 */
function pushToExtension(): void {
  void chrome.storage.local.get([STORAGE_KEY], (result) => {
    const extRaw = typeof result[STORAGE_KEY] === 'string' ? (result[STORAGE_KEY] as string) : null;
    const appRaw = localStorage.getItem(STORAGE_KEY);

    const extPrefs = parsePrefs(extRaw);
    const appPrefs = parsePrefs(appRaw);
    const merged = mergeUrlFavorites(appPrefs.favorites, extPrefs.favorites);
    const toWrite = JSON.stringify({ ...extPrefs, favorites: merged });

    if (toWrite === extRaw) return; // nada a mudar
    lastWrittenByUs = toWrite;
    void chrome.storage.local.set({ [STORAGE_KEY]: toWrite });
  });
}

/**
 * Recebe novo valor do `chrome.storage` (alteração feita pela extensão) e
 * atualiza o `localStorage` do app, preservando favoritos `kind:'file'`.
 */
function pullFromExtension(extRaw: string): void {
  if (extRaw === lastWrittenByUs) return; // nós escrevemos isso, não é mudança externa

  const appRaw = localStorage.getItem(STORAGE_KEY);
  const appPrefs = parsePrefs(appRaw);
  const extPrefs = parsePrefs(extRaw);

  const fileFavs = appPrefs.favorites.filter((f) => f.kind === 'file');
  const urlFavs = mergeUrlFavorites(appPrefs.favorites, extPrefs.favorites);
  // Arquivo no fim: não interferem com a ordem dos efeitos de URL.
  const merged = [...urlFavs, ...fileFavs];

  const next = JSON.stringify({ ...appPrefs, favorites: merged });
  if (next !== appRaw) localStorage.setItem(STORAGE_KEY, next);
}

// ── Sync inicial ao carregar ──────────────────────────────────────────────────
void chrome.storage.local.get([STORAGE_KEY], (result) => {
  const extRaw = typeof result[STORAGE_KEY] === 'string' ? (result[STORAGE_KEY] as string) : null;
  if (extRaw) pullFromExtension(extRaw);
  pushToExtension();
});

// ── Extensão → App (tempo real via chrome.storage.onChanged) ─────────────────
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const change = changes[STORAGE_KEY];
  if (!change) return;
  const newValue = change.newValue as unknown;
  if (typeof newValue === 'string') pullFromExtension(newValue);
});

// ── App → Extensão (polling a cada 10 s) ─────────────────────────────────────
let lastAppRaw: string | null = localStorage.getItem(STORAGE_KEY);
setInterval(() => {
  const current = localStorage.getItem(STORAGE_KEY);
  if (current !== lastAppRaw) {
    lastAppRaw = current;
    pushToExtension();
  }
}, 10_000);
