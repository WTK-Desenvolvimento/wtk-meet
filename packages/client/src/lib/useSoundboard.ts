/**
 * O soundboard do ponto de vista **desta aba**: favoritos, a mensagem de erro do
 * campo e as duas escolhas de mute do ouvinte.
 *
 * É a fronteira entre o módulo puro (`lib/soundboard.js`) e o mundo real
 * (`localStorage`), no mesmo papel que `useMusicRoom` faz para o protocolo. Tudo
 * o que é regra — validar URL, deduplicar, contar o teto — mora lá; aqui só
 * acontece I/O e estado de React.
 *
 * **Nada daqui trafega.** Favorito é do navegador (a mesma regra de
 * `wtk-meet:devices`), e a escolha de silenciar é do ouvinte: ela não vira
 * mensagem, não é publicada e não altera o volume da música nem o microfone de
 * ninguém. O que ela faz é emudecer, localmente, o `<audio>` do peer durante a
 * janela do efeito (ver `useMusicRoom`).
 *
 * **A lista de participantes silenciados não persiste**, e isso é decisão, não
 * esquecimento: `peerId` é o socket id daquela sessão e muda a cada reload de
 * qualquer um dos dois lados. Gravá-la seria, na melhor das hipóteses, guardar
 * lixo — e na pior, silenciar a pessoa errada na próxima sala.
 */

import { useCallback, useMemo, useRef, useState } from 'react';

import {
  SOUNDBOARD_ERRORS,
  addFavorite as addFavoritePure,
  addFileFavorite,
  readSoundboard,
  removeFavorite as removeFavoritePure,
  renameFavorite as renameFavoritePure,
  writeSoundboard,
} from './soundboard.js';

import { removeAudioFile, saveAudioFile } from './audioFileStorage.js';

import type { Favorite, PreferenceStorage, SoundboardPreferences } from './soundboard.js';

export interface UseSoundboardOptions {
  /** Injetável para teste; no navegador é o `window.localStorage`. */
  storage?: PreferenceStorage | null;
}

function mensagem(reason: string | undefined): string {
  return (reason && SOUNDBOARD_ERRORS[reason]) || 'Não consegui fazer isso agora.';
}

export function useSoundboard({ storage }: UseSoundboardOptions = {}) {
  // Lido **na montagem**: é isto que faz os favoritos sobreviverem ao reload.
  // O módulo puro nunca lança, então não há try aqui.
  const [prefs, setPrefs] = useState<SoundboardPreferences>(() => readSoundboard(storage));
  const [error, setError] = useState<string | null>(null);
  const [mutedPeers, setMutedPeers] = useState<string[]>([]);
  const storageRef = useRef(storage);
  storageRef.current = storage;

  /** Grava e adota o resultado efetivo — nunca o que se pediu. */
  const commit = useCallback((next: SoundboardPreferences) => {
    setPrefs(writeSoundboard(storageRef.current, next));
  }, []);

  /**
   * Favorita o que está no campo. Devolve `true` só quando entrou — a UI usa
   * isso para decidir se limpa o campo. Na recusa o texto **permanece** lá, com
   * a mensagem embaixo: apagar o que a pessoa colou obrigaria a colar de novo
   * para corrigir um caractere.
   */
  const add = useCallback(
    (input: string): boolean => {
      const result = addFavoritePure(prefs, input, { now: Date.now() });
      if (!result.ok) {
        setError(mensagem(result.reason));
        return false;
      }
      setError(null);
      commit(result.prefs);
      return true;
    },
    [commit, prefs],
  );

  const remove = useCallback(
    (id: string) => {
      setError(null);
      // Se for favorito de arquivo, limpa do IndexedDB (fire-and-forget).
      const fav = prefs.favorites.find((f) => f.id === id);
      if (fav?.kind === 'file' && fav.fileId) {
        removeAudioFile(fav.fileId).catch(() => {});
      }
      commit(removeFavoritePure(prefs, id));
    },
    [commit, prefs],
  );

  /**
   * Adiciona um arquivo de áudio local como favorito.
   * Persiste o `File` no IndexedDB e registra o favorito no localStorage.
   * Retorna `true` apenas quando entrou com sucesso.
   */
  const addFile = useCallback(
    async (file: File): Promise<boolean> => {
      const fileId = `sf-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      try {
        await saveAudioFile(fileId, file);
      } catch {
        setError(mensagem('file-pick-failed'));
        return false;
      }
      const result = addFileFavorite(prefs, file, { fileId, now: Date.now() });
      if (!result.ok) {
        setError(mensagem(result.reason));
        return false;
      }
      setError(null);
      commit(result.prefs);
      return true;
    },
    [commit, prefs],
  );

  const rename = useCallback(
    (id: string, title: string) => {
      commit(renameFavoritePure(prefs, id, title));
    },
    [commit, prefs],
  );

  /** Mute global do ouvinte. Persiste (é preferência de UI, não de sala). */
  const toggleMutedAll = useCallback(() => {
    commit({ ...prefs, mutedAll: !prefs.mutedAll });
  }, [commit, prefs]);

  /** Mute de um participante. **Não** persiste, pelo motivo do cabeçalho. */
  const togglePeerMuted = useCallback((peerId: string) => {
    setMutedPeers((prev) =>
      prev.includes(peerId) ? prev.filter((id) => id !== peerId) : [...prev, peerId],
    );
  }, []);

  const mutedPeerSet = useMemo(() => new Set(mutedPeers), [mutedPeers]);

  /**
   * A pergunta que `useMusicRoom` faz quando um anúncio chega. Vai como função
   * (e não como lista) porque o que o hook precisa é do valor **do instante** em
   * que a mensagem chega, não do que estava valendo no último render.
   */
  const isMuted = useCallback(
    (peerId: string) => prefs.mutedAll || mutedPeerSet.has(peerId),
    [mutedPeerSet, prefs.mutedAll],
  );

  /** Traduz o resultado de um disparo em mensagem de painel (ou limpa a antiga). */
  const reportFire = useCallback((result: { ok: boolean; reason?: string }) => {
    setError(result.ok ? null : mensagem(result.reason));
  }, []);

  return {
    favorites: prefs.favorites as readonly Favorite[],
    mutedAll: prefs.mutedAll,
    mutedPeerIds: mutedPeers,
    error,
    clearError: useCallback(() => setError(null), []),
    add,
    addFile,
    remove,
    rename,
    toggleMutedAll,
    togglePeerMuted,
    isMuted,
    reportFire,
  };
}
