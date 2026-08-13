import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import SettingsModal from '../components/SettingsModal.jsx';
import { readPreferences, writePreferences } from '../lib/devices.js';
import { SIGNALING_URL } from '../config.js';
import {
  MAX_ROOM_PATH_LENGTH,
  ROOM_SLUG_LENGTH,
  buildRoomUrl,
  generatePassphrase,
  generateRoomSlug,
  normalizeRoomPath,
  normalizeRoomPathInput,
} from '../lib/roomSlug.js';
import { isReservedPath, parseInviteLink } from '../lib/roomRouting.js';

/**
 * Pergunta ao servidor se **já tem gente** no endereço escolhido.
 *
 * A resposta é um booleano e só: sem nomes, sem quantidade, sem histórico. Vale
 * registrar o incômodo — `ARCHITECTURE.md` §5 trata "que um roomId existe" como
 * conhecimento interno do servidor, e mesmo um booleano é, no agregado, um
 * oráculo: varrer uma lista de nomes prováveis (`daily`, `suporte`) diz quais
 * times estão reunidos agora. Está aqui porque o DoD da WTK-MEET-10 pede o
 * aviso de sala ocupada; a decisão de manter ou remover é do produto, e o
 * commit que o introduz é isolado justamente para poder ser revertido sozinho.
 *
 * Falha de rede responde `false`: o aviso é conveniência, e servidor fora do ar
 * não pode impedir alguém de criar sala.
 */
async function isRoomOccupied(path) {
  try {
    const res = await fetch(`${SIGNALING_URL}/rooms/${encodeURIComponent(path)}/occupancy`);
    if (!res.ok) return false;
    const { occupied } = await res.json();
    return occupied === true;
  } catch {
    return false;
  }
}

export default function Home() {
  const navigate = useNavigate();
  const [displayName, setDisplayName] = useState(() => sessionStorage.getItem('displayName') || '');
  const [inviteLink, setInviteLink] = useState('');
  // O campo guarda o endereço **já normalizado**: o que se vê é exatamente o
  // que vai para a barra de endereço, sem surpresa no meio do caminho.
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  // Endereço que o servidor disse estar ocupado, aguardando decisão de quem cria.
  const [occupied, setOccupied] = useState('');
  const [checking, setChecking] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Única exceção à regra de zero persistência do produto: preferência de
  // hardware (ver `lib/devices.js`).
  const [preferences, setPreferences] = useState(() => readPreferences(window.localStorage));

  // O endereço é slugificado enquanto se digita, não rejeitado: quem escreve
  // "Sala do Nícolas" escreve assim porque é assim que se escreve, e descobrir
  // a regra sozinho não é trabalho de quem só quer uma sala.
  const roomPath = useMemo(() => normalizeRoomPath(address), [address]);
  const addressError = useMemo(() => {
    const typed = address.trim();
    if (!typed) return '';
    if (!roomPath) return 'Esse endereço não deixa nenhuma letra ou número aproveitável.';
    // O endereço longo demais é **recusado**, não cortado: uma sala truncada
    // seria outra sala, e o link ditado para o time apontaria para ela.
    if (roomPath.length > MAX_ROOM_PATH_LENGTH) {
      return `O endereço pode ter até ${MAX_ROOM_PATH_LENGTH} caracteres — esse ficou com ${roomPath.length}.`;
    }
    if (isReservedPath(roomPath)) return `"${roomPath}" é um endereço reservado pelo app. Escolha outro.`;
    return '';
  }, [address, roomPath]);

  function saveDisplayName() {
    const trimmed = displayName.trim();
    sessionStorage.setItem('displayName', trimmed);
    return trimmed;
  }

  function enterRoom(path) {
    // A passphrase vive só no fragmento da URL — nunca é enviada ao servidor.
    navigate(`/${path}#${generatePassphrase()}`);
  }

  async function handleCreate() {
    const name = saveDisplayName();
    if (!name) {
      setError('Escolha um nome de exibição primeiro.');
      return;
    }
    if (addressError) {
      setError(addressError);
      return;
    }
    setError('');
    setOccupied('');
    // Campo vazio: slug de 9 caracteres, ditável e impossível de adivinhar.
    const path = roomPath || generateRoomSlug();

    setChecking(true);
    const emUso = await isRoomOccupied(path);
    setChecking(false);
    // Sala ocupada não bloqueia nada — quem cria decide entrar junto ou trocar
    // de endereço. Entrar junto é caso legítimo (a sala de sempre do time).
    if (emUso) {
      setOccupied(path);
      return;
    }
    enterRoom(path);
  }

  function handleJoin() {
    const name = saveDisplayName();
    if (!name) {
      setError('Escolha um nome de exibição primeiro.');
      return;
    }
    // Aceita o formato novo, o legado `/room/:id` e um path colado sozinho —
    // e devolve `null` em vez de lançar quando não é convite nenhum.
    const invite = parseInviteLink(inviteLink);
    if (!invite) {
      setError('Link de convite inválido.');
      return;
    }
    setError('');
    // A chave vem do link; gerar outra aqui levaria à sala certa com a chave
    // errada — mesma sala de sinalização, vídeo que ninguém decodifica.
    navigate(`/${invite.path}#${invite.passphrase}`);
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

      <label className="field">
        Endereço da sala <span className="optional">(opcional)</span>
        <input
          value={address}
          onChange={(e) => {
            // Normaliza a cada tecla: maiúscula vira minúscula, acento cai,
            // espaço e `_` viram hífen. A variante `…Input` preserva o hífen
            // da ponta enquanto se digita — sem isso, o espaço apagaria a si
            // mesmo e "uma sala" sairia "umasala".
            setAddress(normalizeRoomPathInput(e.target.value));
            setOccupied('');
            setError('');
          }}
          placeholder="daily, sala-do-suporte…"
          aria-invalid={addressError ? 'true' : undefined}
          aria-describedby="address-hint"
        />
        <span id="address-hint" className="hint">
          {addressError ? (
            <span className="error">{addressError}</span>
          ) : roomPath ? (
            <>
              Sua sala: <code>{buildRoomUrl(window.location.origin, roomPath, 'chave')}</code>.
              Endereço escolhido é mais fácil de adivinhar que um sorteado — quem chegar
              continua precisando da sua aprovação para entrar.
            </>
          ) : (
            <>Em branco, sorteamos um endereço de {ROOM_SLUG_LENGTH} caracteres.</>
          )}
        </span>
      </label>

      {error && <p className="error">{error}</p>}

      {occupied && (
        <div className="warning occupied-room">
          <p>
            Já existe gente na sala <code>/{occupied}</code>. Entrar coloca você junto dessas
            pessoas — e vai precisar da aprovação delas.
          </p>
          <div className="occupied-actions">
            <button onClick={() => enterRoom(occupied)}>Entrar mesmo assim</button>
            <button
              className="secondary"
              onClick={() => {
                setOccupied('');
                setAddress('');
              }}
            >
              Escolher outro endereço
            </button>
          </div>
        </div>
      )}

      <div className="actions">
        <button onClick={handleCreate} disabled={checking || !!addressError}>
          {checking ? 'Verificando…' : 'Criar sala'}
        </button>

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
        servidor. Compartilhe o <strong>link inteiro</strong>, incluindo a parte depois do{' '}
        <code>#</code>: sem ela a pessoa abre o mesmo endereço com outra chave. Use um canal
        separado (mensagem, etc).
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
