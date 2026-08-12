import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { createSignalingClient } from '../lib/signaling.js';
import { WebRTCMesh } from '../lib/webrtcMesh.js';
import { AudioLevelMonitor } from '../lib/audioLevels.js';
import { appendMessage, createChatMessage, sanitizeIncomingMessage } from '../lib/chat.js';
import VideoTile from '../components/VideoTile.jsx';
import VideoGrid from '../components/VideoGrid.jsx';
import ChatPanel from '../components/ChatPanel.jsx';
import Toasts from '../components/Toasts.jsx';
import JoinRequestModal from '../components/JoinRequestModal.jsx';
// import { deriveRoomKey, isInsertableStreamsSupported } from '../lib/e2ee.js';
import { fetchIceServers, MAX_PARTICIPANTS } from '../config.js';

const PHASE = {
  CONNECTING: 'connecting',
  WAITING_APPROVAL: 'waiting-approval',
  IN_CALL: 'in-call',
  DENIED: 'denied',
};

const TOAST_MS = 4000;
const LOCAL_AUDIO_ID = 'local';

export default function Room() {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const passphrase = location.hash.slice(1);

  const [displayName, setDisplayName] = useState(
    () => sessionStorage.getItem('displayName') || '',
  );
  const [nameInput, setNameInput] = useState('');

  const [phase, setPhase] = useState(PHASE.CONNECTING);
  const [denyReason, setDenyReason] = useState(null);
  const [pendingRequests, setPendingRequests] = useState([]);
  // peerId -> { displayName, stream, screenStream, cameraOff, micOff }
  const [participants, setParticipants] = useState(new Map());
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);
  const [sharingScreen, setSharingScreen] = useState(false);
  const [mediaError, setMediaError] = useState(null);

  // Histórico de chat vive só aqui: nenhum storage, nenhum servidor. Desmontar
  // o componente (sair da sala / recarregar) apaga tudo.
  const [chatMessages, setChatMessages] = useState([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);

  const [toasts, setToasts] = useState([]);
  const [soundsEnabled, setSoundsEnabled] = useState(true);
  const [audioLevels, setAudioLevels] = useState({});

  const localStreamRef = useRef(null);   // mic + câmera (o track de vídeo entra e sai)
  const cameraTrackRef = useRef(null);
  const screenStreamRef = useRef(null);
  const signalingRef = useRef(null);
  const meshRef = useRef(null);
  const monitorRef = useRef(null);
  const selfIdRef = useRef(null);
  const cameraBusyRef = useRef(false);
  const toastTimersRef = useRef(new Set());
  // Espelhos para uso dentro de handlers registrados uma única vez.
  const participantsRef = useRef(participants);
  const chatOpenRef = useRef(chatOpen);
  const soundsEnabledRef = useRef(soundsEnabled);
  const displayNameRef = useRef(displayName);
  // const roomKeyRef = useRef(null);

  participantsRef.current = participants;
  chatOpenRef.current = chatOpen;
  soundsEnabledRef.current = soundsEnabled;
  displayNameRef.current = displayName;

  // const e2eeSupported = isInsertableStreamsSupported();

  const pushToast = useCallback((kind, text) => {
    const id = `${kind}-${text}-${performance.now()}`;
    setToasts((prev) => [...prev, { id, kind, text }]);
    const timer = setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
      toastTimersRef.current.delete(timer);
    }, TOAST_MS);
    toastTimersRef.current.add(timer);

    if (soundsEnabledRef.current) {
      // Entrada sobe, saída desce — dá para distinguir sem olhar a tela.
      monitorRef.current?.playBeep(
        kind === 'join'
          ? { frequency: 740, duration: 0.1 }
          : { frequency: 420, duration: 0.14 },
      );
    }
  }, []);

  useEffect(() => {
    if (!displayName || !passphrase) return undefined;

    let cancelled = false;
    // Capturado aqui (e não lido do ref na limpeza) porque o ref pode já ter
    // sido reatribuído quando o cleanup roda.
    const toastTimers = toastTimersRef.current;

    async function getLocalStream() {
      try {
        return await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
      } catch {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
          return null;
        }
      }
    }

    async function setup() {
      const [localStream, iceServers] = await Promise.all([
        getLocalStream(),
        fetchIceServers(),
        // deriveRoomKey(passphrase, roomId), // E2EE desabilitado por ora
      ]);
      if (cancelled) {
        localStream?.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = localStream;
      cameraTrackRef.current = localStream?.getVideoTracks()[0] || null;
      if (!cameraTrackRef.current) setCameraOff(true);
      // roomKeyRef.current = roomKey;

      const monitor = new AudioLevelMonitor({ onUpdate: setAudioLevels });
      monitorRef.current = monitor;
      monitor.ensureContext();
      const stopGestureHook = monitor.resumeOnGesture();
      if (localStream) monitor.attach(LOCAL_AUDIO_ID, localStream);

      const signaling = createSignalingClient();
      signalingRef.current = signaling;

      const mesh = new WebRTCMesh({
        signaling,
        iceServers,
        localStream,
        getSelfId: () => selfIdRef.current || signaling.socket.id || '',
        // getRoomKey: () => roomKeyRef.current, // E2EE desabilitado por ora
        onRemoteStream: (peerId, stream) => {
          setParticipants((prev) => {
            const next = new Map(prev);
            next.set(peerId, { ...(next.get(peerId) || {}), stream });
            return next;
          });
        },
        onRemoteScreen: (peerId, screenStream) => {
          setParticipants((prev) => {
            if (!prev.has(peerId)) return prev;
            const next = new Map(prev);
            next.set(peerId, { ...next.get(peerId), screenStream });
            return next;
          });
        },
        onRemotePeerState: (peerId, state) => {
          setParticipants((prev) => {
            if (!prev.has(peerId)) return prev;
            const current = prev.get(peerId);
            const next = new Map(prev);
            next.set(peerId, {
              ...current,
              cameraOff: state.cameraOff,
              micOff: state.micOff,
              // O nome vindo do peer só complementa: o servidor já mandou o dele.
              displayName: current.displayName || state.displayName,
            });
            return next;
          });
        },
        onChatMessage: (peerId, raw) => {
          const message = sanitizeIncomingMessage(raw, {
            fallbackAuthor: participantsRef.current.get(peerId)?.displayName,
          });
          if (!message) return;
          setChatMessages((prev) => appendMessage(prev, message));
          if (!chatOpenRef.current) setUnreadCount((count) => count + 1);
        },
        onRemoteStreamClosed: (peerId) => {
          setParticipants((prev) => {
            const next = new Map(prev);
            next.delete(peerId);
            return next;
          });
        },
      });
      meshRef.current = mesh;
      mesh.localState = {
        displayName,
        cameraOff: !cameraTrackRef.current,
        micOff: false,
        screenOn: false,
      };

      signaling.socket.on('join-approved', ({ selfId, members }) => {
        selfIdRef.current = selfId;
        setPhase(PHASE.IN_CALL);
        setParticipants((prev) => {
          const next = new Map(prev);
          for (const member of members) {
            next.set(member.id, { ...(next.get(member.id) || {}), displayName: member.displayName });
          }
          return next;
        });
        for (const member of members) {
          mesh.addPeer(member.id);
        }
      });

      signaling.socket.on('join-denied', ({ reason }) => {
        setDenyReason(reason);
        setPhase(PHASE.DENIED);
      });

      signaling.socket.on('join-request', ({ requesterId, displayName: name }) => {
        setPendingRequests((prev) =>
          // Um reenvio do mesmo pedido não pode virar duas linhas no modal: a
          // segunda ficaria pendente para sempre, já que aprovar resolve o id.
          prev.some((r) => r.requesterId === requesterId)
            ? prev
            : [...prev, { requesterId, displayName: name }],
        );
      });

      // Aditivo: se o servidor avisar que o pedido foi cancelado (o requisitante
      // desistiu ou caiu), a linha some sozinha. Sem o evento, é um no-op.
      signaling.socket.on('join-request-cancelled', ({ requesterId }) => {
        setPendingRequests((prev) => prev.filter((r) => r.requesterId !== requesterId));
      });

      signaling.socket.on('peer-joined', ({ peerId, displayName: name }) => {
        // Qualquer participante presente aprova: quando outro chega primeiro, o
        // pedido já foi resolvido e o modal não pode continuar cobrando decisão.
        setPendingRequests((prev) => prev.filter((r) => r.requesterId !== peerId));
        setParticipants((prev) => {
          const next = new Map(prev);
          next.set(peerId, { ...(next.get(peerId) || {}), displayName: name });
          return next;
        });
        pushToast('join', `${name} entrou na sala`);
        mesh.addPeer(peerId);
      });

      signaling.socket.on('peer-left', ({ peerId }) => {
        // `peer-left` só traz o id; o nome sai do mapa local antes de removê-lo.
        const name = participantsRef.current.get(peerId)?.displayName || 'Participante';
        mesh.removePeer(peerId);
        setParticipants((prev) => {
          const next = new Map(prev);
          next.delete(peerId);
          return next;
        });
        pushToast('leave', `${name} saiu da sala`);
      });

      signaling.socket.on('signal', ({ from, data }) => {
        mesh.handleSignal(from, data);
      });

      signaling.socket.on('connect', () => {
        setPhase(PHASE.WAITING_APPROVAL);
        signaling.requestJoin(roomId, displayName);
      });

      signaling.connect();
      cleanupExtras.push(stopGestureHook);
    }

    const cleanupExtras = [];

    setup().catch((err) => {
      if (!cancelled) {
        console.error('[Room] setup error:', err);
        setPhase(PHASE.DENIED);
        setDenyReason('setup-error');
      }
    });

    return () => {
      cancelled = true;
      cleanupExtras.forEach((fn) => fn());

      // Ordem importa pouco, mas nada pode ficar de fora: é aqui que o LED da
      // webcam apaga e que os decoders/ICE agents param de existir.
      meshRef.current?.closeAll();
      meshRef.current = null;
      signalingRef.current?.leaveRoom();
      signalingRef.current?.disconnect();
      signalingRef.current = null;

      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
      cameraTrackRef.current = null;
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      screenStreamRef.current = null;

      // Fecha o AudioContext e cancela o requestAnimationFrame compartilhado.
      monitorRef.current?.close();
      monitorRef.current = null;

      toastTimers.forEach((timer) => clearTimeout(timer));
      toastTimers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, passphrase, displayName]);

  // Mantém um analisador por stream de áudio presente na sala (local + remotos),
  // todos no mesmo AudioContext e no mesmo loop de rAF.
  useEffect(() => {
    const monitor = monitorRef.current;
    if (!monitor) return;
    const valid = new Set([LOCAL_AUDIO_ID]);
    for (const [peerId, info] of participants) {
      if (!info.stream) continue;
      valid.add(peerId);
      monitor.attach(peerId, info.stream);
    }
    monitor.retainOnly(valid);
  }, [participants]);

  const approve = useCallback((requesterId) => {
    signalingRef.current?.approveJoin(requesterId);
    setPendingRequests((prev) => prev.filter((r) => r.requesterId !== requesterId));
  }, []);

  const deny = useCallback((requesterId) => {
    signalingRef.current?.denyJoin(requesterId);
    setPendingRequests((prev) => prev.filter((r) => r.requesterId !== requesterId));
  }, []);

  const toggleMute = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !muted;
    stream.getAudioTracks().forEach((t) => {
      t.enabled = !next;
    });
    setMuted(next);
    meshRef.current?.setLocalState({ micOff: next });
  }, [muted]);

  /**
   * Desligar de verdade: `track.stop()` encerra o device (o LED apaga) e
   * `replaceTrack(null)` corta o vídeo para todos os peers. Religar readquire a
   * câmera e injeta o track novo em todos os senders — sem renegociar SDP e sem
   * encostar no áudio.
   */
  const toggleCamera = useCallback(async () => {
    if (cameraBusyRef.current) return;
    cameraBusyRef.current = true;
    setMediaError(null);
    try {
      const mesh = meshRef.current;
      if (cameraOff) {
        const fresh = await navigator.mediaDevices.getUserMedia({ video: true });
        const track = fresh.getVideoTracks()[0];
        if (!track) return;
        cameraTrackRef.current = track;
        localStreamRef.current?.addTrack(track);
        await mesh?.setCameraTrack(track);
        setCameraOff(false);
        mesh?.setLocalState({ cameraOff: false });
      } else {
        const track = cameraTrackRef.current;
        await mesh?.setCameraTrack(null);
        if (track) {
          track.stop();
          localStreamRef.current?.removeTrack(track);
        }
        cameraTrackRef.current = null;
        setCameraOff(true);
        mesh?.setLocalState({ cameraOff: true });
      }
    } catch (err) {
      console.error('[Room] toggleCamera failed:', err);
      setMediaError('Não foi possível acessar a câmera.');
    } finally {
      cameraBusyRef.current = false;
    }
  }, [cameraOff]);

  const stopScreenShare = useCallback(async () => {
    const stream = screenStreamRef.current;
    screenStreamRef.current = null;
    await meshRef.current?.setScreenTrack(null);
    stream?.getTracks().forEach((t) => t.stop());
    setSharingScreen(false);
    meshRef.current?.setLocalState({ screenOn: false });
  }, []);

  const startScreenShare = useCallback(async () => {
    setMediaError(null);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 15 },
        audio: false,
      });
      const track = stream.getVideoTracks()[0];
      if (!track) return;
      // "Parar compartilhamento" na barra do navegador dispara `ended` — o
      // mesmo caminho do botão da UI, para a grade voltar nos dois casos.
      track.addEventListener('ended', () => {
        stopScreenShare();
      });
      screenStreamRef.current = stream;
      await meshRef.current?.setScreenTrack(track);
      setSharingScreen(true);
      meshRef.current?.setLocalState({ screenOn: true });
    } catch (err) {
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        console.error('[Room] startScreenShare failed:', err);
        setMediaError('Não foi possível compartilhar a tela.');
      }
    }
  }, [stopScreenShare]);

  const sendChat = useCallback((text) => {
    const message = createChatMessage({ author: displayNameRef.current, text });
    if (!message) return;
    meshRef.current?.sendChatMessage(message);
    setChatMessages((prev) => appendMessage(prev, { ...message, mine: true }));
  }, []);

  const openChat = useCallback(() => {
    setChatOpen(true);
    setUnreadCount(0);
  }, []);

  const tiles = useMemo(() => {
    const list = [
      {
        key: 'local',
        audioId: LOCAL_AUDIO_ID,
        stream: localStreamRef.current,
        label: `${displayName} (você)`,
        muted: true,
        mirrored: true,
        cameraOff,
        micOff: muted,
      },
    ];
    if (sharingScreen) {
      list.push({
        key: 'local-screen',
        stream: screenStreamRef.current,
        label: `${displayName} — sua tela`,
        muted: true,
        contain: true,
        badge: 'Tela',
      });
    }
    for (const [peerId, info] of participants) {
      list.push({
        key: peerId,
        audioId: peerId,
        stream: info.stream,
        label: info.displayName || 'Participante',
        cameraOff: !!info.cameraOff,
        micOff: !!info.micOff,
      });
      if (info.screenStream) {
        list.push({
          key: `${peerId}-screen`,
          stream: info.screenStream,
          label: `${info.displayName || 'Participante'} — tela`,
          contain: true,
          badge: 'Tela',
        });
      }
    }
    return list;
    // localStreamRef/screenStreamRef são refs: as deps abaixo são exatamente os
    // gatilhos que mudam o conteúdo delas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, displayName, cameraOff, muted, sharingScreen]);

  // Toasts e modal de aprovação vivem fora do switch de fase, num wrapper comum
  // a todos os `return`: "aparece sobre qualquer estado da tela" só é garantido
  // se a renderização não estiver presa a um dos ramos.
  const overlays = (
    <>
      <Toasts toasts={toasts} />
      <JoinRequestModal requests={pendingRequests} onApprove={approve} onDeny={deny} />
    </>
  );

  if (!displayName) {
    const handleNameSubmit = (e) => {
      e.preventDefault();
      const name = nameInput.trim();
      if (!name) return;
      sessionStorage.setItem('displayName', name);
      setDisplayName(name);
    };
    return (
      <>
        {overlays}
        <main className="home">
          <h1>wtk-meet</h1>
          <p className="tagline">Você foi convidado para uma sala. Escolha um nome para entrar.</p>
          <form onSubmit={handleNameSubmit}>
            <label className="field">
              Seu nome
              <input
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                placeholder="Como te chamam"
                maxLength={40}
                autoFocus
              />
            </label>
            <div className="actions">
              <button type="submit" disabled={!nameInput.trim()}>
                Entrar na sala
              </button>
            </div>
          </form>
        </main>
      </>
    );
  }

  if (phase === PHASE.DENIED) {
    return (
      <>
        {overlays}
        <main className="room denied">
          <div className="phase-content">
            <h2>Acesso não liberado</h2>
            <p>
              {denyReason === 'room-full'
                ? 'A sala já está com 6 participantes.'
                : denyReason === 'setup-error'
                  ? 'Erro ao inicializar a conexão. Verifique sua rede e tente novamente.'
                  : 'Seu pedido de entrada foi negado.'}
            </p>
            <button onClick={() => navigate('/')}>Voltar</button>
          </div>
        </main>
      </>
    );
  }

  if (phase === PHASE.CONNECTING || phase === PHASE.WAITING_APPROVAL) {
    return (
      <>
        {overlays}
        <main className="room waiting">
          <div className="phase-content">
            <h2>
              {phase === PHASE.CONNECTING
                ? 'Conectando…'
                : 'Aguardando aprovação de quem já está na sala…'}
            </h2>
            <div className="local-preview">
              <VideoTile stream={localStreamRef.current} label={displayName} muted mirrored />
            </div>
          </div>
        </main>
      </>
    );
  }

  const inviteLink = `${window.location.origin}/room/${roomId}#${passphrase}`;
  const roomSize = participants.size + 1;

  return (
    <>
      {overlays}
      <main className={`room in-call${chatOpen ? ' with-chat' : ''}`}>
        {/* E2EE desabilitado por ora */}

        {mediaError && <p className="warning">{mediaError}</p>}

        <div className="stage">
          <VideoGrid tiles={tiles} audioLevels={audioLevels} />

          {chatOpen && (
            <ChatPanel
              messages={chatMessages}
              onSend={sendChat}
              onClose={() => setChatOpen(false)}
              peerCount={participants.size}
            />
          )}
        </div>

        <div className="controls">
          <button onClick={toggleMute}>{muted ? 'Ativar mic' : 'Silenciar'}</button>
          <button onClick={toggleCamera}>{cameraOff ? 'Ativar câmera' : 'Desligar câmera'}</button>
          <button onClick={sharingScreen ? stopScreenShare : startScreenShare}>
            {sharingScreen ? 'Parar compartilhamento' : 'Compartilhar tela'}
          </button>
          <button onClick={chatOpen ? () => setChatOpen(false) : openChat}>
            Chat
            {unreadCount > 0 && !chatOpen && <span className="badge">{unreadCount}</span>}
          </button>
          <button
            onClick={() => setSoundsEnabled((value) => !value)}
            title="Bipe de entrada e saída de participantes"
          >
            {soundsEnabled ? 'Silenciar avisos' : 'Ativar avisos'}
          </button>
          <button onClick={() => navigate('/')} className="leave">
            Sair
          </button>
        </div>

        {/* Linha única e truncada: com `word-break` a URL virava 3–4 linhas em
            janela estreita e roubava altura do palco a cada resize. */}
        <p className="invite-hint" title={inviteLink}>
          Link do convite: <code>{inviteLink}</code> — compartilhe por outro canal.
          {roomSize >= MAX_PARTICIPANTS && ' Sala no limite de participantes.'}
        </p>
      </main>
    </>
  );
}
