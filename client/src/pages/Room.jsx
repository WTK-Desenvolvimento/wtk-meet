import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { createSignalingClient } from '../lib/signaling.js';
import { WebRTCMesh } from '../lib/webrtcMesh.js';
import { deriveRoomKey, isInsertableStreamsSupported } from '../lib/e2ee.js';
import { fetchIceServers, MAX_PARTICIPANTS } from '../config.js';

const PHASE = {
  CONNECTING: 'connecting',
  WAITING_APPROVAL: 'waiting-approval',
  IN_CALL: 'in-call',
  DENIED: 'denied',
};

export default function Room() {
  const { roomId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const passphrase = location.hash.slice(1);
  const displayName = sessionStorage.getItem('displayName');

  const [phase, setPhase] = useState(PHASE.CONNECTING);
  const [denyReason, setDenyReason] = useState(null);
  const [pendingRequests, setPendingRequests] = useState([]);
  const [participants, setParticipants] = useState(new Map()); // peerId -> { displayName, stream }
  const [muted, setMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);

  const localVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const signalingRef = useRef(null);
  const meshRef = useRef(null);
  const roomKeyRef = useRef(null);

  const e2eeSupported = isInsertableStreamsSupported();

  useEffect(() => {
    if (!displayName || !passphrase) {
      navigate('/');
      return undefined;
    }

    let cancelled = false;

    async function setup() {
      const [localStream, iceServers, roomKey] = await Promise.all([
        navigator.mediaDevices.getUserMedia({ video: true, audio: true }),
        fetchIceServers(),
        deriveRoomKey(passphrase, roomId),
      ]);
      if (cancelled) {
        localStream.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = localStream;
      roomKeyRef.current = roomKey;
      if (localVideoRef.current) localVideoRef.current.srcObject = localStream;

      const signaling = createSignalingClient();
      signalingRef.current = signaling;

      const mesh = new WebRTCMesh({
        signaling,
        iceServers,
        localStream,
        getRoomKey: () => roomKeyRef.current,
        onRemoteStream: (peerId, stream) => {
          setParticipants((prev) => {
            const next = new Map(prev);
            next.set(peerId, { ...(next.get(peerId) || {}), stream });
            return next;
          });
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

      signaling.socket.on('join-approved', ({ members }) => {
        setPhase(PHASE.IN_CALL);
        setParticipants((prev) => {
          const next = new Map(prev);
          for (const member of members) {
            next.set(member.id, { ...(next.get(member.id) || {}), displayName: member.displayName });
          }
          return next;
        });
        for (const member of members) {
          mesh.addPeer(member.id, { initiator: true });
        }
      });

      signaling.socket.on('join-denied', ({ reason }) => {
        setDenyReason(reason);
        setPhase(PHASE.DENIED);
      });

      signaling.socket.on('join-request', ({ requesterId, displayName: name }) => {
        setPendingRequests((prev) => [...prev, { requesterId, displayName: name }]);
      });

      signaling.socket.on('peer-joined', ({ peerId, displayName: name }) => {
        setParticipants((prev) => {
          const next = new Map(prev);
          next.set(peerId, { ...(next.get(peerId) || {}), displayName: name });
          return next;
        });
        mesh.addPeer(peerId, { initiator: false });
      });

      signaling.socket.on('peer-left', ({ peerId }) => {
        mesh.removePeer(peerId);
        setParticipants((prev) => {
          const next = new Map(prev);
          next.delete(peerId);
          return next;
        });
      });

      signaling.socket.on('signal', ({ from, data }) => {
        mesh.handleSignal(from, data);
      });

      signaling.socket.on('connect', () => {
        setPhase(PHASE.WAITING_APPROVAL);
        signaling.requestJoin(roomId, displayName);
      });

      signaling.connect();
    }

    setup();

    return () => {
      cancelled = true;
      meshRef.current?.closeAll();
      signalingRef.current?.leaveRoom();
      signalingRef.current?.disconnect();
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, passphrase, displayName]);

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
  }, [muted]);

  const toggleCamera = useCallback(() => {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !cameraOff;
    stream.getVideoTracks().forEach((t) => {
      t.enabled = !next;
    });
    setCameraOff(next);
  }, [cameraOff]);

  if (phase === PHASE.DENIED) {
    return (
      <main className="room denied">
        <h2>Acesso não liberado</h2>
        <p>
          {denyReason === 'room-full'
            ? 'A sala já está com 6 participantes.'
            : 'Seu pedido de entrada foi negado.'}
        </p>
        <button onClick={() => navigate('/')}>Voltar</button>
      </main>
    );
  }

  if (phase === PHASE.CONNECTING || phase === PHASE.WAITING_APPROVAL) {
    return (
      <main className="room waiting">
        <h2>
          {phase === PHASE.CONNECTING
            ? 'Conectando…'
            : 'Aguardando aprovação de quem já está na sala…'}
        </h2>
        <video ref={localVideoRef} autoPlay muted playsInline className="local-preview" />
      </main>
    );
  }

  const inviteLink = `${window.location.origin}/room/${roomId}#${passphrase}`;
  const roomSize = participants.size + 1;

  return (
    <main className="room in-call">
      {!e2eeSupported && (
        <p className="warning">
          Seu navegador não suporta a camada extra de E2EE (Insertable Streams). A chamada
          segue protegida apenas pela criptografia padrão do WebRTC (DTLS-SRTP).
        </p>
      )}

      {pendingRequests.length > 0 && (
        <div className="pending-requests">
          {pendingRequests.map((req) => (
            <div key={req.requesterId} className="pending-request">
              <span>{req.displayName} quer entrar na sala</span>
              <button onClick={() => approve(req.requesterId)}>Aprovar</button>
              <button onClick={() => deny(req.requesterId)}>Negar</button>
            </div>
          ))}
        </div>
      )}

      <div className="video-grid">
        <VideoTile stream={localStreamRef.current} label={`${displayName} (você)`} muted />
        {[...participants.entries()].map(([peerId, info]) => (
          <VideoTile key={peerId} stream={info.stream} label={info.displayName || 'Participante'} />
        ))}
      </div>

      <div className="controls">
        <button onClick={toggleMute}>{muted ? 'Ativar mic' : 'Silenciar'}</button>
        <button onClick={toggleCamera}>{cameraOff ? 'Ativar câmera' : 'Desligar câmera'}</button>
        <button onClick={() => navigate('/')} className="leave">
          Sair
        </button>
      </div>

      <p className="invite-hint">
        Link do convite: <code>{inviteLink}</code> — compartilhe por outro canal.
        {roomSize >= MAX_PARTICIPANTS && ' Sala no limite de participantes.'}
      </p>
    </main>
  );
}

function VideoTile({ stream, label, muted }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.srcObject = stream || null;
  }, [stream]);
  return (
    <div className="video-tile">
      <video ref={ref} autoPlay playsInline muted={muted} />
      <span className="video-label">{label}</span>
    </div>
  );
}
