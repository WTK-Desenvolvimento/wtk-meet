import { useEffect, useRef, useState, type FormEvent } from 'react';
import { formatTime, MAX_MESSAGE_LENGTH, type ChatMessage } from '../lib/chat.js';

import './ChatPanel.css';

/**
 * Painel de chat da sala. As mensagens chegam e saem pelos data channels P2P
 * (ver `lib/chat.js` e `lib/webrtcMesh.js`); este componente não conhece o
 * servidor de sinalização e não escreve nada em storage — o histórico é só a
 * prop `messages`, que vive no estado do `Room` e morre com ele.
 */
export default function ChatPanel({
  messages,
  onSend,
  onClose,
  peerCount,
}: {
  messages: ChatMessage[];
  onSend: (text: string) => void;
  onClose: () => void;
  peerCount: number;
}) {
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    onSend(text);
    setDraft('');
  }

  return (
    <aside className="chat-panel" aria-label="Chat da sala">
      <header className="chat-header">
        <div>
          <strong>Chat</strong>
          <span className="chat-subtitle">
            P2P, sem histórico — some ao sair
          </span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Fechar chat">
          ✕
        </button>
      </header>

      <div className="chat-messages" ref={listRef}>
        {messages.length === 0 ? (
          <p className="chat-empty">
            {peerCount === 0
              ? 'Ninguém mais na sala ainda. As mensagens só saem quando houver alguém conectado.'
              : 'Nenhuma mensagem ainda.'}
          </p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`chat-message${message.mine ? ' mine' : ''}`}
            >
              <span className="chat-meta">
                <span className="chat-author">{message.author}</span>
                <span className="chat-time">{formatTime(message.sentAt)}</span>
              </span>
              <span className="chat-text">{message.text}</span>
            </div>
          ))
        )}
      </div>

      <form className="chat-composer" onSubmit={handleSubmit}>
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Mensagem para a sala"
          maxLength={MAX_MESSAGE_LENGTH}
          aria-label="Mensagem"
        />
        <button type="submit" disabled={!draft.trim()}>
          Enviar
        </button>
      </form>
    </aside>
  );
}
