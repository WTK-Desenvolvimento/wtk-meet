/**
 * Armazenamento de arquivos de áudio locais no IndexedDB.
 *
 * Módulo **puro de I/O**: sem React, sem localStorage. Guarda `Blob`s no
 * IndexedDB nativo (sem libs como idb ou Dexie) para que arquivos enviados pelo
 * usuário sobrevivam ao reload da página.
 *
 * Toda função degrada silenciosamente se o IndexedDB não estiver disponível
 * (ex.: modo privado restrito): nenhuma lança erro para o chamador.
 *
 * @see ARCHITECTURE.md §6.13 — Soundboard
 */

const DB_NAME = 'wtk-soundboard';
const STORE_NAME = 'audio-files';
const DB_VERSION = 1;

interface StoredAudio {
  id: string;
  name: string;
  type: string;
  blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = (event) => resolve((event.target as IDBOpenDBRequest).result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Abre o seletor de arquivo nativo do sistema operacional.
 *
 * Tenta `window.showOpenFilePicker` (File System Access API). Se o usuário
 * cancelar (`AbortError`) devolve `null`. Se a API não estiver disponível ou
 * lançar outro erro, cai no fallback com `<input type="file">` temporário.
 */
export async function pickAudioFile(): Promise<File | null> {
  // Tenta a File System Access API primeiro (Chrome, Edge ≥ 86).
  // `showOpenFilePicker` pode não estar nos tipos do TS — cast necessário.
  const win = window as Window &
    typeof globalThis & {
      showOpenFilePicker?: (opts?: unknown) => Promise<FileSystemFileHandle[]>;
    };

  if (typeof win.showOpenFilePicker === 'function') {
    try {
      const [handle] = await win.showOpenFilePicker({
        types: [
          {
            description: 'Áudio',
            accept: { 'audio/*': ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac'] },
          },
        ],
        multiple: false,
      });
      return await handle.getFile();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
      // Qualquer outro erro (permissões, API quebrada etc.) cai no fallback.
    }
  }

  // Fallback: <input type="file"> temporário.
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'audio/*';

    const cleanup = () => {
      try {
        document.body.removeChild(input);
      } catch {
        // já foi removido
      }
    };

    input.addEventListener('change', () => {
      cleanup();
      resolve(input.files?.[0] ?? null);
    });

    // Evento 'cancel' é suportado em navegadores modernos (Chrome 113+, Firefox 91+).
    input.addEventListener('cancel', () => {
      cleanup();
      resolve(null);
    });

    // O input precisa estar no DOM para funcionar em alguns navegadores.
    input.style.display = 'none';
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Persiste um arquivo de áudio no IndexedDB sob a chave `id`.
 * Silencia qualquer falha (IndexedDB indisponível, cota excedida etc.).
 */
export async function saveAudioFile(id: string, file: File): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const record: StoredAudio = { id, name: file.name, type: file.type, blob: file };
      const req = store.put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => {
        db.close();
      };
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Degrada silenciosamente — o arquivo não persiste nesta sessão.
  }
}

/**
 * Lê um arquivo de áudio do IndexedDB. Retorna `null` se não encontrar ou
 * se o IndexedDB não estiver disponível.
 */
export async function loadAudioFile(id: string): Promise<File | null> {
  try {
    const db = await openDb();
    const record = await new Promise<StoredAudio | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(id) as IDBRequest<StoredAudio | undefined>;
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => {
        db.close();
      };
    });
    if (!record) return null;
    return new File([record.blob], record.name, { type: record.type });
  } catch {
    return null;
  }
}

/**
 * Remove um arquivo de áudio do IndexedDB. Silencia qualquer falha.
 */
export async function removeAudioFile(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const req = store.delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => {
        db.close();
      };
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    // Degrada silenciosamente.
  }
}
