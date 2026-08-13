import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SettingsModal from '../components/SettingsModal.jsx';
import { readPreferences, writePreferences } from '../lib/devices.js';

function generatePassphrase() {
  const bytes = crypto.getRandomValues(new Uint8Array(16)); // 128 bits
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export default function Home() {
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(() => sessionStorage.getItem('displayName') || '');
  const [inviteLink, setInviteLink] = useState('');
  const [error, setError] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Única exceção à regra de zero persistência do produto: preferência de
  // hardware (ver `lib/devices.js`).
  const [preferences, setPreferences] = useState(() => readPreferences(window.localStorage));

  function saveDisplayName() {
    const trimmed = displayName.trim();
    sessionStorage.setItem('displayName', trimmed);
    return trimmed;
  }

  function handleCreate() {
    const name = saveDisplayName();
    if (!name) {
      setError('Escolha um nome de exibição primeiro.');
      return;
    }
    const roomId = crypto.randomUUID();
    const passphrase = generatePassphrase();
    // Passphrase goes only in the URL fragment — never sent to the server.
    navigate(`/room/${roomId}#${passphrase}`);
  }

  function handleJoin() {
    const name = saveDisplayName();
    if (!name) {
      setError('Escolha um nome de exibição primeiro.');
      return;
    }
    try {
      const url = new URL(inviteLink);
      const match = url.pathname.match(/\/room\/([^/]+)/);
      const passphrase = url.hash.slice(1);
      if (!match || !passphrase) throw new Error('invalid invite link');
      navigate(`/room/${match[1]}#${passphrase}`);
    } catch {
      setError('Link de convite inválido.');
    }
  }

  return (
    <main className="home">
      <h1>wtk-meet</h1>
      <p className="tagline">
        Videochamadas em grupo, mesh P2P + E2EE. Nenhum servidor vê ou grava sua chamada.
      </p>

      <label className="field">
        Seu nome
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Como te chamam"
          maxLength={40}
        />
      </label>

      {error && <p className="error">{error}</p>}

      <div className="actions">
        <button onClick={handleCreate}>Criar sala</button>

        <button className="secondary" onClick={() => setSettingsOpen(true)}>
          Configurações
        </button>

        <div className="join-block">
          <input
            value={inviteLink}
            onChange={(e) => setInviteLink(e.target.value)}
            placeholder="Cole o link do convite"
          />
          <button onClick={handleJoin} disabled={!inviteLink}>
            Entrar
          </button>
        </div>
      </div>

      <p className="hint">
        A chave da sala vive só no link, depois do <code>#</code> — nunca é enviada ao
        servidor. Compartilhe o link por um canal separado (mensagem, etc).
      </p>

      {/* Montagem condicional, não `open={false}`: é o desmonte que para o
          stream de preview, inclusive quando a saída daqui é navegar para a
          sala em vez de fechar o modal. */}
      {settingsOpen && (
        <SettingsModal
          preferences={preferences}
          audioContext={null}
          onClose={() => setSettingsOpen(false)}
          onSave={(next) => {
            // Aqui não há chamada ativa: salvar só persiste. Quem aplica é o
            // primeiro getUserMedia da sala.
            setPreferences(writePreferences(window.localStorage, next));
            setSettingsOpen(false);
          }}
        />
      )}
    </main>
  );
}
