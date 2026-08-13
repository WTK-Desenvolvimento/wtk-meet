import { useEffect, useRef, useState } from 'react';
import { formatDuration } from '../lib/musicSources.js';

/**
 * Painel do player colaborativo — faixa atual, fila e o formulário de adicionar.
 *
 * Segue o modelo do `ChatPanel` (um `aside` dentro do palco, com a lista em
 * `overflow-y: auto`) por uma razão de layout, não de estética: a página desta
 * aplicação **nunca rola**, e uma fila crescendo com altura de conteúdo furaria
 * essa invariante em silêncio. Chat e música são mutuamente exclusivos pelo mesmo
 * motivo — dois painéis abertos espremem a grade até os tiles baterem no piso de
 * legibilidade.
 *
 * A UI toda é uma **projeção do estado replicado**: este componente não decide
 * nada sozinho, só chama as ações. Quem pode pausar, quem transmite e quem
 * assume quando alguém cai são perguntas respondidas em `lib/useMusicRoom.js`.
 */
export default function MusicPanel({
  queue,
  currentEntry,
  playback,
  position,
  isOwner,
  volume,
  onVolume,
  onClose,
  onAdd,
  onRemove,
  onPause,
  onResume,
  onSkip,
  youtubeEnabled,
  notice,
  onDismissNotice,
  audioBlocked,
  onUnlock,
  selfId,
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => onDismissNotice?.(), 6000);
    return () => clearTimeout(timer);
  }, [notice, onDismissNotice]);

  async function handleSubmit(event) {
    event.preventDefault();
    const value = draft.trim();
    if (!value || busy) return;
    setBusy(true);
    const ok = await onAdd(value, null);
    setBusy(false);
    if (ok) setDraft('');
  }

  async function handleFile(event) {
    const file = event.target.files?.[0];
    // Limpa o input antes de qualquer await: escolher o mesmo arquivo duas
    // vezes seguidas não dispara `change` se o valor continuar lá.
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    await onAdd(null, file);
    setBusy(false);
  }

  const duration = currentEntry?.durationSec || null;
  const progress = duration ? Math.min(100, (position / duration) * 100) : 0;

  return (
    <aside className="music-panel" aria-label="Player de música da sala">
      <header className="music-header">
        <div>
          <strong>Música</strong>
          <span className="music-subtitle">Fila colaborativa, P2P — some ao esvaziar a sala</span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar player">
          ✕
        </button>
      </header>

      {audioBlocked && (
        <button type="button" className="music-unlock" onClick={onUnlock}>
          Clique para ouvir a música
        </button>
      )}

      {notice && (
        <p className="music-notice" role="status">
          {notice}
        </p>
      )}

      <section className="music-now" aria-label="Tocando agora">
        {currentEntry ? (
          <>
            <p className="music-now-title" title={currentEntry.title}>
              {currentEntry.title}
            </p>
            <p className="music-now-meta">
              por {currentEntry.addedByName}
              {playback.delivery === 'local' ? ' · tocando na sua máquina' : ' · retransmitida'}
              {isOwner ? ' · você transmite' : ''}
            </p>
            <div className="music-progress" aria-hidden="true">
              <div className="music-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <p className="music-time">
              {formatDuration(position)} / {formatDuration(duration)}
            </p>
            <div className="music-actions">
              <button type="button" onClick={playback.playing ? onPause : onResume}>
                {playback.playing ? 'Pausar' : 'Tocar'}
              </button>
              <button type="button" onClick={onSkip}>
                Pular
              </button>
            </div>
          </>
        ) : (
          <p className="music-empty">Nada tocando. Adicione a primeira faixa abaixo.</p>
        )}

        <label className="music-volume">
          Volume
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={volume}
            onChange={(event) => onVolume(Number(event.target.value))}
            aria-label="Volume da música (só para você)"
          />
        </label>
      </section>

      <ul className="music-queue">
        {queue.length === 0 ? (
          <li className="music-empty">A fila está vazia.</li>
        ) : (
          queue.map((entry) => (
            <li
              key={entry.id}
              className={`music-queue-item${entry.id === playback.entryId ? ' current' : ''}`}
            >
              <span className="music-queue-kind" aria-hidden="true">
                {entry.kind === 'youtube' ? 'YT' : entry.kind === 'file' ? 'MP3' : 'URL'}
              </span>
              <span className="music-queue-title" title={entry.title}>
                {entry.title}
              </span>
              <span className="music-queue-by">
                {entry.addedBy === selfId ? 'você' : entry.addedByName}
              </span>
              <span className="music-queue-duration">{formatDuration(entry.durationSec)}</span>
              <button
                type="button"
                className="icon-button"
                onClick={() => onRemove(entry.id)}
                aria-label={`Remover ${entry.title}`}
              >
                ✕
              </button>
            </li>
          ))
        )}
      </ul>

      <form className="music-composer" onSubmit={handleSubmit}>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={youtubeEnabled ? 'Link do YouTube ou URL de áudio' : 'URL de áudio'}
          aria-label="Adicionar faixa por link"
          maxLength={300}
        />
        <button type="submit" disabled={!draft.trim() || busy}>
          Adicionar
        </button>
        <button type="button" onClick={() => fileInputRef.current?.click()} disabled={busy}>
          Arquivo
        </button>
        {/* O arquivo nunca sai desta máquina: o que trafega é o áudio já
            decodificado, pelo canal de música do mesh. */}
        <input
          ref={fileInputRef}
          type="file"
          accept="audio/*,video/*"
          onChange={handleFile}
          hidden
          aria-hidden="true"
          tabIndex={-1}
        />
      </form>
    </aside>
  );
}
