/**
 * A superfície de `chrome.*` que esta extensão usa — declarada à mão, e não
 * pelo `@types/chrome`.
 *
 * Duas razões, e a segunda é a que importa:
 *
 * 1. Nenhuma dependência nova na árvore (a mesma troca que o `ARCHITECTURE.md`
 *    §7 vem defendendo desde a WTK-MEET-20).
 * 2. **`@types/chrome` tipa toda a API como se estivesse disponível em todo
 *    contexto.** Ela não está: o documento offscreen não tem `chrome.tabs`,
 *    `chrome.action` nem `chrome.permissions`, e um `chrome.action.setBadgeText`
 *    lá dentro é `TypeError` em runtime, não erro de compilação. Aqui,
 *    `chrome.tabs`, `chrome.action` e `chrome.offscreen` moram numa interface
 *    separada (`ChromePrivileged`), e o motor não fala `chrome` direto: ele
 *    importa `lib/chromeCommon.ts`, que expõe **só** `runtime` e `storage`, e
 *    o lint recusa o global `chrome` dentro de `offscreen.ts` e de `engine/`.
 *    É o que transforma a regra do §7.4 do documento de arquitetura em algo
 *    que alguém cobra antes do runtime.
 *
 * O que está aqui é só o que é chamado. Acrescentar campo é barato; o que não
 * se deve fazer é copiar a API inteira de volta.
 */

/** Uma porta de longa duração (`chrome.runtime.connect`). */
interface ChromePort {
  name: string;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: ChromeEvent<(message: unknown, port: ChromePort) => void>;
  onDisconnect: ChromeEvent<(port: ChromePort) => void>;
  sender?: { url?: string; tab?: { id?: number } };
}

interface ChromeEvent<T extends (...args: never[]) => unknown> {
  addListener(callback: T): void;
  removeListener(callback: T): void;
  hasListener?(callback: T): boolean;
}

interface ChromeStorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

interface ChromeStorageArea {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

/** O que **todo** contexto da extensão tem: `runtime` e `storage`. */
interface ChromeCommon {
  runtime: {
    id?: string;
    lastError?: { message?: string };
    getURL(path: string): string;
    connect(info?: { name?: string }): ChromePort;
    sendMessage(message: unknown): Promise<unknown>;
    onConnect: ChromeEvent<(port: ChromePort) => void>;
    onMessage: ChromeEvent<
      (message: unknown, sender: unknown, sendResponse: (response?: unknown) => void) => boolean | void
    >;
    onInstalled: ChromeEvent<() => void>;
    getContexts?(filter: { contextTypes?: string[] }): Promise<{ contextId: string; contextType: string }[]>;
  };
  storage: {
    local: ChromeStorageArea;
    session?: ChromeStorageArea;
    onChanged: ChromeEvent<(changes: Record<string, ChromeStorageChange>, areaName: string) => void>;
  };
}

/**
 * O que **só o service worker** (e as páginas de UI, no caso de `tabs.create`)
 * tem. Importar isto de dentro de `offscreen.ts` é o erro que a separação existe
 * para impedir.
 */
interface ChromePrivileged extends ChromeCommon {
  tabs: {
    query(info: { active?: boolean; currentWindow?: boolean; url?: string | string[] }): Promise<
      { id?: number; url?: string; pendingUrl?: string; title?: string }[]
    >;
    create(info: { url: string }): Promise<{ id?: number }>;
  };
  action: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    setTitle(details: { title: string }): Promise<void>;
  };
  offscreen: {
    createDocument(params: { url: string; reasons: string[]; justification: string }): Promise<void>;
    hasDocument(): Promise<boolean>;
    closeDocument(): Promise<void>;
  };
}

declare const chrome: ChromePrivileged;
