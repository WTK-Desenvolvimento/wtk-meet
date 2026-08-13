import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { createSignalingClient } from '../lib/signaling.js';
import { WebRTCMesh } from '../lib/webrtcMesh.js';
import { AudioLevelMonitor } from '../lib/audioLevels.js';
import { appendMessage, createChatMessage, sanitizeIncomingMessage } from '../lib/chat.js';
import { closeAudioContext, getAudioContext, resumeAudioContextOnGesture } from '../lib/audioContext.js';
import { useMusicRoom } from '../lib/useMusicRoom.js';
import VideoTile from '../components/VideoTile.jsx';
import VideoGrid from '../components/VideoGrid.jsx';
import SpotlightStage from '../components/SpotlightStage.jsx';
import PeerAudio from '../components/PeerAudio.jsx';
import ChatPanel from '../components/ChatPanel.jsx';
import MusicPanel from '../components/MusicPanel.jsx';
import Toasts from '../components/Toasts.jsx';
import JoinRequestModal from '../components/JoinRequestModal.jsx';
import SettingsModal from '../components/SettingsModal.jsx';
import {
  buildConstraints,
  listDevices,
  readPreferences,
  reconcilePreferences,
  resolvePreferredDevice,
  writePreferences,
} from '../lib/devices.js';
import { resolveSpotlightScreen } from '../lib/spotlightLayout.js';
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
  // Qual tela **esta aba** vê em destaque. Preferência puramente local: não vai
  // para o servidor nem para o data channel, e escolher aqui não muda a tela de
  // mais ninguém.
  const [pinnedScreenId, setPinnedScreenId] = useState(null);

  // Histórico de chat vive só aqui: nenhum storage, nenhum servidor. Desmontar
  // o componente (sair da sala / recarregar) apaga tudo.
  const [chatMessages, setChatMessages] = useState([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [musicOpen, setMusicOpen] = useState(false);
  const [selfId, setSelfId] = useState('');

  const [toasts, setToasts] = useState([]);
  const [audioLevels, setAudioLevels] = useState({});

  // Preferência de dispositivos: a única coisa que este app grava em
  // `localStorage` (ver `lib/devices.js` e `ARCHITECTURE.md` §6.8). O toggle de
  // avisos sonoros mora aqui desde que saiu da barra de controles.
  const [preferences, setPreferences] = useState(() => readPreferences(window.localStorage));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsContext, setSettingsContext] = useState(null);
  const soundsEnabled = preferences.soundsEnabled;

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
  const preferencesRef = useRef(preferences);
  const mutedRef = useRef(muted);
  const cameraOffRef = useRef(cameraOff);
  // const roomKeyRef = useRef(null);

  participantsRef.current = participants;
  chatOpenRef.current = chatOpen;
  soundsEnabledRef.current = soundsEnabled;
  displayNameRef.current = displayName;
  preferencesRef.current = preferences;
  mutedRef.current = muted;
  cameraOffRef.current = cameraOff;

  /** Grava a preferência e devolve o valor efetivo (o storage pode recusar). */
  const savePreferences = useCallback((patch) => {
    const saved = writePreferences(window.localStorage, patch);
    preferencesRef.current = saved;
    setPreferences(saved);
    return saved;
  }, []);

  // Handler de `ended` dos tracks locais. Vive num ref porque `watchLocalTrack`
  // precisa existir antes das funções que ele aciona (todas se referenciam).
  const trackEndedRef = useRef(() => {});
  const watchedTracksRef = useRef(new WeakSet());

  /**
   * Um device arrancado enquanto está em uso encerra o track (`ended`) — o
   * navegador não migra para outro sozinho. Sem este listener, o microfone
   * simplesmente para de existir para os outros participantes, sem nenhum aviso.
   */
  const watchLocalTrack = useCallback((track) => {
    if (!track || watchedTracksRef.current.has(track)) return;
    watchedTracksRef.current.add(track);
    track.addEventListener('ended', () => trackEndedRef.current(track));
  }, []);

  /**
   * Troca o track de áudio local em todos os senders do mesh, preservando o
   * estado de mute e o anel de fala do tile local.
   */
  const installAudioTrack = useCallback(
    async (track) => {
      const stream = localStreamRef.current;
      if (!track || !stream) return;

      // Track novo nasce `enabled = true`. Sem esta linha, trocar de microfone
      // desmuta a pessoa sem que ela peça — e ela precisa vir ANTES do
      // replaceTrack, senão existe uma janela de frames em que o áudio vaza.
      track.enabled = !mutedRef.current;

      const old = stream.getAudioTracks()[0] || null;
      await meshRef.current?.setAudioTrack(track);
      if (old) {
        old.stop();
        stream.removeTrack(old);
      }
      stream.addTrack(track);
      watchLocalTrack(track);

      // `attach` é idempotente por (id, stream) e o MediaStream local é o
      // **mesmo objeto** depois da troca (só o track interno mudou). Um attach
      // sozinho retornaria cedo e o analisador continuaria preso ao track
      // antigo, já parado: o anel de fala local morreria em silêncio.
      monitorRef.current?.detach(LOCAL_AUDIO_ID);
      monitorRef.current?.attach(LOCAL_AUDIO_ID, stream);
    },
    [watchLocalTrack],
  );

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

  // Toda a máquina de estados da música (fila, votação, quem transmite) vive no
  // hook; o `Room` só liga os fios e desenha. Ver `lib/useMusicRoom.js`.
  const music = useMusicRoom({
    meshRef,
    participants,
    getSelfId: () => selfId,
    displayName,
    pushToast,
  });
  const musicCallbacksRef = useRef(music.meshCallbacks);
  musicCallbacksRef.current = music.meshCallbacks;

  useEffect(() => {
    if (!displayName || !passphrase) return undefined;

    let cancelled = false;
    // Capturado aqui (e não lido do ref na limpeza) porque o ref pode já ter
    // sido reatribuído quando o cleanup roda.
    const toastTimers = toastTimersRef.current;

    /**
     * Cadeia de fallback, do mais desejado ao mínimo viável. O terceiro passo
     * ignora a preferência de microfone de propósito: sem ele, uma preferência
     * obsoleta (headset que ficou em outra máquina) faria a pessoa entrar sem
     * áudio nenhum — e nada disso pode virar erro na tela.
     */
    async function getLocalStream() {
      const prefs = preferencesRef.current;
      const attempts = [
        buildConstraints(prefs, { video: true, audio: true }),
        buildConstraints(prefs, { video: false, audio: true }),
        { video: false, audio: true },
      ];
      for (const constraints of attempts) {
        try {
          return await navigator.mediaDevices.getUserMedia(constraints);
        } catch {
          // próxima tentativa
        }
      }
      return null;
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

      // A verdade sobre qual device foi aberto vem do track, não do que foi
      // pedido: é assim que uma preferência apontando para hardware que sumiu se
      // corrige sozinha, sem nenhuma mensagem de erro (§3.3/§3.4 do documento).
      if (localStream) {
        const { prefs, changed } = reconcilePreferences(
          preferencesRef.current,
          localStream.getTracks(),
        );
        if (changed) savePreferences(prefs);
        localStream.getTracks().forEach(watchLocalTrack);
      }
      // roomKeyRef.current = roomKey;

      // O `AudioContext` é um só para a sala e o dono dele é este componente:
      // nós de contextos diferentes não podem ser conectados, e o grafo da
      // música precisa do mesmo contexto do indicador de fala. Enquanto o
      // monitor era o dono, `monitor.close()` mataria a música em silêncio.
      const monitor = new AudioLevelMonitor({ onUpdate: setAudioLevels, getContext: getAudioContext });
      monitorRef.current = monitor;
      monitor.ensureContext();
      const stopGestureHook = resumeAudioContextOnGesture();
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
        // Música: o quarto canal de mídia e as mensagens `music-*` do data
        // channel. Os handlers passam por um ref porque o mesh é construído uma
        // única vez, e o estado musical muda o tempo todo.
        onRemoteMusic: (peerId, stream) => musicCallbacksRef.current.onRemoteMusic(peerId, stream),
        onMusicMessage: (peerId, payload) => musicCallbacksRef.current.onMusicMessage(peerId, payload),
        getMusicSnapshot: () => musicCallbacksRef.current.getMusicSnapshot(),
      });
      meshRef.current = mesh;
      mesh.localState = {
        displayName,
        cameraOff: !cameraTrackRef.current,
        micOff: false,
        screenOn: false,
      };

      signaling.socket.on('join-approved', ({ selfId: myId, members }) => {
        selfIdRef.current = myId;
        // Também em estado: a identidade da sala é o que decide quem transmite a
        // música e quem assume quando alguém cai, e isso precisa re-renderizar.
        setSelfId(myId);
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

      // O monitor solta os analisadores e o rAF; o contexto é fechado aqui, por
      // quem o possui — e depois do monitor, para não puxar o tapete dele.
      monitorRef.current?.close();
      monitorRef.current = null;
      closeAudioContext();

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
        // Religar respeita a câmera escolhida no modal — inclusive uma escolhida
        // enquanto a câmera estava desligada, que não foi aplicada na hora
        // justamente para não acender o LED sem ninguém pedir.
        const fresh = await navigator.mediaDevices.getUserMedia(
          buildConstraints(preferencesRef.current, { video: true, audio: false }),
        );
        const track = fresh.getVideoTracks()[0];
        if (!track) return;
        cameraTrackRef.current = track;
        localStreamRef.current?.addTrack(track);
        watchLocalTrack(track);
        await mesh?.setCameraTrack(track);
        setCameraOff(false);
        mesh?.setLocalState({ cameraOff: false });
        const { prefs, changed } = reconcilePreferences(preferencesRef.current, [track]);
        if (changed) savePreferences(prefs);
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
  }, [cameraOff, savePreferences, watchLocalTrack]);

  /**
   * Aplica a seleção do modal. Cada linha desta função existe por um motivo
   * concreto; a tabela completa está em §3.8 do documento de arquitetura.
   *
   * O mesmo `cameraBusyRef` do `toggleCamera` protege este caminho: sem isso,
   * apertar "Desligar câmera" e "Salvar" quase ao mesmo tempo dispara dois
   * `getUserMedia` concorrentes sobre o mesmo hardware.
   */
  const applyDeviceSelection = useCallback(
    async (next) => {
      const previous = preferencesRef.current;
      const merged = { ...previous, ...next };
      setSettingsOpen(false);
      // Grava antes de mexer no hardware: se a troca falhar, a escolha da pessoa
      // não se perde junto.
      savePreferences(merged);

      const stream = localStreamRef.current;
      const videoChanged = merged.videoInputId !== previous.videoInputId;
      const audioChanged = merged.audioInputId !== previous.audioInputId;
      if (!stream || (!videoChanged && !audioChanged)) return;
      if (cameraBusyRef.current) {
        // Outra operação de mídia em voo (tipicamente "Desligar câmera"). A
        // escolha já está gravada; descartar a troca **em silêncio** é que não
        // pode — a pessoa ficaria olhando para o dispositivo antigo sem entender.
        setMediaError('Havia outra troca de mídia em andamento. Abra as configurações e salve de novo.');
        return;
      }

      cameraBusyRef.current = true;
      setMediaError(null);
      try {
        if (audioChanged) {
          const fresh = await navigator.mediaDevices.getUserMedia(
            buildConstraints(merged, { video: false, audio: true }),
          );
          await installAudioTrack(fresh.getAudioTracks()[0]);
        }

        // Câmera desligada: só a preferência é gravada. Reacender a câmera para
        // aplicar uma troca que ninguém pediu é acender o LED da webcam sem
        // consentimento — a escolha vale a partir do próximo "Ativar câmera".
        if (videoChanged && !cameraOffRef.current) {
          const fresh = await navigator.mediaDevices.getUserMedia(
            buildConstraints(merged, { video: true, audio: false }),
          );
          const track = fresh.getVideoTracks()[0];
          if (track) {
            const old = cameraTrackRef.current;
            cameraTrackRef.current = track;
            await meshRef.current?.setCameraTrack(track);
            if (old) {
              old.stop();
              stream.removeTrack(old);
            }
            stream.addTrack(track);
            watchLocalTrack(track);
          }
        }

        const { prefs, changed } = reconcilePreferences(
          preferencesRef.current,
          stream.getTracks(),
        );
        if (changed) savePreferences(prefs);
      } catch (err) {
        console.error('[Room] applyDeviceSelection failed:', err);
        setMediaError('Não foi possível trocar de dispositivo. A escolha ficou salva mesmo assim.');
      } finally {
        cameraBusyRef.current = false;
      }
    },
    [installAudioTrack, savePreferences, watchLocalTrack],
  );

  /**
   * Device em uso desapareceu. O navegador encerra o track e não migra sozinho:
   * quem repõe é a aplicação — sem áudio, ninguém do outro lado ouve mais nada.
   */
  const handleLocalTrackEnded = useCallback(
    async (track) => {
      const stream = localStreamRef.current;
      // Track que já foi substituído (troca normal de device) não é perda.
      if (!stream || !stream.getTracks().includes(track)) return;

      if (track.kind === 'video') {
        stream.removeTrack(track);
        if (cameraTrackRef.current === track) cameraTrackRef.current = null;
        await meshRef.current?.setCameraTrack(null);
        setCameraOff(true);
        meshRef.current?.setLocalState({ cameraOff: true });
        savePreferences({ videoInputId: '' });
        setMediaError('A câmera em uso foi desconectada. Voltamos para o padrão do sistema.');
        return;
      }

      savePreferences({ audioInputId: '' });
      try {
        // Sem restrição de device: o que estava salvo é justamente o que sumiu.
        const fresh = await navigator.mediaDevices.getUserMedia({ video: false, audio: true });
        await installAudioTrack(fresh.getAudioTracks()[0]);
      } catch (err) {
        console.error('[Room] recuperação de microfone falhou:', err);
      }
      setMediaError('O microfone em uso foi desconectado. Voltamos para o padrão do sistema.');
    },
    [installAudioTrack, savePreferences],
  );

  trackEndedRef.current = handleLocalTrackEnded;

  /**
   * `setSinkId` rejeita quando o id não existe mais ou quando o navegador nega.
   * Voltar para o padrão do sistema é o único desfecho útil: insistir num id
   * inválido deixaria a pessoa sem áudio nenhum.
   */
  const handleSinkError = useCallback(
    (err) => {
      console.warn('[Room] setSinkId falhou:', err);
      if (!preferencesRef.current.audioOutputId) return;
      savePreferences({ audioOutputId: '' });
      setMediaError('A saída de áudio escolhida não pôde ser usada. Voltamos para o padrão.');
    },
    [savePreferences],
  );

  /**
   * Conectar/desconectar hardware fora do modal. Só reconcilia a preferência:
   * mexer na mídia aqui duplicaria o que o `ended` do track já resolve.
   */
  useEffect(() => {
    const media = navigator.mediaDevices;
    if (!media?.addEventListener) return undefined;
    const onDeviceChange = async () => {
      let raw = [];
      try {
        raw = await media.enumerateDevices();
      } catch {
        return;
      }
      const lists = listDevices(raw);
      const prefs = preferencesRef.current;
      const patch = {};
      if (resolvePreferredDevice(lists.videoInputs, prefs.videoInputId).fellBack) {
        patch.videoInputId = '';
      }
      if (resolvePreferredDevice(lists.audioInputs, prefs.audioInputId).fellBack) {
        patch.audioInputId = '';
      }
      if (resolvePreferredDevice(lists.audioOutputs, prefs.audioOutputId).fellBack) {
        patch.audioOutputId = '';
      }
      if (Object.keys(patch).length === 0) return;
      savePreferences(patch);
      setMediaError('Um dispositivo selecionado foi desconectado. Voltamos para o padrão do sistema.');
    };
    media.addEventListener('devicechange', onDeviceChange);
    return () => media.removeEventListener('devicechange', onDeviceChange);
  }, [savePreferences]);

  const openSettings = useCallback(() => {
    // O meter do preview reusa o AudioContext da sala: um segundo contexto por
    // aba é custo real (e é o que a checagem B2 do E2E protege).
    setSettingsContext(monitorRef.current?.ensureContext() || null);
    setSettingsOpen(true);
  }, []);

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

  // Chat e música são mutuamente exclusivos: dois painéis abertos espremem a
  // grade até os tiles baterem no piso de legibilidade.
  const openChat = useCallback(() => {
    setChatOpen(true);
    setMusicOpen(false);
    setUnreadCount(0);
  }, []);

  const toggleMusic = useCallback(() => {
    if (!music.enabled) {
      // Ligar o player é a única coisa que a sala decide junto: o custo de
      // ligar para todo mundo é alto, o de pular uma faixa não é (por isso
      // pular e remover são abertos, sem votação).
      music.actions.proposeEnable();
      return;
    }
    setMusicOpen((open) => {
      if (!open) setChatOpen(false);
      return !open;
    });
  }, [music.actions, music.enabled]);

  /**
   * As pessoas da sala, na ordem de chegada (o `Map` preserva a inserção). As
   * chaves são as mesmas de sempre (`local`, `<peerId>`): mudar a chave remonta
   * o `<video>` a cada render.
   */
  const people = useMemo(() => {
    const list = [
      {
        key: 'local',
        audioId: LOCAL_AUDIO_ID,
        stream: localStreamRef.current,
        label: `${displayName} (você)`,
        mirrored: true,
        cameraOff,
        micOff: muted,
        local: true,
        sharing: sharingScreen,
      },
    ];
    for (const [peerId, info] of participants) {
      list.push({
        key: peerId,
        audioId: peerId,
        stream: info.stream,
        label: info.displayName || 'Participante',
        cameraOff: !!info.cameraOff,
        micOff: !!info.micOff,
        sharing: !!info.screenStream,
      });
    }
    return list;
    // localStreamRef é ref: as deps abaixo são exatamente os gatilhos que mudam
    // o conteúdo dela.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, displayName, cameraOff, muted, sharingScreen]);

  /**
   * As telas compartilhadas ativas, em ordem determinística: a sua primeiro,
   * depois as remotas na ordem de chegada dos participantes. A ordem precisa ser
   * estável entre renders — "o destaque cai para a próxima tela ativa" só
   * significa alguma coisa com uma ordem definida.
   *
   * `screenStream` nulo é "sem tela", não "tela vazia": o peer anuncia
   * `screenOn: false` e o mesh chama `onRemoteScreen(peerId, null)`. Tratar isso
   * como uma tela ativa deixaria um destaque preto no lugar do fallback.
   */
  const screens = useMemo(() => {
    const list = [];
    if (sharingScreen && screenStreamRef.current) {
      list.push({
        key: 'local-screen',
        screenId: 'local-screen',
        stream: screenStreamRef.current,
        label: `${displayName} — sua tela`,
        owner: `${displayName} (você)`,
        contain: true,
        badge: 'Tela',
      });
    }
    for (const [peerId, info] of participants) {
      if (!info.screenStream) continue;
      const name = info.displayName || 'Participante';
      list.push({
        key: `${peerId}-screen`,
        screenId: `${peerId}-screen`,
        stream: info.screenStream,
        label: `${name} — tela`,
        owner: name,
        contain: true,
        badge: 'Tela',
      });
    }
    return list;
    // screenStreamRef é ref: `sharingScreen` é exatamente o gatilho que muda o
    // conteúdo dela.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [participants, displayName, sharingScreen]);

  // Derivado no render, nunca "corrigido" por efeito: `pinnedScreenId` pode
  // apontar para uma tela que já acabou à vontade, porque nunca é lido sem
  // validação. Um `useEffect` que limpasse o estado custaria um render extra, um
  // frame com destaque inválido e — quando uma segunda tela entra — roubaria a
  // escolha deliberada do usuário.
  const spotlightScreen = resolveSpotlightScreen(screens, pinnedScreenId);

  /**
   * O conteúdo da coluna: as câmeras de todo mundo e as telas compartilhadas.
   *
   * A tela em destaque entra na lista **sem stream**, como marcador, e só quando
   * há mais de uma tela ativa — isto é, só quando a coluna é de fato um grupo de
   * escolha. Duas razões:
   *
   * - Sem ela, nenhum controle da coluna carregaria `aria-pressed="true"`, e
   *   quem usa teclado ou leitor de tela não teria como saber qual tela está
   *   vendo.
   * - Com ela, o conjunto de botões não muda ao trocar o destaque: o botão
   *   ativado continua existindo (mesma `key`), então o foco fica onde estava em
   *   vez de sumir junto com a miniatura que virou destaque.
   *
   * Sem stream porque a mesma stream em dois `<video>` dobraria o custo de
   * decodificação — o tile cai no placeholder, que é o que se quer aqui.
   */
  const thumbnails = useMemo(() => {
    if (!spotlightScreen) return [];
    const rail = [...people];
    for (const screen of screens) {
      if (screen !== spotlightScreen) {
        rail.push(screen);
      } else if (screens.length > 1) {
        rail.push({ ...screen, stream: null, spotlighted: true, badge: 'Em destaque' });
      }
    }
    return rail;
  }, [people, screens, spotlightScreen]);

  // Toasts e modal de aprovação vivem fora do switch de fase, num wrapper comum
  // a todos os `return`: "aparece sobre qualquer estado da tela" só é garantido
  // se a renderização não estiver presa a um dos ramos.
  const overlays = (
    <>
      {/* Fora do palco de propósito: é o `<audio>` daqui que reproduz o som dos
          peers, e não o `<video>` do tile. Assim entrar e sair do modo destaque
          — que move o tile de container e remonta o elemento — não corta o
          áudio de ninguém. Ver `components/PeerAudio.jsx`. */}
      <PeerAudio participants={participants} />
      <Toasts toasts={toasts} />
      {/* Montado condicionalmente de propósito: é o desmonte que para o stream
          de preview, então sair do modal por qualquer via (botão, Esc, backdrop,
          navegação) apaga o LED da câmera pelo mesmo caminho. */}
      {settingsOpen && (
        <SettingsModal
          preferences={preferences}
          audioContext={settingsContext}
          busy={cameraBusyRef.current}
          // Câmera desligada não vira preview: abrir a câmera aqui acenderia o
          // LED sem que ninguém tenha pedido para ligá-la.
          videoPreview={!cameraOff}
          onClose={() => setSettingsOpen(false)}
          onSave={applyDeviceSelection}
          onDeviceLost={setMediaError}
        />
      )}
      {/* Depois do de configurações: quando os dois estão abertos, prioridade
          visual é de quem tem alguém esperando do outro lado. */}
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
              <VideoTile stream={localStreamRef.current} label={displayName} mirrored />
            </div>
            {/* Momento certo para descobrir que a câmera errada está ativa: aqui,
                e não já visível para todo mundo na grade. */}
            <button onClick={openSettings}>Configurações</button>
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
      <main className={`room in-call${chatOpen ? ' with-chat' : ''}${musicOpen ? ' with-music' : ''}`}>
        {/* E2EE desabilitado por ora */}

        {mediaError && <p className="warning">{mediaError}</p>}

        <div className="stage">
          {spotlightScreen ? (
            <SpotlightStage
              spotlight={spotlightScreen}
              thumbnails={thumbnails}
              audioLevels={audioLevels}
              onSelectScreen={setPinnedScreenId}
            />
          ) : (
            <VideoGrid
              tiles={people}
              audioLevels={audioLevels}
              sinkId={preferences.audioOutputId}
              onSinkError={handleSinkError}
            />
          )}

          {chatOpen && (
            <ChatPanel
              messages={chatMessages}
              onSend={sendChat}
              onClose={() => setChatOpen(false)}
              peerCount={participants.size}
            />
          )}

          {musicOpen && music.enabled && (
            <MusicPanel
              queue={music.queue}
              currentEntry={music.currentEntry}
              playback={music.playback}
              position={music.position}
              isOwner={music.isOwner}
              volume={music.volume}
              onVolume={music.setVolume}
              onClose={() => setMusicOpen(false)}
              onAdd={music.actions.addToQueue}
              onRemove={music.actions.removeFromQueue}
              onPause={music.actions.requestPause}
              onResume={music.actions.requestResume}
              onSkip={music.actions.skipCurrent}
              youtubeEnabled={music.youtubeEnabled}
              notice={music.notice}
              onDismissNotice={music.dismissNotice}
              audioBlocked={music.audioBlocked}
              onUnlock={music.unlockAudio}
              selfId={selfId}
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
          {/* O toggle de avisos sonoros vive dentro do modal: a barra tem espaço
              escasso e o layout de altura fixa depende de ela não crescer. */}
          <button onClick={openSettings} title="Câmera, microfone e saída de áudio">
            Configurações
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
