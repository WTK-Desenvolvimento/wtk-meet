import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

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
    </main>
  );
}
