import { useState, type FormEvent } from 'react';

import { pickAudioFile } from '../lib/audioFileStorage.js';
import type { Favorite } from '../lib/soundboard.js';
import type { SoundboardActivity } from '../lib/useMusicRoom.js';

/** Uma pessoa da sala, do ponto de vista do controle de mute por participante. */
export interface SoundboardPerson {
  peerId: string;
  name: string;
}

export interface SoundboardPanelProps {
  favorites: readonly Favorite[];
  activity: readonly SoundboardActivity[];
  people: readonly SoundboardPerson[];
  /** Peers que estouraram o limite de entrada: o mute fica a um clique. */
  floodingPeerIds: readonly string[];
  mutedAll: boolean;
  mutedPeerIds: readonly string[];
  volume: number;
  cooldownMs: number;
  error: string | null;
  selfId: string;
  onClose: () => void;
  onAdd: (input: string) => boolean;
  onAddFile: (file: File) => Promise<boolean>;
  onRemove: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onPlay: (favorite: Favorite) => void;
  onVolume: (value: number) => void;
  onToggleMutedAll: () => void;
  onTogglePeerMuted: (peerId: string) => void;
}

/**
 * O painel do soundboard — **à esquerda** do palco, irmão do `VideoGrid` dentro
 * do `.stage` (que é um flex row). Ele empurra a grade em vez de flutuar por
 * cima dela: §6.7 é dura, a página nunca rola, e um painel flutuante cobriria
 * tiles e o card de votação, que é um preço que este projeto já pagou uma vez.
 *
 * Duas coisas que **não** estão aqui, e é de propósito:
 *
 * 1. **Nenhum `<audio>`.** O som do soundboard sai pelo canal de música do mesh
 *    e pelos elementos do `RemoteMusicAudio`, que ficam fora de qualquer painel.
 *    Um elemento de áudio aqui dentro emudeceria a sala ao fechar o painel, e o
 *    sintoma pareceria rede.
 * 2. **Nenhum `<audio>` de monitoração.** O som já chega pelo `RemoteMusicAudio`
 *    e pelo ramo de monitor do `SoundboardPlayer`; um elemento extra duplicaria.
 *
 * O aviso do mute por participante não é enfeite: no fio, o efeito e a música do
 * player vêm mixados no **mesmo** sinal daquele peer, e nenhum receptor consegue
 * separá-los. Silenciar alguém emudece também a faixa que essa pessoa esteja
 * transmitindo, enquanto o efeito dura.
 */
export default function SoundboardPanel({
  favorites,
  activity,
  people,
  floodingPeerIds,
  mutedAll,
  mutedPeerIds,
  volume,
  cooldownMs,
  error,
  selfId,
  onClose,
  onAdd,
  onAddFile,
  onRemove,
  onRename,
  onPlay,
  onVolume,
  onToggleMutedAll,
  onTogglePeerMuted,
}: SoundboardPanelProps) {
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [titleDraft, setTitleDraft] = useState('');
  const [uploading, setUploading] = useState(false);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    // O texto só sai do campo quando entrou de verdade: numa recusa, corrigir
    // um caractere é melhor que colar tudo de novo.
    if (onAdd(value)) setDraft('');
  }

  async function handleFileClick() {
    const file = await pickAudioFile();
    if (!file) return;
    setUploading(true);
    try {
      await onAddFile(file);
    } finally {
      setUploading(false);
    }
  }

  function commitTitle(favorite: Favorite) {
    onRename(favorite.id, titleDraft);
    setEditing(null);
  }

  const esperando = cooldownMs > 0;
  const nomePor = (peerId: string) =>
    peerId === selfId ? 'Você' : people.find((p) => p.peerId === peerId)?.name || 'Alguém';

  return (
    <aside className="soundboard-panel" aria-label="Soundboard">
      <header className="soundboard-header">
        <div>
          <strong>Soundboard</strong>
          <span className="soundboard-subtitle">
            Favoritos deste navegador · o efeito vai para a sala inteira
          </span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar soundboard">
          ✕
        </button>
      </header>

      <form className="soundboard-add" onSubmit={handleSubmit}>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Cole a URL de um efeito (mp3, ogg…)"
          aria-label="URL do efeito"
        />
        <button type="submit">Favoritar</button>
        <button type="button" onClick={handleFileClick} disabled={uploading}>
          {uploading ? 'Carregando…' : 'Upload'}
        </button>
      </form>

      {error && (
        <p className="soundboard-error" role="status">
          {error}
        </p>
      )}

      {esperando && (
        <p className="soundboard-cooldown" role="status">
          Aguarde {Math.ceil(cooldownMs / 1000)}s para disparar de novo.
        </p>
      )}

      <section className="soundboard-grid" aria-label="Favoritos">
        {favorites.length === 0 && (
          <p className="soundboard-empty">
            Nenhum favorito ainda. Cole a URL de um efeito acima para começar.
          </p>
        )}
        {favorites.map((favorite) => (
          <div className="soundboard-item" key={favorite.id}>
            {editing === favorite.id ? (
              <input
                className="soundboard-rename"
                type="text"
                value={titleDraft}
                autoFocus
                aria-label={`Novo nome de ${favorite.title}`}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={() => commitTitle(favorite)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') commitTitle(favorite);
                  if (event.key === 'Escape') setEditing(null);
                }}
              />
            ) : (
              <button
                type="button"
                className="soundboard-play"
                disabled={esperando}
                title={favorite.sourceRef}
                onClick={() => onPlay(favorite)}
              >
                {favorite.title}
              </button>
            )}
            <button
              type="button"
              className="icon-button"
              aria-label={`Renomear ${favorite.title}`}
              onClick={() => {
                setEditing(favorite.id);
                setTitleDraft(favorite.title);
              }}
            >
              ✎
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label={`Remover ${favorite.title}`}
              onClick={() => onRemove(favorite.id)}
            >
              ✕
            </button>
          </div>
        ))}
      </section>

      <section className="soundboard-mutes" aria-label="Silenciar">
        <label className="soundboard-volume">
          Volume
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={(event) => onVolume(Number(event.target.value))}
            aria-label="Volume do soundboard para a sala"
          />
        </label>
        <label className="soundboard-mute-all">
          <input type="checkbox" checked={mutedAll} onChange={onToggleMutedAll} />
          Silenciar o soundboard de todo mundo (só para mim)
        </label>
        {people.length > 0 && (
          <ul className="soundboard-people">
            {people.map((person) => (
              <li key={person.peerId}>
                <label>
                  <input
                    type="checkbox"
                    checked={mutedPeerIds.includes(person.peerId)}
                    onChange={() => onTogglePeerMuted(person.peerId)}
                  />
                  Silenciar {person.name}
                </label>
                {floodingPeerIds.includes(person.peerId) && (
                  <span className="soundboard-flood" role="status">
                    disparando demais
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="soundboard-note">
          Silenciar alguém vale só para você e não é enviado a ninguém. Enquanto o efeito dura, a
          música que essa pessoa estiver transmitindo também fica muda — no fio os dois são o mesmo
          sinal.
        </p>
      </section>

      <section className="soundboard-activity" aria-label="Disparos recentes">
        {activity.length === 0 ? (
          <p className="soundboard-empty">Nada tocou ainda.</p>
        ) : (
          <ul>
            {activity.map((item) => (
              <li key={item.id}>
                <strong>{nomePor(item.peerId)}</strong> tocou {item.title}
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
