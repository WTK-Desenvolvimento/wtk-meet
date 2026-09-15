/**
 * `chrome.storage.local` com cara de `localStorage`.
 *
 * `lib/soundboard.ts` do client espera um objeto *storage-like* **síncrono**
 * (`getItem`/`setItem`) — e é assim de propósito: é o que o mantém puro e
 * testável em `node --test`. `chrome.storage.local` é assíncrono. O adaptador
 * fecha a distância com um cache em memória hidratado **antes** do primeiro uso:
 * o boot do motor e o de cada página de UI aguardam `hydrate()`, e daí em diante
 * a leitura é do cache e a escrita é *write-through*.
 *
 * **O valor gravado é a mesma string JSON que o app grava no `localStorage`**,
 * sob a mesma chave (`wtk-meet:soundboard`) e na mesma versão de esquema. Não é
 * detalhe: é o que permite copiar a lista de favoritos de um lado para o outro
 * sem conversão, e o que faz `readSoundboard`/`writeSoundboard` do client
 * valerem aqui sem uma linha de tradução.
 *
 * `chrome.storage.onChanged` atualiza o cache nos **outros** contextos — é o que
 * mantém popup, `manager` e motor com a mesma lista de favoritos depois de uma
 * edição em qualquer um deles.
 */

import type { PreferenceStorage } from '../../../client/src/lib/soundboard.js';
import { STORAGE_KEY as SOUNDBOARD_KEY } from '../../../client/src/lib/soundboard.js';
import { runtimeStorage } from './chromeCommon.js';

/** Preferências da própria extensão. Análoga a `wtk-meet:devices` no app. */
export const EXTENSION_KEY = 'wtk-meet:extension';

export { SOUNDBOARD_KEY };

export interface ExtensionPreferences {
  /** Último endereço de sala usado. É o que o popup oferece fora do Meet. */
  lastRoom: string;
  /** Nome com que o motor aparece na sala. */
  displayName: string;
  /** URL do servidor de sinalização. */
  signalingUrl: string;
  /** Origem do app web, usada para montar o link de convite. */
  appUrl: string;
  /** Volume de monitoração local (`0..1`). Nunca trafega. */
  volume: number;
}

export const DEFAULT_EXTENSION_PREFERENCES: ExtensionPreferences = {
  lastRoom: '',
  displayName: 'Música (extensão)',
  signalingUrl: 'http://localhost:4000',
  appUrl: 'http://localhost:5173',
  volume: 1,
};

/** Normaliza o que veio do disco. Nunca lança: valor estranho vira default. */
export function sanitizePreferences(raw: unknown): ExtensionPreferences {
  const base = { ...DEFAULT_EXTENSION_PREFERENCES };
  if (typeof raw !== 'object' || raw === null) return base;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.lastRoom === 'string') base.lastRoom = obj.lastRoom.slice(0, 64);
  if (typeof obj.displayName === 'string' && obj.displayName.trim()) {
    base.displayName = obj.displayName.trim().slice(0, 40);
  }
  if (typeof obj.signalingUrl === 'string' && obj.signalingUrl.trim()) {
    base.signalingUrl = obj.signalingUrl.trim();
  }
  if (typeof obj.appUrl === 'string' && obj.appUrl.trim()) base.appUrl = obj.appUrl.trim();
  if (typeof obj.volume === 'number' && Number.isFinite(obj.volume)) {
    base.volume = Math.min(1, Math.max(0, obj.volume));
  }
  return base;
}

/**
 * O adaptador. Uma instância por contexto (o motor tem a sua, cada página de UI
 * tem a sua) — o que as mantém coerentes é o `onChanged`, e não um singleton.
 */
export class ChromeLocalStorage implements PreferenceStorage {
  private cache = new Map<string, string>();
  private hydrated = false;
  /** Avisados quando outro contexto escreve. O motor usa para reemitir estado. */
  private listeners = new Set<(key: string) => void>();

  /**
   * Lê o disco uma vez e passa a escutar mudanças. Idempotente: chamar duas
   * vezes não duplica o listener nem relê.
   */
  async hydrate(keys: string[] = [SOUNDBOARD_KEY, EXTENSION_KEY]): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const stored = await runtimeStorage.local.get(keys);
    for (const key of keys) {
      const value = stored[key];
      if (typeof value === 'string') this.cache.set(key, value);
    }
    runtimeStorage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      for (const [key, change] of Object.entries(changes)) {
        if (typeof change.newValue === 'string') this.cache.set(key, change.newValue);
        else this.cache.delete(key);
        for (const listener of this.listeners) listener(key);
      }
    });
  }

  onExternalChange(listener: (key: string) => void): void {
    this.listeners.add(listener);
  }

  getItem(key: string): string | null {
    return this.cache.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.cache.set(key, value);
    // *Write-through* com a promessa deliberadamente solta: quem chamou é código
    // síncrono do módulo puro, que não tem onde esperar. Uma falha de cota aqui
    // é um favorito que não sobrevive ao reload — e o `catch` vazio é melhor que
    // uma rejeição não tratada que derruba o motor no meio de uma faixa.
    runtimeStorage.local.set({ [key]: value }).catch(() => {});
  }

  /** As preferências da extensão, já normalizadas. */
  readPreferences(): ExtensionPreferences {
    const raw = this.getItem(EXTENSION_KEY);
    if (!raw) return { ...DEFAULT_EXTENSION_PREFERENCES };
    try {
      return sanitizePreferences(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_EXTENSION_PREFERENCES };
    }
  }

  writePreferences(prefs: ExtensionPreferences): ExtensionPreferences {
    const limpo = sanitizePreferences(prefs);
    this.setItem(EXTENSION_KEY, JSON.stringify(limpo));
    return limpo;
  }
}
