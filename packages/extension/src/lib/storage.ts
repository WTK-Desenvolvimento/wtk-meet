/**
 * `chrome.storage.local` com cara de `localStorage` — e o desvio que o
 * documento offscreen obriga.
 *
 * **Duas coisas, e a segunda foi medida, não deduzida:**
 *
 * 1. `lib/soundboard.ts` do client espera um objeto *storage-like* **síncrono**
 *    (`getItem`/`setItem`), e é assim de propósito: é o que o mantém puro e
 *    testável em `node --test`. `chrome.storage.local` é assíncrono. O adaptador
 *    fecha a distância com um cache em memória hidratado **antes** do primeiro
 *    uso: o boot de cada contexto aguarda `hydrate()`, e daí em diante a leitura
 *    é do cache e a escrita é *write-through*.
 *
 * 2. **O documento offscreen não tem `chrome.storage`.** Ele tem `chrome.runtime`
 *    e praticamente nada mais — `chrome.storage.local` é `undefined` lá dentro, e
 *    o sintoma é um `TypeError: Cannot read properties of undefined (reading
 *    'local')` dentro de um boot assíncrono cuja rejeição ninguém vê: o documento
 *    existe, responde, e a UI espera para sempre um estado que nunca chega.
 *    Verificado no Chromium em 2026-09-15; o documento de arquitetura desta
 *    entrega afirmava o contrário (§7.4 listava `chrome.storage` como disponível
 *    no motor), e é esta a correção.
 *
 *    Daí os dois *backends*: quem tem a API usa a API (`directBackend`); o motor
 *    pede ao service worker por mensagem (`messageBackend`). O resto do código —
 *    inclusive `soundboard.ts` — não sabe a diferença.
 *
 * **O valor gravado é a mesma string JSON que o app grava no `localStorage`**,
 * sob a mesma chave (`wtk-meet:soundboard`) e na mesma versão de esquema. É o
 * que permite copiar a lista de favoritos de um lado para o outro sem conversão.
 */

import type { PreferenceStorage } from '../../../client/src/lib/soundboard.js';
import { STORAGE_KEY as SOUNDBOARD_KEY } from '../../../client/src/lib/soundboard.js';
import { runtime, runtimeStorage } from './chromeCommon.js';

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

/** O mínimo que um contexto precisa saber fazer com o disco. */
export interface StorageBackend {
  readAll(keys: string[]): Promise<Record<string, string>>;
  write(key: string, value: string): void;
  /** Avisa quando **outro** contexto escreveu. */
  subscribe(listener: (key: string, value: string | null) => void): void;
}

/** Quem tem `chrome.storage` (service worker, popup, `manager`). */
export function directBackend(): StorageBackend {
  return {
    async readAll(keys) {
      const stored = await runtimeStorage.local.get(keys);
      const out: Record<string, string> = {};
      for (const key of keys) {
        const value = stored[key];
        if (typeof value === 'string') out[key] = value;
      }
      return out;
    },
    write(key, value) {
      // A promessa fica deliberadamente solta: quem chamou é código síncrono do
      // módulo puro, que não tem onde esperar. Uma falha de cota aqui é um
      // favorito que não sobrevive ao reload — melhor que uma rejeição não
      // tratada derrubando o motor no meio de uma faixa.
      void runtimeStorage.local.set({ [key]: value }).catch(() => {});
    },
    subscribe(listener) {
      runtimeStorage.onChanged.addListener((changes, areaName) => {
        if (areaName !== 'local') return;
        for (const [key, change] of Object.entries(changes)) {
          listener(key, typeof change.newValue === 'string' ? change.newValue : null);
        }
      });
    },
  };
}

/**
 * Quem **não** tem `chrome.storage`: o documento offscreen. Tudo vira mensagem
 * ao service worker, que é quem tem a API.
 */
export function messageBackend(): StorageBackend {
  return {
    async readAll(keys) {
      const resposta = (await runtime.sendMessage({ target: 'sw', type: 'storage-get', keys })) as
        | { values?: Record<string, string> }
        | undefined;
      return resposta?.values ?? {};
    },
    write(key, value) {
      void runtime.sendMessage({ target: 'sw', type: 'storage-set', key, value }).catch(() => {
        // O service worker estava dormindo e acordou tarde demais: a escrita
        // seguinte reenvia o valor inteiro (é sempre o documento completo).
      });
    },
    subscribe(listener) {
      runtime.onMessage.addListener((message) => {
        const msg = message as { target?: string; type?: string; key?: string; value?: unknown };
        if (msg?.target !== 'engine' || msg.type !== 'storage-changed') return undefined;
        listener(String(msg.key), typeof msg.value === 'string' ? msg.value : null);
        return undefined;
      });
    },
  };
}

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
 * O adaptador. Uma instância por contexto — o que as mantém coerentes é o
 * `subscribe` do backend, e não um singleton.
 */
export class ChromeLocalStorage implements PreferenceStorage {
  private cache = new Map<string, string>();
  private hydrated = false;
  private backend: StorageBackend;
  /** Avisados quando outro contexto escreve. O motor usa para reemitir estado. */
  private listeners = new Set<(key: string) => void>();

  constructor(backend: StorageBackend = directBackend()) {
    this.backend = backend;
  }

  /**
   * Lê o disco uma vez e passa a escutar mudanças. Idempotente: chamar duas
   * vezes não duplica o listener nem relê.
   */
  async hydrate(keys: string[] = [SOUNDBOARD_KEY, EXTENSION_KEY]): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const stored = await this.backend.readAll(keys);
    for (const [key, value] of Object.entries(stored)) this.cache.set(key, value);
    this.backend.subscribe((key, value) => {
      if (value === null) this.cache.delete(key);
      else this.cache.set(key, value);
      for (const listener of this.listeners) listener(key);
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
    this.backend.write(key, value);
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
