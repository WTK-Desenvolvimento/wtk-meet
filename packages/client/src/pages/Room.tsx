import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { createSignalingClient } from '../lib/signaling.js';
import { WebRTCMesh } from '../lib/webrtcMesh.js';
import { AudioLevelMonitor } from '../lib/audioLevels.js';
import { appendMessage, createChatMessage, sanitizeIncomingMessage } from '../lib/chat.js';
import { closeAudioContext, getAudioContext, resumeAudioContextOnGesture } from '../lib/audioContext.js';
import { useMusicRoom } from '../lib/useMusicRoom.js';
import { useSoundboard } from '../lib/useSoundboard.js';

import type { Favorite } from '../lib/soundboard.js';
import VideoTile from '../components/VideoTile.js';
import VideoGrid from '../components/VideoGrid.js';
import SpotlightStage from '../components/SpotlightStage.js';
import PeerAudio from '../components/PeerAudio.jsx';
import ChatPanel from '../components/ChatPanel.js';
import MusicPanel from '../components/MusicPanel.js';
import SoundboardPanel from '../components/SoundboardPanel.js';
import MusicVoteCard from '../components/MusicVoteCard.js';
import RemoteMusicAudio from '../components/RemoteMusicAudio.jsx';
import Toasts from '../components/Toasts.js';
import JoinRequestModal from '../components/JoinRequestModal.js';
import SettingsModal from '../components/SettingsModal.js';
import PreJoin from '../components/PreJoin.js';
import {
  buildConstraints,
  initialMediaPlan,
  listDevices,
  readPreferences,
  reconcilePreferences,
  resolvePreferredDevice,
  writePreferences,
} from '../lib/devices.js';
import {
  MODE,
  noiseConstraints,
  readAudioPreferences,
  writeAudioPreferences,
} from '../lib/noiseSuppression.js';
import { createMicPipeline, detectNoiseMode } from '../lib/micPipeline.js';
import { resolveSpotlightScreen } from '../lib/spotlightLayout.js';
import { applyPeerConnectionState, describeConnection } from '../lib/peerConnectionStatus.js';
import { buildRoomUrl, generatePassphrase } from '../lib/roomSlug.js';
import { roomPathFromLocation } from '../lib/roomRouting.js';
import { startSession, trackPageView } from '../lib/telemetry.js';
// import { deriveRoomKey, isInsertableStreamsSupported } from '../lib/e2ee.js';
import { fetchIceServers, MAX_PARTICIPANTS } from '../config.js';
import type { ChatMessage } from '../lib/chat.js';
import type { AudioPreferences } from '../lib/noiseSuppression.js';
import type { DevicePreferences } from '../lib/devices.js';
import type { LevelSnapshot } from '../lib/audioLevels.js';
import type { Tile } from '../components/VideoTile.js';
import type { MicPipeline } from '../lib/micPipeline.js';
import type { SignalingClient } from '../lib/signaling.js';
import type { JoinRequest } from '../components/JoinRequestModal.js';
import type { Toast } from '../components/Toasts.js';
import type { PendingPreferences } from '../components/SettingsModal.js';

const PHASE = {
  CONNECTING: 'connecting',
  WAITING_APPROVAL: 'waiting-approval',
  IN_CALL: 'in-call',
  DENIED: 'denied',
};

/**
 * Todo registro de participante nasce assim — e nasce `cameraOff: true`.
 *
 * Quem responde por "a câmera dele está ligada" é a mensagem `state` do data
 * channel, e não há garantia nenhuma de que ela chegue antes do primeiro
 * `ontrack`. Assumir "ligada" enquanto não se sabe escolhe o erro mais caro:
 * um retângulo preto, ou um frame de vídeo de alguém que pediu para não
 * aparecer. O custo do lado oposto é um placeholder que dura algumas centenas
 * de milissegundos no tile de quem está com a câmera ligada mesmo.
 *
 * Ele existe como constante — e não como três objetos escritos à mão — porque
 * são **três** os pontos que criam registro (o loop de `members`, o
 * `peer-joined` e o `onRemoteStream`, que também cria quando o peer ainda é
 * desconhecido). Corrigir só um deixa a corrida viva.
 */
/**
 * Um participante da sala, do ponto de vista desta tela.
 *
 * `connectionState` é o `RTCPeerConnection.connectionState` daquele peer, tal
 * como o mesh o reporta — aqui ele só é **observado**.
 */
export interface Participant {
  displayName: string;
  stream: MediaStream | null;
  screenStream: MediaStream | null;
  cameraOff: boolean;
  micOff: boolean;
  connectionState?: string;
}

const DEFAULT_PARTICIPANT: Participant = {
  displayName: '',
  stream: null,
  screenStream: null,
  cameraOff: true,
  micOff: false,
};

const TOAST_MS = 4000;
const LOCAL_AUDIO_ID = 'local';

export default function Room() {
  const location = useLocation();
  const navigate = useNavigate();
  // O id da sala **é** o path, canonicalizado: minúsculo, slugificado, sem
  // barra final. Vem de `location.pathname` e não de `useParams`, porque o
  // valor cru é o que o servidor usaria como chave de sala e o que o PBKDF2
  // usaria como salt — entrar por `/Daily` e por `/daily` seriam duas salas
  // diferentes, cada uma parecendo vazia, sem nenhum erro na tela.
  // `''` significa "não é sala" (raiz, rota reservada, multi-segmento).
  const roomId = roomPathFromLocation(location.pathname);
  const passphrase = location.hash.slice(1);
  // Enquanto isto for verdade, nada de getUserMedia e nada de socket: o efeito
  // de setup faz early-return e espera o redirect terminar.
  const redirectPending = !roomId || location.pathname !== `/${roomId}` || !passphrase;

  // Canonicalização e chave, **antes** de qualquer conexão.
  useEffect(() => {
    if (!roomId) {
      // Path que não é sala: `/assets`, `/a/b`, `/!!!`. Volta para a Home.
      navigate('/', { replace: true });
      return;
    }
    if (location.pathname !== `/${roomId}`) {
      navigate(`/${roomId}${location.hash}`, { replace: true });
      return;
    }
    if (!passphrase) {
      // Abrir `/daily` na barra de endereço **é** criar a sala: a chave nasce
      // aqui e vai para o fragmento. Sempre `replace` — um `push` deixaria no
      // histórico um path sem chave, e o Voltar geraria outra chave a cada
      // volta, em laço. Consequência documentada: duas pessoas que abrem o
      // mesmo path sem `#` recebem chaves diferentes (ver README).
      navigate(`/${roomId}#${generatePassphrase()}`, { replace: true });
    }
  }, [roomId, passphrase, location.pathname, location.hash, navigate]);

  const [displayName, setDisplayName] = useState(
    () => sessionStorage.getItem('displayName') || '',
  );
  const [nameInput, setNameInput] = useState('');

  const [phase, setPhase] = useState(PHASE.CONNECTING);
  const [denyReason, setDenyReason] = useState<string | null>(null);
  const [pendingRequests, setPendingRequests] = useState<JoinRequest[]>([]);
  // peerId -> { displayName, stream, screenStream, cameraOff, micOff, connectionState }
  //
  // `connectionState` é o `RTCPeerConnection.connectionState` daquele peer, tal
  // como o mesh o reporta. Aqui ele só é **observado**: reagir a `failed`
  // (reiniciar o ICE, renegociar) é do `lib/webrtcMesh.js`, não desta camada.
  const [participants, setParticipants] = useState(new Map<string, Participant>());
  const [muted, setMuted] = useState(false);
  // O padrão de fábrica é entrar **desligado**: sem preferência gravada,
  // `startCameraOff` é `true` e nenhum `getUserMedia` desta aba pede vídeo.
  // `muted` acima continua nascendo `false` de propósito — entrar sem
  // microfone é outra demanda, e nenhuma constraint de áudio muda aqui.
  const [cameraOff, setCameraOff] = useState(
    () => readPreferences(window.localStorage).startCameraOff,
  );
  const [sharingScreen, setSharingScreen] = useState(false);
  const [mediaError, setMediaError] = useState<string | null>(null);
  // O navegador barrou a reprodução de algum elemento de áudio (voz ou música).
  // Um só estado para os dois: do ponto de vista de quem está na sala o problema
  // é um só — não sai som —, e dois avisos concorreriam pelo mesmo clique.
  const [audioBlocked, setAudioBlocked] = useState(false);
  // Incrementado pelo clique no aviso. Entra nas deps do efeito de `play()` de
  // todo elemento de áudio montado, e é isso que faz um clique destravar a sala
  // inteira. A alternativa — um registro imperativo de elementos num módulo
  // singleton — exigiria desregistro correto em todo desmonte, e um vazamento
  // ali seria um elemento morto recebendo `play()` para sempre. React já sabe
  // quais elementos estão montados; o nonce só pergunta a ele.
  const [audioUnlockNonce, setAudioUnlockNonce] = useState(0);
  // Qual tela **esta aba** vê em destaque. Preferência puramente local: não vai
  // para o servidor nem para o data channel, e escolher aqui não muda a tela de
  // mais ninguém.
  const [pinnedScreenId, setPinnedScreenId] = useState<string | null>(null);

  // Histórico de chat vive só aqui: nenhum storage, nenhum servidor. Desmontar
  // o componente (sair da sala / recarregar) apaga tudo.
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatOpen, setChatOpen] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [musicOpen, setMusicOpen] = useState(false);
  const [soundboardOpen, setSoundboardOpen] = useState(false);
  const [selfId, setSelfId] = useState('');

  const [toasts, setToasts] = useState<Toast[]>([]);
  const [audioLevels, setAudioLevels] = useState<LevelSnapshot>({});

  // Preferência de dispositivos: a única coisa que este app grava em
  // `localStorage` (ver `lib/devices.js` e `ARCHITECTURE.md` §6.10). O toggle de
  // avisos sonoros mora aqui desde que saiu da barra de controles.
  const [preferences, setPreferences] = useState(() => readPreferences(window.localStorage));
  // Supressão de ruído: chave própria (`wtk-meet:audio`), pelas razões em
  // `lib/noiseSuppression.js`. O modo é capacidade do navegador, não escolha.
  const [audioPrefs, setAudioPrefs] = useState(() => readAudioPreferences(window.localStorage));
  // Capacidade do navegador: não muda enquanto a aba viver.
  const noiseMode = useMemo(() => detectNoiseMode(), []);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsContext, setSettingsContext] = useState<AudioContext | null>(null);
  const soundsEnabled = preferences.soundsEnabled;

  /** mic + câmera (o track de vídeo entra e sai). */
  const localStreamRef = useRef<MediaStream | null>(null);
  const cameraTrackRef = useRef<MediaStreamTrack | null>(null);
  /**
   * O pipeline do microfone, com dono explícito.
   *
   * Com o worklet ativo, o track que está no `localStreamRef` **não** é o track
   * que o `getUserMedia` devolveu: o primeiro é a saída de um
   * `MediaStreamAudioDestinationNode`, o segundo é o device. Perguntar ao
   * pipeline (e não ao stream) é o que impede as quatro falhas silenciosas
   * catalogadas em `lib/micPipeline.js`.
   */
  const micPipelineRef = useRef<MicPipeline | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const signalingRef = useRef<SignalingClient | null>(null);
  const meshRef = useRef<WebRTCMesh | null>(null);
  const monitorRef = useRef<AudioLevelMonitor | null>(null);
  const selfIdRef = useRef<string | null>(null);
  const cameraBusyRef = useRef(false);
  const toastTimersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  // Espelhos para uso dentro de handlers registrados uma única vez.
  const participantsRef = useRef(participants);
  const chatOpenRef = useRef(chatOpen);
  const soundsEnabledRef = useRef(soundsEnabled);
  const displayNameRef = useRef(displayName);
  const preferencesRef = useRef(preferences);
  const mutedRef = useRef(muted);
  const cameraOffRef = useRef(cameraOff);
  const audioPrefsRef = useRef(audioPrefs);
  const noiseModeRef = useRef(noiseMode);
  // const roomKeyRef = useRef(null);

  participantsRef.current = participants;
  chatOpenRef.current = chatOpen;
  soundsEnabledRef.current = soundsEnabled;
  displayNameRef.current = displayName;
  preferencesRef.current = preferences;
  mutedRef.current = muted;
  cameraOffRef.current = cameraOff;
  audioPrefsRef.current = audioPrefs;
  noiseModeRef.current = noiseMode;

  /** Grava a preferência e devolve o valor efetivo (o storage pode recusar). */
  const savePreferences = useCallback((patch: Partial<DevicePreferences>) => {
    const saved = writePreferences(window.localStorage, patch);
    preferencesRef.current = saved;
    setPreferences(saved);
    return saved;
  }, []);

  /**
   * O toggle de câmera da tela de pré-entrada.
   *
   * Duas escritas, nesta ordem: a preferência (que é o que sobrevive a fechar a
   * aba antes de entrar) e o estado da sala. O `cameraOff` daqui é a **única**
   * fonte da verdade da escolha — o toggle do lobby não tem estado próprio.
   * Com dois estados existiria o caminho em que a pessoa vê o toggle ligado e
   * entra desligada.
   *
   * Gravar no clique, e não no submit, é o que faz a escolha valer para a
   * próxima sala mesmo se a pessoa desistir de entrar nesta.
   */
  const chooseStartCamera = useCallback(
    (on: boolean) => {
      savePreferences({ startCameraOff: !on });
      setCameraOff(!on);
    },
    [savePreferences],
  );

  /**
   * Sair do lobby. É a mudança de `displayName` que libera o efeito de setup —
   * o lobby não conecta nada, não abre socket e não entrega stream nenhum.
   */
  const enterRoom = useCallback((name: string) => {
    // Um aviso de preview que ficou na tela do lobby não tem por que atravessar
    // a entrada: o que valer na sala será dito de novo pelo efeito de setup.
    setMediaError(null);
    sessionStorage.setItem('displayName', name);
    setDisplayName(name);
  }, []);

  const saveAudioPreferences = useCallback((patch: Partial<AudioPreferences>) => {
    const saved = writeAudioPreferences(window.localStorage, patch);
    audioPrefsRef.current = saved;
    setAudioPrefs(saved);
    return saved;
  }, []);

  /** As constraints de áudio da preferência corrente, para todo `getUserMedia`. */
  const micConstraints = useCallback(
    (options: { video?: boolean; audio?: boolean }) =>
      buildConstraints(preferencesRef.current, {
        ...options,
        audioProcessing: noiseConstraints(audioPrefsRef.current),
      }),
    [],
  );

  // Handler de `ended` dos tracks locais. Vive num ref porque `watchLocalTrack`
  // precisa existir antes das funções que ele aciona (todas se referenciam).
  const trackEndedRef = useRef<(track: MediaStreamTrack) => void>(() => {});
  const watchedTracksRef = useRef(new WeakSet());

  /**
   * Um device arrancado enquanto está em uso encerra o track (`ended`) — o
   * navegador não migra para outro sozinho. Sem este listener, o microfone
   * simplesmente para de existir para os outros participantes, sem nenhum aviso.
   */
  const watchLocalTrack = useCallback((track: MediaStreamTrack | null | undefined) => {
    if (!track || watchedTracksRef.current.has(track)) return;
    watchedTracksRef.current.add(track);
    track.addEventListener('ended', () => trackEndedRef.current(track));
  }, []);

  /**
   * Troca o track de áudio local em todos os senders do mesh, preservando o
   * estado de mute e o anel de fala do tile local.
   *
   * Não para nada: quem tem o que parar é o dono do pipeline anterior
   * (`installAudioPipeline`). Alternar a supressão reaproveita esta função
   * justamente porque nela **nenhum** device é encerrado — os dois tracks
   * (cru e processado) continuam vivos, e só muda qual deles vai ao ar.
   */
  const attachAudioTrack = useCallback(async (track: MediaStreamTrack | null | undefined) => {
    const stream = localStreamRef.current;
    if (!track || !stream) return;

    // Track novo nasce `enabled = true`. Sem esta linha, trocar de microfone
    // desmuta a pessoa sem que ela peça — e ela precisa vir ANTES do
    // replaceTrack, senão existe uma janela de frames em que o áudio vaza.
    track.enabled = !mutedRef.current;

    const old = stream.getAudioTracks()[0] || null;
    // `replaceTrack` com o mesmo kind num transceiver já negociado: não há
    // renegociação de SDP e nenhum peer muda de estado.
    await meshRef.current?.setAudioTrack(track);
    if (old && old !== track) stream.removeTrack(old);
    if (old !== track) stream.addTrack(track);

    // `attach` é idempotente por (id, stream) e o MediaStream local é o
    // **mesmo objeto** depois da troca (só o track interno mudou). Um attach
    // sozinho retornaria cedo e o analisador continuaria preso ao track
    // antigo, já parado: o anel de fala local morreria em silêncio.
    monitorRef.current?.detach(LOCAL_AUDIO_ID);
    monitorRef.current?.attach(LOCAL_AUDIO_ID, stream);
  }, []);

  /**
   * Assume um pipeline novo como o do microfone corrente e descarta o anterior.
   *
   * A ordem é a mesma de sempre e não é negociável: `replaceTrack` primeiro,
   * `stop` do antigo depois. Parar antes abriria uma janela de silêncio audível
   * para todos os peers.
   *
   * O `ended` é observado no **track cru**: o track do destino do worklet nunca
   * dispara `ended`: arrancar o microfone faria o grafo passar a processar
   * silêncio para sempre, e a recuperação nunca rodaria.
   */
  const installAudioPipeline = useCallback(
    async (pipeline: MicPipeline | null) => {
      if (!pipeline) return;
      const previous = micPipelineRef.current;
      micPipelineRef.current = pipeline;
      await attachAudioTrack(pipeline.track);
      watchLocalTrack(pipeline.rawTrack);
      if (previous && previous !== pipeline) previous.stop();
    },
    [attachAudioTrack, watchLocalTrack],
  );

  // const e2eeSupported = isInsertableStreamsSupported();

  const pushToast = useCallback((kind: string, text: string) => {
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
  // Favoritos e mutes desta aba. Vem **antes** do `useMusicRoom` porque é ele
  // quem responde "silenciei o soundboard deste peer?" quando um anúncio chega.
  const soundboard = useSoundboard({ storage: window.localStorage });
  const music = useMusicRoom({
    meshRef,
    participants,
    getSelfId: () => selfId,
    displayName,
    pushToast,
    isSoundboardMuted: soundboard.isMuted,
  });
  // Callbacks estáveis do hook: extraídos para as deps abaixo não mudarem a
  // cada render (o objeto `music.soundboard` é remontado a cada um).
  const { fire: fireSound, setPanelOpen: setSoundboardPanelOpen } = music.soundboard;
  const { reportFire } = soundboard;
  const musicCallbacksRef = useRef(music.meshCallbacks);
  musicCallbacksRef.current = music.meshCallbacks;

  useEffect(() => {
    // O redirect de canonicalização/chave roda primeiro (efeito acima). Sem
    // este early-return a câmera acenderia duas vezes e dois sockets entrariam
    // na mesma sala com o mesmo nome — um deles com o path errado.
    if (redirectPending) return undefined;
    if (!displayName || !passphrase) return undefined;

    let cancelled = false;
    // Capturado aqui (e não lido do ref na limpeza) porque o ref pode já ter
    // sido reatribuído quando o cleanup roda.
    const toastTimers = toastTimersRef.current;

    /**
     * O que pedir na entrada, e em que ordem. A cadeia vem de `initialMediaPlan`
     * (pura, coberta em `test/joinCameraDefault.test.mjs`) e não de um `if`
     * aqui: é a preferência que decide se **alguma** tentativa pede vídeo, e é
     * disso que depende o LED da webcam ficar apagado para quem só abriu o link.
     *
     * A última tentativa ignora a preferência de microfone de propósito: sem
     * ela, uma preferência obsoleta (headset que ficou em outra máquina) faria a
     * pessoa entrar sem áudio nenhum — e nada disso pode virar erro na tela.
     */
    const mediaPlan = initialMediaPlan(preferencesRef.current, {
      audioProcessing: noiseConstraints(audioPrefsRef.current),
    });

    async function getLocalStream() {
      for (const constraints of mediaPlan.attempts) {
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
        // Quando religar: `roomId` aqui já é o path **canônico** (ver o efeito
        // de canonicalização no topo), e é isso que o salt do PBKDF2 exige —
        // derivar de um path não canonicalizado daria chaves diferentes para
        // quem entrou por `/Daily` e por `/daily`.
      ]);
      if (cancelled) {
        localStream?.getTracks().forEach((t) => t.stop());
        return;
      }

      localStreamRef.current = localStream;
      cameraTrackRef.current = localStream?.getVideoTracks()[0] || null;
      // Confirmação, não correção: com `startCameraOff`, entrar sem track de
      // vídeo é o caminho normal.
      if (!cameraTrackRef.current) setCameraOff(true);
      // Mas pedir vídeo e não conseguir é outra coisa: é uma discrepância entre
      // o que a pessoa escolheu e o que aconteceu, e sem aviso ela conclui que
      // os outros estão vendo a imagem dela. Quem entrou desligado não teve
      // falha nenhuma e não ouve nada.
      if (mediaPlan.wantsVideo && !cameraTrackRef.current) {
        setMediaError('Não foi possível abrir a câmera: você entrou sem vídeo. Dá para tentar de novo em "Ativar câmera".');
      }

      // O `AudioContext` é um só para a sala e o dono dele é este componente:
      // nós de contextos diferentes não podem ser conectados, e o grafo da
      // música precisa do mesmo contexto do indicador de fala. Enquanto o
      // monitor era o dono, `monitor.close()` mataria a música em silêncio.
      const monitor = new AudioLevelMonitor({ onUpdate: setAudioLevels, getContext: getAudioContext });
      monitorRef.current = monitor;
      const audioContext = monitor.ensureContext();
      const stopGestureHook = resumeAudioContextOnGesture();

      // O pipeline vem **antes** do mesh e do monitor: é o track processado que
      // precisa entrar no `localStreamRef`, senão o mesh nasceria transmitindo
      // o cru e o medidor mediria o áudio que ninguém recebe.
      const rawAudioTrack = localStream?.getAudioTracks()[0] || null;
      // `rawAudioTrack` só existe se `localStream` existe — o `&&` diz isso ao
      // compilador sem mudar o que o `if` decide.
      if (rawAudioTrack && localStream) {
        const pipeline = await createMicPipeline({
          rawTrack: rawAudioTrack,
          enabled: audioPrefsRef.current.noiseSuppression,
          mode: noiseModeRef.current,
          context: audioContext,
        });
        if (cancelled) {
          pipeline.stop();
          localStream.getTracks().forEach((t) => t.stop());
          return;
        }
        micPipelineRef.current = pipeline;
        if (pipeline.track !== rawAudioTrack) {
          localStream.removeTrack(rawAudioTrack);
          // O pipeline só troca o track quando produz um; aqui ele existe.
          if (pipeline.track) localStream.addTrack(pipeline.track);
        }
        // Só o cru: o track do destino não dispara `ended` e não tem deviceId.
        watchLocalTrack(rawAudioTrack);

        // Contexto suspenso é o estado **normal** antes do primeiro gesto
        // (política de autoplay), e recarregar a página com o nome já em
        // sessionStorage entra na sala sem nenhum clique. Sem esta re-tentativa,
        // quem recarrega fica com a supressão desligada para sempre, sem nada
        // na tela dizendo isso. Aqui o `await resume()` é seguro justamente
        // porque estamos **dentro** de um gesto — no caminho de entrada ele
        // ficaria pendente e travaria a sala.
        if (!pipeline.processing && pipeline.mode === MODE.WORKLET && audioPrefsRef.current.noiseSuppression) {
          const events = ['click', 'keydown', 'touchstart'];
          const unregister = () => {
            for (const evt of events) window.removeEventListener(evt, onGesture);
          };
          const onGesture = async () => {
            const current = micPipelineRef.current;
            if (cancelled || !current || current.processing) {
              unregister();
              return;
            }
            const ctx = getAudioContext();
            if (!ctx) return;
            try {
              await ctx.resume();
            } catch {
              return;
            }
            if (cancelled || ctx.state !== 'running' || micPipelineRef.current !== current) return;
            const upgraded = await createMicPipeline({
              rawTrack: current.rawTrack,
              enabled: audioPrefsRef.current.noiseSuppression,
              mode: noiseModeRef.current,
              context: ctx,
            });
            // Falhou de novo: descartar o objeto e sair sem `stop()` — ele
            // compartilha o `rawTrack` com o pipeline em uso.
            if (cancelled || !upgraded.processing) return;
            if (micPipelineRef.current !== current) return;
            micPipelineRef.current = upgraded;
            await attachAudioTrack(upgraded.track);
            unregister();
          };
          for (const evt of events) window.addEventListener(evt, onGesture, { passive: true });
          cleanupExtras.push(unregister);
        }
      }
      if (cameraTrackRef.current) watchLocalTrack(cameraTrackRef.current);

      // A verdade sobre qual device foi aberto vem do track **cru**, não do que
      // foi pedido nem do que está no stream: é assim que uma preferência
      // apontando para hardware que sumiu se corrige sozinha, sem nenhuma
      // mensagem de erro. O track do destino do worklet não tem `deviceId`, e
      // passá-lo aqui faria a autocorreção parar de funcionar em silêncio.
      if (localStream) {
        const { prefs, changed } = reconcilePreferences(preferencesRef.current, [
          cameraTrackRef.current,
          micPipelineRef.current?.rawTrack || null,
        ]);
        if (changed) savePreferences(prefs);
      }
      // roomKeyRef.current = roomKey;

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
            next.set(peerId, { ...DEFAULT_PARTICIPANT, ...(next.get(peerId) || {}), stream });
            return next;
          });
        },
        onRemoteScreen: (peerId, screenStream) => {
          setParticipants((prev) => {
            if (!prev.has(peerId)) return prev;
            const next = new Map(prev);
            next.set(peerId, { ...DEFAULT_PARTICIPANT, ...next.get(peerId), screenStream });
            return next;
          });
        },
        // O estado da `RTCPeerConnection` de cada peer. O mesh já disparava
        // isto a cada transição e ninguém escutava — a ponta estava solta, e é
        // por isso que um peer em `failed` tinha um tile idêntico ao de um peer
        // perfeito. Aqui o estado só é **observado**: reagir a `failed` é do
        // `lib/webrtcMesh.js`.
        onPeerStateChange: (peerId, connectionState) => {
          setParticipants((prev) => applyPeerConnectionState(prev, peerId, connectionState));
        },
        onRemotePeerState: (peerId, state) => {
          setParticipants((prev) => {
            if (!prev.has(peerId)) return prev;
            const current = { ...DEFAULT_PARTICIPANT, ...prev.get(peerId) };
            const next = new Map(prev);
            next.set(peerId, {
              ...current,
              cameraOff: state.cameraOff,
              micOff: state.micOff,
              // O nome vindo do peer só complementa: o servidor já mandou o dele.
              // TODO(WTK-MEET-21): `state.displayName` chega sem sanitização do
              // outro browser (ver `RemotePeerState` em `lib/webrtcMesh.ts`); o
              // `String()` preserva o que o `||` já fazia e não valida nada novo.
              displayName: current.displayName || String(state.displayName ?? ''),
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
            next.set(member.id, {
              ...DEFAULT_PARTICIPANT,
              ...(next.get(member.id) || {}),
              displayName: member.displayName,
            });
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
          next.set(peerId, { ...DEFAULT_PARTICIPANT, ...(next.get(peerId) || {}), displayName: name });
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

    const cleanupExtras: (() => void)[] = [];

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

      // O pipeline primeiro: com o worklet ativo, o `localStreamRef` contém
      // apenas o track do **destino**, e parar só ele deixaria o `getUserMedia`
      // vivo — LED do microfone aceso depois de sair da sala, indicador do
      // sistema operacional ligado, e o próximo `getUserMedia` podendo falhar
      // com NotReadableError.
      micPipelineRef.current?.stop();
      micPipelineRef.current = null;
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
  }, [roomId, passphrase, displayName, redirectPending]);

  /**
   * Page view da sala — depois do redirect, nunca antes.
   *
   * Contar na montagem contaria também os paths que nem são sala (`/assets`,
   * `/a/b`), que voltam para a Home no efeito de canonicalização. `route:
   * 'room'` é tudo o que viaja: nem o slug, nem o fragmento (que carrega a
   * passphrase), nem o nome de quem entrou.
   */
  useEffect(() => {
    if (redirectPending) return;
    trackPageView('room');
  }, [redirectPending]);

  /**
   * Quanto tempo a aba ficou na sala.
   *
   * É a segunda das duas perguntas que o servidor não responde sozinho: ele vê
   * o socket cair, mas não vê a aba que continua aberta depois disso — e nem a
   * aba que fica aberta e escondida.
   *
   * Três gatilhos, e `end()` idempotente porque eles se sobrepõem: o unmount
   * do efeito, o `pagehide` e o `visibilitychange → hidden`. `unload` **não**
   * entra: navegadores com bfcache o ignoram, e um beacon disparado dali some
   * em silêncio.
   *
   * Consequência de medida que precisa estar escrita: com `visibilitychange`
   * entre os gatilhos, esta métrica é "tempo até a aba ser escondida ou
   * fechada pela primeira vez", e não "duração da reunião" — trocar de aba no
   * meio da chamada encerra a contagem. É o preço de o beacon chegar em
   * navegador móvel, onde `pagehide` não é garantido. Quem quer duração de
   * reunião lê `wtk_session_duration_seconds`, medida no servidor.
   */
  useEffect(() => {
    if (phase !== PHASE.IN_CALL) return undefined;
    const session = startSession();
    const finish = () => session.end();
    const onVisibility = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') finish();
    };
    window.addEventListener('pagehide', finish);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', finish);
      document.removeEventListener('visibilitychange', onVisibility);
      finish();
    };
  }, [phase]);

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

  const approve = useCallback((requesterId: string) => {
    signalingRef.current?.approveJoin(requesterId);
    setPendingRequests((prev) => prev.filter((r) => r.requesterId !== requesterId));
  }, []);

  const deny = useCallback((requesterId: string) => {
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
  /**
   * Liga/desliga a supressão **sem** tocar no hardware e sem renegociar SDP.
   *
   * No modo worklet os dois tracks já existem (o cru e o do destino), então
   * alternar é escolher qual deles vai para os senders — um `replaceTrack` com
   * o mesmo kind num transceiver já negociado. O mute é preservado porque
   * `attachAudioTrack` ajusta `enabled` antes da troca.
   *
   * Devolve `false` quando o modo é `native` (não há segundo track: a mudança
   * só existe se o navegador reabrir a captura com a constraint nova), e aí quem
   * chama cai no caminho de reaquisição.
   */
  const applyNoiseSuppression = useCallback(
    async (value: boolean) => {
      const pipeline = micPipelineRef.current;
      if (!pipeline || noiseModeRef.current !== MODE.WORKLET) return false;

      if (value) {
        if (pipeline.processing) return true;
        const engaged = await createMicPipeline({
          rawTrack: pipeline.rawTrack,
          enabled: true,
          mode: MODE.WORKLET,
          context: getAudioContext(),
        });
        // Degradou (contexto suspenso, addModule falhando): o objeto novo
        // compartilha o `rawTrack`, então é descartado **sem** `stop()`.
        if (!engaged.processing) return false;
        micPipelineRef.current = engaged;
        await attachAudioTrack(engaged.track);
        return true;
      }

      if (!pipeline.processing) return true;
      // Troca primeiro, desmonta depois: o inverso deixaria os peers em
      // silêncio durante a transição.
      await attachAudioTrack(pipeline.rawTrack);
      micPipelineRef.current = pipeline.release();
      return true;
    },
    [attachAudioTrack],
  );

  const applyDeviceSelection = useCallback(
    async ({ noiseSuppression, ...next }: PendingPreferences) => {
      const previous = preferencesRef.current;
      const previousAudio = audioPrefsRef.current;
      const merged = { ...previous, ...next };
      const nextNoise =
        typeof noiseSuppression === 'boolean' ? noiseSuppression : previousAudio.noiseSuppression;
      setSettingsOpen(false);
      // Grava antes de mexer no hardware: se a troca falhar, a escolha da pessoa
      // não se perde junto.
      savePreferences(merged);
      saveAudioPreferences({ noiseSuppression: nextNoise });

      const stream = localStreamRef.current;
      const videoChanged = merged.videoInputId !== previous.videoInputId;
      const audioChanged = merged.audioInputId !== previous.audioInputId;
      const noiseChanged = nextNoise !== previousAudio.noiseSuppression;
      if (!stream || (!videoChanged && !audioChanged && !noiseChanged)) return;

      // Só a supressão mudou: caminho rápido, sem `getUserMedia` e sem passar
      // pelo `cameraBusyRef`. Um checkbox de qualidade não pode ter o mesmo
      // custo e o mesmo risco de trocar de microfone.
      if (noiseChanged && !audioChanged && !videoChanged) {
        if (await applyNoiseSuppression(nextNoise)) return;
        // No modo nativo não há o que alternar em memória: segue para a
        // reaquisição abaixo, que é o que aplica a constraint nova.
      }
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
        if (audioChanged || noiseChanged) {
          const fresh = await navigator.mediaDevices.getUserMedia(
            micConstraints({ video: false, audio: true }),
          );
          const pipeline = await createMicPipeline({
            rawTrack: fresh.getAudioTracks()[0],
            enabled: nextNoise,
            mode: noiseModeRef.current,
            context: getAudioContext(),
          });
          await installAudioPipeline(pipeline);
        }

        // Câmera desligada: só a preferência é gravada. Reacender a câmera para
        // aplicar uma troca que ninguém pediu é acender o LED da webcam sem
        // consentimento — a escolha vale a partir do próximo "Ativar câmera".
        if (videoChanged && !cameraOffRef.current) {
          const fresh = await navigator.mediaDevices.getUserMedia(
            micConstraints({ video: true, audio: false }),
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

        // O track cru, nunca `stream.getTracks()`: com o worklet ativo o stream
        // carrega o track do destino, que não tem `deviceId` — a reconciliação
        // pararia de corrigir preferências obsoletas, e em silêncio.
        const { prefs, changed } = reconcilePreferences(preferencesRef.current, [
          cameraTrackRef.current,
          micPipelineRef.current?.rawTrack || null,
        ]);
        if (changed) savePreferences(prefs);
      } catch (err) {
        console.error('[Room] applyDeviceSelection failed:', err);
        setMediaError('Não foi possível trocar de dispositivo. A escolha ficou salva mesmo assim.');
      } finally {
        cameraBusyRef.current = false;
      }
    },
    [
      applyNoiseSuppression,
      installAudioPipeline,
      micConstraints,
      saveAudioPreferences,
      savePreferences,
      watchLocalTrack,
    ],
  );

  /**
   * Device em uso desapareceu. O navegador encerra o track e não migra sozinho:
   * quem repõe é a aplicação — sem áudio, ninguém do outro lado ouve mais nada.
   */
  const handleLocalTrackEnded = useCallback(
    async (track: MediaStreamTrack) => {
      const stream = localStreamRef.current;
      // Track que já foi substituído (troca normal de device) não é perda.
      //
      // O track cru do pipeline entra na guarda porque, com o worklet ativo, ele
      // **não** está no `localStreamRef` — o stream carrega o track do destino.
      // Sem esta linha, arrancar o microfone não dispararia recuperação nenhuma:
      // o `ended` chegaria, seria descartado aqui, e o grafo seguiria
      // processando silêncio para sempre.
      const isMicRawTrack = micPipelineRef.current?.rawTrack === track;
      if (!stream || (!isMicRawTrack && !stream.getTracks().includes(track))) return;

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
        // Sem restrição de device — o que estava salvo é justamente o que sumiu —
        // mas a preferência de supressão continua valendo: a pessoa não pediu
        // para desligá-la, só perdeu o microfone.
        const fresh = await navigator.mediaDevices.getUserMedia({
          video: false,
          audio: { ...noiseConstraints(audioPrefsRef.current) },
        });
        const pipeline = await createMicPipeline({
          rawTrack: fresh.getAudioTracks()[0],
          enabled: audioPrefsRef.current.noiseSuppression,
          mode: noiseModeRef.current,
          context: getAudioContext(),
        });
        await installAudioPipeline(pipeline);
      } catch (err) {
        console.error('[Room] recuperação de microfone falhou:', err);
      }
      setMediaError('O microfone em uso foi desconectado. Voltamos para o padrão do sistema.');
    },
    [installAudioPipeline, savePreferences],
  );

  trackEndedRef.current = handleLocalTrackEnded;

  /**
   * `setSinkId` rejeita quando o id não existe mais ou quando o navegador nega.
   * Voltar para o padrão do sistema é o único desfecho útil: insistir num id
   * inválido deixaria a pessoa sem áudio nenhum.
   */
  const handleSinkError = useCallback(
    (err: unknown) => {
      console.warn('[Room] setSinkId falhou:', err);
      // O sink agora é aplicado em N elementos (um `<audio>` por peer, mais os
      // da música), então um deviceId morto rejeita N promises e este handler é
      // chamado N vezes. A idempotência sai daqui: a primeira chamada zera a
      // preferência, e da segunda em diante o `return` acima corta — um toast e
      // um `setMediaError` só. Nada de debounce por timer: um flag global "já
      // avisei" que nunca é resetado deixaria a próxima escolha inválida
      // silenciosa.
      if (!preferencesRef.current.audioOutputId) return;
      savePreferences({ audioOutputId: '' });
      setMediaError('A saída de áudio escolhida não pôde ser usada. Voltamos para o padrão.');
    },
    [savePreferences],
  );

  /**
   * O clique no aviso de "o navegador bloqueou o som".
   *
   * Um clique, três destravamentos, porque são três portões distintos e o
   * usuário não tem por que conhecer nenhum deles: o `AudioContext` (supressão
   * de ruído e medidor de fala), os `<audio>` de voz e de música (via
   * `audioUnlockNonce`, que entra nas deps do efeito de `play()` de cada
   * elemento montado) e o player de música, que tem estado próprio em
   * `lib/useMusicRoom.js` e não é este.
   *
   * O aviso é apagado **antes** da re-tentativa, de propósito: se ela falhar de
   * novo, o `onBlocked` de qualquer elemento o reacende sozinho. É o que impede
   * o aviso de virar falso positivo permanente — `play()` também rejeita com
   * `AbortError` quando o elemento é pausado no meio da chamada, e um aviso que
   * nunca some treina o usuário a ignorá-lo.
   */
  const unlockAudio = useCallback(() => {
    setAudioBlocked(false);
    setAudioUnlockNonce((nonce) => nonce + 1);
    // Estamos dentro de um gesto: é exatamente aqui que retomar o contexto é
    // permitido.
    getAudioContext();
    // `music.unlockAudio` é assíncrono e faz `await player.play()`, que rejeita
    // quando o navegador continua barrando. Sem este `catch` a rejeição viraria
    // `unhandledrejection` — erro de console, que a checagem G do E2E trata como
    // falha. O caso já está coberto: o `onBlocked` do elemento reacende o aviso.
    Promise.resolve(music.unlockAudio?.()).catch(() => {
      setAudioBlocked(true);
    });
  }, [music]);

  /** Qualquer elemento de áudio que o navegador tenha barrado acende o aviso. */
  const handleAudioBlocked = useCallback(() => setAudioBlocked(true), []);

  /**
   * A música barrada acende **os dois** avisos: o banner novo, sempre visível na
   * sala, e o botão do painel de música, que já existia. Eles leem estados
   * diferentes (`audioBlocked` daqui e `music.audioBlocked`), e o do painel só
   * existe com o painel aberto — quem nunca o abre não teria caminho nenhum.
   */
  const handleMusicBlocked = useCallback(() => {
    music.reportBlocked();
    setAudioBlocked(true);
  }, [music]);

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
      const patch: Partial<DevicePreferences> = {};
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
      const nome = err instanceof Error ? err.name : '';
      if (nome !== 'NotAllowedError' && nome !== 'AbortError') {
        console.error('[Room] startScreenShare failed:', err);
        setMediaError('Não foi possível compartilhar a tela.');
      }
    }
  }, [stopScreenShare]);

  const sendChat = useCallback((text: string) => {
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
    setSoundboardOpen(false);
    setUnreadCount(0);
  }, []);

  /**
   * O terceiro painel entra na mesma regra de exclusividade: a página nunca
   * rola e a grade é calculada para caber no viewport, então dois painéis
   * abertos já espremeriam os tiles até o piso de legibilidade.
   *
   * Abrir o painel também **ata o canal de música** (ver `useMusicRoom`): quem
   * vai disparar abriu o painel, e ativar o sender no mesmo instante do clique
   * faria um efeito de 1,2s perder o ataque.
   */
  const toggleSoundboard = useCallback(() => {
    setSoundboardOpen((open) => {
      if (!open) {
        setChatOpen(false);
        setMusicOpen(false);
      }
      return !open;
    });
  }, []);

  const closeSoundboard = useCallback(() => setSoundboardOpen(false), []);

  // A posse do canal segue o painel por **efeito**, e não de dentro do
  // atualizador de estado acima: um atualizador é chamado mais de uma vez em
  // modo estrito, e efeito colateral dentro dele acontece o dobro das vezes.
  useEffect(() => {
    setSoundboardPanelOpen(soundboardOpen);
  }, [setSoundboardPanelOpen, soundboardOpen]);

  /** Dispara e traduz a recusa (CORS, cooldown) em mensagem no painel. */
  const playSound = useCallback(
    (favorite: Favorite) => {
      void fireSound(favorite).then(reportFire);
    },
    [fireSound, reportFire],
  );

  const toggleMusic = useCallback(() => {
    if (!music.enabled) {
      // Ligar o player é a única coisa que a sala decide junto: o custo de
      // ligar para todo mundo é alto, o de pular uma faixa não é (por isso
      // pular e remover são abertos, sem votação).
      music.actions.proposeEnable();
      return;
    }
    setMusicOpen((open) => {
      if (!open) {
        setChatOpen(false);
        closeSoundboard();
      }
      return !open;
    });
  }, [closeSoundboard, music.actions, music.enabled]);

  /** Quem pode ser silenciado no painel: os peers, nunca eu mesmo. */
  const soundboardPeople = useMemo(
    () =>
      [...participants.entries()].map(([peerId, person]) => ({
        peerId,
        name: person.displayName || 'Participante',
      })),
    [participants],
  );

  /**
   * As pessoas da sala, na ordem de chegada (o `Map` preserva a inserção). As
   * chaves são as mesmas de sempre (`local`, `<peerId>`): mudar a chave remonta
   * o `<video>` a cada render.
   */
  const people = useMemo((): Tile[] => {
    const list: Tile[] = [
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
        // Só os remotos. Não existe `RTCPeerConnection` para si mesmo, e um
        // indicador no próprio tile seria uma afirmação sem fonte.
        connection: describeConnection(info.connectionState),
      });
    }
    return list;
    // localStreamRef é ref: as deps abaixo são exatamente os gatilhos que mudam
    // o conteúdo dela. (A supressão que ficava aqui deixou de ser necessária com
    // o `eslint-plugin-react-hooks` 5, que já não cobra refs nas deps.)
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
        // Mesma conexão do dono: uma tela congelada porque a conexão morreu
        // precisa dizer isso, em vez de parecer uma apresentação parada.
        connection: describeConnection(info.connectionState),
      });
    }
    return list;
    // screenStreamRef é ref: `sharingScreen` é exatamente o gatilho que muda o
    // conteúdo dela. (Idem à nota acima sobre a supressão removida.)
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
      <PeerAudio
        participants={participants}
        sinkId={preferences.audioOutputId}
        onSinkError={handleSinkError}
        onBlocked={handleAudioBlocked}
        unlockNonce={audioUnlockNonce}
      />
      <Toasts toasts={toasts} />
      <MusicVoteCard
        vote={music.vote}
        myVote={music.myVote}
        onVote={music.actions.castMyVote}
        onClose={music.actions.dismissVote}
      />
      {/* Os `<audio>` da música e o host do player do YouTube ficam aqui, fora
          de qualquer ramo de fase: dentro do painel, fechar o painel
          silenciaria a sala e o sintoma pareceria problema de rede. */}
      <RemoteMusicAudio
        streams={music.musicStreams}
        volume={music.volume}
        mutedPeerIds={music.soundboard.silencedPeerIds}
        onBlocked={handleMusicBlocked}
        sinkId={preferences.audioOutputId}
        onSinkError={handleSinkError}
        unlockNonce={audioUnlockNonce}
      />
      <div className="music-youtube-host" ref={music.youtubeHostRef} aria-hidden="true" />
      {/* Montado condicionalmente de propósito: é o desmonte que para o stream
          de preview, então sair do modal por qualquer via (botão, Esc, backdrop,
          navegação) apaga o LED da câmera pelo mesmo caminho. */}
      {settingsOpen && (
        <SettingsModal
          preferences={preferences}
          noiseSuppression={audioPrefs.noiseSuppression}
          noiseMode={noiseMode}
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

  // Tela de pré-entrada. Continua sendo o ramo `!displayName`, e não um estado
  // `joined` novo: quem já tem nome em `sessionStorage` (quem veio da Home,
  // quem recarregou a página) entra direto, com a preferência gravada decidindo
  // a câmera. Exigir um clique para reconfirmar a cada F5 seria ruído — e o
  // ganho de privacidade é nulo, já que sem preferência o padrão já é desligada.
  if (!displayName) {
    return (
      <>
        {overlays}
        <PreJoin
          preferences={preferences}
          nameInput={nameInput}
          onNameChange={setNameInput}
          cameraOn={!cameraOff}
          onToggleCamera={chooseStartCamera}
          // O `SettingsModal` abre o próprio preview de câmera: enquanto ele
          // estiver aberto, o do lobby precisa estar parado.
          previewPaused={settingsOpen}
          onSubmit={enterRoom}
          onOpenSettings={openSettings}
          onPreviewError={setMediaError}
          previewError={mediaError}
        />
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
                  : denyReason === 'invalid-room'
                    ? 'Esse endereço de sala não é válido. Confira o link — ele vai até o final, incluindo a parte depois do #.'
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
              {/* `cameraOff` é obrigatório aqui: sem ele o tile ficaria preto
                  para quem entrou sem vídeo, que passou a ser o caminho comum. */}
              <VideoTile
                stream={localStreamRef.current}
                label={displayName}
                mirrored
                cameraOff={cameraOff}
              />
            </div>
            {/* Momento certo para descobrir que a câmera errada está ativa: aqui,
                e não já visível para todo mundo na grade. */}
            <button onClick={openSettings}>Configurações</button>
          </div>
        </main>
      </>
    );
  }

  const inviteLink = buildRoomUrl(window.location.origin, roomId, passphrase);
  const roomSize = participants.size + 1;

  return (
    <>
      {overlays}
      <main
        className={`room in-call${chatOpen ? ' with-chat' : ''}${musicOpen ? ' with-music' : ''}${
          soundboardOpen ? ' with-soundboard' : ''
        }`}
      >
        {/* E2EE desabilitado por ora */}

        {mediaError && <p className="warning">{mediaError}</p>}

        {/* Fora de qualquer painel, e `<button>` de verdade — não um `<div
            onClick>`. O único caminho de destravamento que existia era o botão
            dentro do painel de música, que só existe com o painel aberto: quem
            não o abre ficava em silêncio sem nenhuma saída. Também não é um
            toast: toasts somem sozinhos, e silêncio depois de um toast expirado
            é o mesmo defeito numa forma nova. */}
        {audioBlocked && (
          <button type="button" className="warning audio-blocked" onClick={unlockAudio}>
            O navegador bloqueou o som desta sala. Clique aqui para ouvir os
            participantes e a música.
          </button>
        )}

        <div className="stage">
          {/* Antes do palco de vídeo de propósito: `.stage` é um flex row, e a
              ordem do JSX é a ordem visual. É também o que faz o painel
              conviver com o modo destaque sem sobrepor nada — ele empurra o
              `SpotlightStage` e o `ThumbnailRail` em vez de flutuar por cima. */}
          {soundboardOpen && (
            <SoundboardPanel
              favorites={soundboard.favorites}
              activity={music.soundboard.activity}
              people={soundboardPeople}
              floodingPeerIds={music.soundboard.floodingPeerIds}
              mutedAll={soundboard.mutedAll}
              mutedPeerIds={soundboard.mutedPeerIds}
              cooldownMs={music.soundboard.cooldownMs}
              error={soundboard.error}
              selfId={selfId}
              onClose={closeSoundboard}
              onAdd={soundboard.add}
              onRemove={soundboard.remove}
              onRename={soundboard.rename}
              onPlay={playSound}
              onToggleMutedAll={soundboard.toggleMutedAll}
              onTogglePeerMuted={soundboard.togglePeerMuted}
            />
          )}

          {spotlightScreen ? (
            <SpotlightStage
              spotlight={spotlightScreen}
              thumbnails={thumbnails}
              audioLevels={audioLevels}
              onSelectScreen={setPinnedScreenId}
            />
          ) : (
            <VideoGrid tiles={people} audioLevels={audioLevels} />
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

        {music.currentEntry && !musicOpen && (
          <div
            className="now-playing-bar"
            onClick={toggleMusic}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => e.key === 'Enter' && toggleMusic()}
            title={music.currentEntry.title}
          >
            <span className="now-playing-label">Tocando</span>
            <span className="now-playing-title">{music.currentEntry.title}</span>
            {music.playback.playing && <span className="now-playing-pulse" aria-hidden="true" />}
          </div>
        )}

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
          {/* Sem emoji dentro do texto: os roteiros do e2e comparam
              `textContent` exato de botões desta barra. */}
          <button
            onClick={toggleMusic}
            className={`music-button${music.currentEntry ? ' has-track' : ''}`}
            aria-pressed={musicOpen}
            title={
              music.currentEntry
                ? music.currentEntry.title
                : music.enabled
                  ? 'Fila de música da sala'
                  : 'Propor à sala ligar o player de música'
            }
          >
            Música
            {music.currentEntry && (
              <span className="music-button-track">{music.currentEntry.title}</span>
            )}
          </button>
          {/* Rótulo exato `Soundboard`, sem emoji e sem começar por
              `Silenciar`/`Chat`/`Música`: os roteiros do e2e procuram botões
              desta barra por `textContent` exato e por prefixo. */}
          <button
            type="button"
            className="soundboard-button"
            onClick={toggleSoundboard}
            aria-label="Soundboard"
            aria-expanded={soundboardOpen}
            title="Efeitos sonoros favoritados neste navegador"
          >
            Soundboard
          </button>
          <button
            onClick={() => savePreferences({ soundsEnabled: !soundsEnabled })}
            title="Bipe de entrada e saída de participantes"
          >
            {soundsEnabled ? 'Silenciar avisos' : 'Ativar avisos'}
          </button>
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
          Link do convite: <code>{inviteLink}</code> — copie inteiro, inclusive depois do{' '}
          <code>#</code>, e compartilhe por outro canal.
          {roomSize >= MAX_PARTICIPANTS && ' Sala no limite de participantes.'}
        </p>
      </main>
    </>
  );
}
