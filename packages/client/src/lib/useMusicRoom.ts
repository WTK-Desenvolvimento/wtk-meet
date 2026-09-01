/**
 * Orquestração do player colaborativo dentro da sala: liga o modelo puro
 * (`musicSession.js` / `musicVote.js`) ao mundo real (data channel, `MusicEngine`,
 * player do YouTube) e devolve ao `Room` um punhado de ações e uma visão pronta
 * para render.
 *
 * Mora aqui, e não em `Room.jsx`, por um motivo prático: `Room` já orquestra
 * mídia, chat, toasts e pedidos de entrada; somar a isso a máquina de estados da
 * música deixaria o arquivo grande demais para ser lido de uma vez. A fronteira
 * é limpa — este hook não conhece JSX e o `Room` não conhece o protocolo.
 *
 * As regras de convergência estão todas nos módulos puros. O que este arquivo
 * acrescenta é *quem age*, e é aí que moram as decisões:
 *
 * - **Reprodução tem escritor único: o dono da faixa corrente.** Quem não é dono
 *   manda um pedido (`music-command`); o dono aplica e publica o resultado.
 * - **Trocar de faixa é publicado pelo dono da faixa *seguinte*** — nunca pelo da
 *   que acabou. É o que garante exatamente um escritor em cada transição, em vez
 *   de um "parei" e um "comecei" disputando a mesma versão.
 * - **Ninguém negocia nada.** Quem começa, quem assume quando alguém cai, qual
 *   das duas propostas simultâneas vale: tudo sai de funções determinísticas
 *   sobre um estado que todos têm igual, então todos chegam à mesma conclusão
 *   sem trocar uma mensagem sequer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getAudioContext } from './audioContext.js';
import { MusicEngine } from './musicEngine.js';
import { SoundboardError, SoundboardPlayer } from './soundboardPlayer.js';
import { MAX_SOUND_MS } from './soundboard.js';
import { consume, createRateState, retryInMs } from './soundboardRate.js';
import type { Favorite } from './soundboard.js';
import type { RateState } from './soundboardRate.js';
import type { WebRTCMesh } from './webrtcMesh.js';
import type { VoteResult } from './musicVote.js';
import type { SanitizedMusicMessage } from './musicProtocol.js';
import type { SessionSnapshot } from './musicSession.js';
import type { MusicMessage } from './musicProtocol.js';
import type { SourceKind } from './musicSources.js';
import type { Vote, VoteChoice } from './musicVote.js';
import type { YouTubeAttempts } from './youtubePlayer.js';
import type { Delivery, MusicSession, Playback, QueueEntry } from './musicSession.js';
import {
  commandMessage,
  playbackMessage,
  queueAddMessage,
  queueRemoveMessage,
  sanitizeMusicMessage,
  voteCastMessage,
  voteOpenMessage,
  soundboardPlayMessage,
  voteResultMessage,
} from './musicProtocol.js';
import {
  addEntry,
  applyDuration,
  applyPlayback,
  buildSnapshot,
  bumpLamport,
  countByPeer,
  createSession,
  entryById,
  estimatePosition,
  hasSameSource,
  MAX_PER_PEER,
  MAX_QUEUE,
  mergeSnapshot,
  observeLamport,
  orderedQueue,
  ownerFor,
  planAdvance,
  planPositionHeartbeat,
  removeEntriesBy,
  removeEntry,
  sanitizeEntry,
  successorOwner,
} from './musicSession.js';
import {
  parseFileSource,
  parseSource,
  REFUSAL_BY_AVAILABILITY,
  resolveSourceMeta,
  SOURCE_ERRORS,
} from './musicSources.js';
import {
  canPropose,
  castVote,
  chooseVote,
  createVote,
  finalizeVote,
  isConclusive,
  isExpired,
  remainingMs,
  VOTE_DURATION_MS,
} from './musicVote.js';
import {
  fetchYouTubeOEmbed,
  isYouTubeEnabled,
  planYouTubeError,
  YouTubeTrackPlayer,
} from './youtubePlayer.js';

/** O dono republica a posição a cada 5s (e em toda mudança). */
const POSITION_PUBLISH_MS = 5_000;
/** Desvio tolerado no modo `local` antes de corrigir. */
const SYNC_THRESHOLD_SEC = 1.5;
/**
 * Intervalo mínimo entre correções. Seek causa buffering, buffering causa
 * deriva, deriva causa seek: sem essa trava o player entra num loop de correção
 * que é audível como gagueira a cada poucos segundos.
 */
const SYNC_MIN_INTERVAL_MS = 5_000;
/** Quanto tempo o card fica na tela mostrando o resultado antes de sumir. */
const RESULT_LINGER_MS = 3_000;
/**
 * Espera antes de recarregar o player que acabou de errar. Recarregar de forma
 * síncrona sobre o iframe que morreu há um instante é a tentativa com a menor
 * chance de dar certo — é a espera curta que dá valor à retentativa.
 */
const RETRY_DELAY_MS = 700;

/**
 * Cauda da janela de mute do ouvinte, somada ao `durationMs` anunciado. Cobre a
 * diferença de latência entre o anúncio (SCTP) e o áudio (SRTP pelo TURN): sem
 * ela, o fim do efeito vazaria por algumas dezenas de ms.
 */
const MUTE_GUARD_MS = 1_500;

/**
 * Quanto tempo o canal de música fica atado depois do último efeito, com o
 * painel já fechado. Reativar um sender custa alguns quadros, e um efeito de
 * 1,2s perde o ataque se a ativação acontecer no mesmo instante do clique.
 */
const SOUNDBOARD_TAIL_MS = 5_000;

/** Quantos disparos recentes a lista de atividade do painel guarda. */
const ACTIVITY_LIMIT = 8;

function newId() {
  return globalThis.crypto?.randomUUID?.() || `m-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * A superfície de tocador que o hook usa, comum ao `MusicEngine` (arquivo/URL)
 * e ao `YouTubeTrackPlayer`. `loading` é opcional porque só o segundo o tem — e
 * o código sempre dependeu disso: `player.loading` num `MusicEngine` é
 * `undefined`, que é falso, que é a resposta certa.
 */
interface TrackPlayer {
  loading?: boolean;
  buffering: boolean;
  positionSec: number;
  playing: boolean;
  seek(positionSec: number): void;
  pause(): void;
  play(): Promise<boolean>;
  stop(): void;
}

/** Um par transmitindo música, do ponto de vista do `<audio>` oculto. */
export interface MusicStream {
  peerId: string;
  stream: MediaStream;
}

/**
 * O que está carregado no tocador agora.
 *
 * `signature` é `${entryId}:${role}:${owner}` — é ela que faz a reconciliação
 * ser idempotente: a mesma faixa, no mesmo papel, com o mesmo dono, não é
 * recarregada.
 */
interface LoadedTrack {
  signature: string;
  entryId: string;
  kind: SourceKind;
  /** `'stream'` quando este cliente produz o áudio para o mesh. */
  role: Delivery;
}

/** Um disparo recebido (ou feito), para a lista de atividade do painel. */
export interface SoundboardActivity {
  id: string;
  peerId: string;
  title: string;
  at: number;
}

/** O que o disparo devolve ao painel: sucesso, ou uma razão com mensagem. */
export interface SoundboardFireResult {
  ok: boolean;
  reason?: string;
}

export interface UseMusicRoomOptions {
  meshRef: { current: WebRTCMesh | null };
  participants: Map<string, unknown>;
  getSelfId?: () => string;
  displayName: string;
  pushToast: (kind: string, text: string) => void;
  /**
   * "Devo silenciar o soundboard deste peer?" — a escolha do **ouvinte**,
   * decidida fora daqui (mute global do storage + lista em memória do `Room`).
   * Vem como função, e não como lista, porque ela muda a cada render e o que o
   * hook precisa é consultá-la no instante em que o anúncio chega.
   *
   * A resposta **nunca** trafega: ela não vira mensagem, não vira estado
   * publicado e não altera o volume nem o mic de ninguém.
   */
  isSoundboardMuted?: (peerId: string) => boolean;
}

export function useMusicRoom({
  meshRef,
  participants,
  getSelfId,
  displayName,
  pushToast,
  isSoundboardMuted,
}: UseMusicRoomOptions) {
  const [session, setSession] = useState(createSession);
  const [vote, setVote] = useState<Vote | null>(null);
  const [myVote, setMyVote] = useState<VoteChoice | null>(null);
  const [volume, setVolumeState] = useState(0.8);
  const [musicStreams, setMusicStreams] = useState<MusicStream[]>([]);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [youtubeWarned, setYoutubeWarned] = useState(false);
  const [nowPlayingTick, setNowPlayingTick] = useState(0);
  // ---- soundboard (ver a seção homônima adiante)
  const [soundboardActivity, setSoundboardActivity] = useState<SoundboardActivity[]>([]);
  /** Peers com janela de mute aberta agora — é o que o `RemoteMusicAudio` lê. */
  const [soundboardSilenced, setSoundboardSilenced] = useState<string[]>([]);
  /** Peers que estouraram o limite de entrada: a UI oferece silenciá-los. */
  const [soundboardFlooding, setSoundboardFlooding] = useState<string[]>([]);
  const [soundboardCooldownMs, setSoundboardCooldownMs] = useState(0);

  const sessionRef = useRef(session);
  const voteRef = useRef<Vote | null>(null);
  /** Votação dispensada, guardada para validar o anúncio. */
  const dismissedVoteRef = useRef<Vote | null>(null);
  const myVoteRef = useRef<VoteChoice | null>(null);
  const volumeRef = useRef(volume);
  const engineRef = useRef<MusicEngine | null>(null);
  const youtubeRef = useRef<YouTubeTrackPlayer | null>(null);
  /** `<div>` onde o iframe é montado. */
  const youtubeHostRef = useRef<HTMLDivElement | null>(null);
  /** `entryId` → `File` (só os meus). */
  const localFilesRef = useRef(new Map<string, File>());
  const loadedRef = useRef<LoadedTrack | null>(null);
  const loadTokenRef = useRef(0);
  const lastSyncAtRef = useRef(0);
  /** `entryId` → entrega decidida pela sonda de CORS. */
  const deliveryHintRef = useRef(new Map<string, Delivery>());
  /** `proposerId` → `performance.now()` da última reprovação. */
  const lastRejectedRef = useRef(new Map<string, number>());
  const arbiterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voteCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const publishTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  /**
   * Tentativas de recuperação da faixa corrente. É **um** contador, não um mapa:
   * só existe uma faixa tocando, então "trocar de faixa zera" sai de graça da
   * comparação de `entryId` — sem varredura nem política de expiração para um
   * dado que só interessa agora.
   */
  const errorAttemptsRef = useRef<YouTubeAttempts>({ entryId: null, count: 0 });
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Erro sendo tratado ou retentativa em curso. Enquanto isto for verdadeiro o
   * dono **não publica**: um player que acabou de errar devolve posição
   * congelada e `playing: false`, e publicar isso pausaria a sala inteira por
   * causa de um soluço local.
   */
  const recoveringRef = useRef(false);
  const presentIdsRef = useRef<string[]>([]);
  const knownPeersRef = useRef(new Set<string>());
  const displayNameRef = useRef(displayName);
  const soundboardRef = useRef<SoundboardPlayer | null>(null);
  const isSoundboardMutedRef = useRef<((peerId: string) => boolean) | undefined>(undefined);
  /** Limitador de saída (o meu botão) e o de entrada, um balde por peer. */
  const outboundRateRef = useRef<RateState>(createRateState());
  const inboundRateRef = useRef(new Map<string, RateState>());
  const muteTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const soundboardHoldRef = useRef(false);
  const soundboardPanelOpenRef = useRef(false);
  const soundboardTailRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Este cliente está produzindo o áudio da faixa corrente para o mesh? */
  const streamingMusicRef = useRef(false);

  displayNameRef.current = displayName;
  isSoundboardMutedRef.current = isSoundboardMuted;
  volumeRef.current = volume;

  const selfId = getSelfId?.() || '';
  const selfIdRef = useRef(selfId);
  selfIdRef.current = selfId;

  const presentIds = useMemo(
    () => [selfId, ...participants.keys()].filter(Boolean).sort(),
    [selfId, participants],
  );
  presentIdsRef.current = presentIds;

  // --------------------------------------------------------------- utilidades

  /** Único ponto de escrita do estado: o ref é a verdade, o state é a vitrine. */
  const updateSession = useCallback((fn: (prev: MusicSession) => MusicSession | null) => {
    const next = fn(sessionRef.current);
    if (!next || next === sessionRef.current) return sessionRef.current;
    sessionRef.current = next;
    setSession(next);
    return next;
  }, []);

  const send = useCallback(
    (payload: MusicMessage) => {
      meshRef.current?.sendMusicMessage(payload);
    },
    [meshRef],
  );

  const showNotice = useCallback((text: string | null) => {
    setNotice(text);
  }, []);

  /**
   * Como esta faixa será entregue. O padrão para qualquer coisa que não seja
   * arquivo local é `local`, e o `stream` só entra quando a sonda de CORS disse
   * que dá: o caminho `stream` sobre mídia que não libera captura não falha — ele
   * transmite **silêncio**, sem erro nenhum. Errar para o lado de "cada um toca a
   * sua cópia" custa banda; errar para o outro lado custa a funcionalidade.
   */
  const deliveryFor = useCallback((entry: QueueEntry | null | undefined): Delivery => {
    if (!entry) return 'stream';
    if (entry.kind === 'file') return 'stream';
    return deliveryHintRef.current.get(entry.id) === 'stream' ? 'stream' : 'local';
  }, []);

  // -------------------------------------------------------------- reprodução

  /** O tocador ativo da faixa corrente: engine (arquivo/URL) ou YouTube. */
  const activePlayer = useCallback((): TrackPlayer | null => {
    const loaded = loadedRef.current;
    if (!loaded) return null;
    return loaded.kind === 'youtube' ? youtubeRef.current : engineRef.current;
  }, []);

  /**
   * Posição para publicar/anunciar. **Um player carregando responde `0`, não
   * `undefined`** — então `player?.positionSec ?? playback.positionSec` não
   * protege de nada aqui, e publicar esse `0` como estado autoritativo faz a
   * sala inteira saltar para o começo da faixa.
   */
  const currentPositionSec = useCallback((): number => {
    const { playback } = sessionRef.current;
    const player = activePlayer();
    if (!player || player.loading) return playback.positionSec;
    return player.positionSec;
  }, [activePlayer]);

  const publishPlayback = useCallback(
    (patch: Partial<Playback>) => {
      const current = sessionRef.current.playback;
      const playback = {
        ...current,
        ...patch,
        version: current.version + 1,
        ownerId: selfIdRef.current,
        receivedAt: performance.now(),
      };
      updateSession((prev) => ({ ...prev, playback }));
      send(playbackMessage(playback));
      return playback;
    },
    [send, updateSession],
  );

  /** Sou eu quem publica o estado desta faixa? */
  const isOwner = useCallback(() => {
    const { playback } = sessionRef.current;
    return !!playback.entryId && playback.ownerId === selfIdRef.current;
  }, []);

  /**
   * Avança para a faixa seguinte. Quem **decide** é `planAdvance`, puro; o que
   * sobra aqui é agir: tirar a faixa da fila, avisar a sala e publicar o estado
   * novo se o plano disser que a vez é minha.
   *
   * Os quatro motivos (`skipped`, `ended`, `error`, `owner-left`) passam por esta
   * mesma função e produzem o mesmo estado — o motivo só viaja para
   * `endedReason`. É o que faz "pulei" e "acabou sozinha" terminarem iguais.
   */
  const advanceFrom = useCallback(
    (finishedEntryId: string | null, reason: string | null) => {
      const plan = planAdvance({
        session: sessionRef.current,
        finishedEntryId,
        reason,
        presentIds: presentIdsRef.current,
        selfId: selfIdRef.current,
        // Injetado: a entrega sai da sonda de CORS, que é rede — e rede não
        // entra no módulo puro.
        delivery: deliveryFor,
      });

      // A faixa que acabou sai da fila (o player é uma fila, não uma playlist).
      const removido = plan.removedEntryId;
      if (removido) {
        updateSession((prev) => removeEntry(prev, removido));
      }
      if (plan.broadcastRemove && removido) {
        send(queueRemoveMessage({ entryId: removido, byName: displayNameRef.current }));
      }
      // Fila vazia: o plano não declara entrega, e o `publishPlayback` preserva a
      // do estado corrente — como era antes da extração.
      if (plan.publish) publishPlayback(plan.publish);
    },
    [deliveryFor, publishPlayback, send, updateSession],
  );

  const handleEnded = useCallback(
    (entryId: string) => {
      if (sessionRef.current.playback.entryId !== entryId) return;
      // Só o dono decide a transição; os demais apenas verão o novo estado.
      if (isOwner()) advanceFrom(entryId, 'ended');
    },
    [advanceFrom, isOwner],
  );

  const handleDuration = useCallback(
    (entryId: string, durationSec: number) => {
      updateSession((prev) => applyDuration(prev, entryId, durationSec));
    },
    [updateSession],
  );

  /** A faixa corrente, se o evento que chegou for mesmo dela. */
  const currentIfVideo = useCallback((videoId: unknown): QueueEntry | null => {
    const current = entryById(sessionRef.current, sessionRef.current.playback.entryId);
    if (!current || current.kind !== 'youtube') return null;
    return current.sourceRef === videoId ? current : null;
  }, []);

  /**
   * Uma única recarga do player, **local a este participante**, na posição em que
   * a sala está agora. Nada disto trafega: quem errou foi o iframe daqui.
   *
   * Carrega direto no envelope de propósito. O caminho "óbvio" — zerar
   * `loadedRef` e deixar a reconciliação recarregar — tem um laço escondido: o
   * dono republica posição a cada 5s, cada republicação incrementa
   * `playback.version`, e `version` está nas dependências do efeito de
   * reconciliação. Com `loadedRef` nulo, todo heartbeat viraria uma recarga
   * nova. A faixa carregada continua a mesma, então `loadedRef` continua
   * verdadeiro e não se mexe nele.
   */
  const retryCurrentYouTube = useCallback((entryId: string) => {
    // `?? undefined` só para o compilador: `clearTimeout(null)` é no-op válido.
    clearTimeout(retryTimerRef.current ?? undefined);
    // A janela de silêncio começa **aqui**, não no disparo: o intervalo entre o
    // erro e a recarga é justamente o que `player.loading` não cobre.
    recoveringRef.current = true;
    retryTimerRef.current = setTimeout(async () => {
      retryTimerRef.current = null;
      try {
        const { playback } = sessionRef.current;
        const entry = entryById(sessionRef.current, entryId);
        const player = youtubeRef.current;
        // A faixa trocou enquanto esperávamos: carregar aqui tocaria o vídeo
        // velho por cima do novo — bug intermitente do mesmo gênero que a
        // `generation` do envelope existe para conter.
        if (!player || !entry || entry.kind !== 'youtube' || playback.entryId !== entryId) return;

        const token = (loadTokenRef.current += 1);
        const startSeconds = estimatePosition(playback, performance.now());
        const loaded = await player.load(entry.sourceRef, { startSeconds, autoplay: playback.playing });
        // Uma reconciliação mais nova assumiu no meio do carregamento: quem manda
        // é ela, inclusive sobre o `loadedRef`.
        if (token !== loadTokenRef.current) return;
        if (sessionRef.current.playback.entryId !== entryId) return;
        // O envelope recusou: deixar `loadedRef` afirmando que a faixa está no ar
        // impediria qualquer tentativa futura.
        if (!loaded) loadedRef.current = null;
      } finally {
        recoveringRef.current = false;
      }
    }, RETRY_DELAY_MS);
  }, []);

  /**
   * Erro de tocador. O evento é **um objeto** — e a razão é a causa raiz desta
   * correção: o envelope emitia `('youtube-error', 150)` num handler cujo
   * segundo parâmetro se chamava `entryId`, o `150` reprovava na guarda de
   * string, caía no fallback, e o código do erro nunca era lido. Todo erro do
   * YouTube virava o mesmo aviso genérico e tirava a faixa da fila da sala.
   *
   * Quem decide é `planYouTubeError`, puro; aqui só se age. E pular continua
   * sendo prerrogativa do dono: a retentativa é de cada peer, a fila é da sala.
   */
  const handlePlayerError = useCallback(
    (event: unknown) => {
      const payload: { reason?: unknown; videoId?: unknown; code?: unknown; entryId?: unknown } =
        event && typeof event === 'object' ? event : {};

      if (payload.reason === 'youtube-error') {
        // O erro é do vídeo que **este** iframe estava tocando, que não é
        // necessariamente a faixa corrente. Agir sobre a corrente por causa do
        // erro de outra é a outra metade da causa raiz.
        const entry = currentIfVideo(payload.videoId);
        const plan = planYouTubeError({
          code: payload.code,
          entryId: entry?.id || null,
          title: entry?.title || null,
          isOwner: isOwner(),
          attempts: errorAttemptsRef.current,
        });
        // Não é enfeite: é o instrumento que confirma ou derruba a hipótese do
        // `origin`/153 quando o sintoma reaparecer.
        console.warn('[music] erro do player YouTube:', {
          videoId: payload.videoId,
          entryId: entry?.id || null,
          code: plan.code,
          kind: plan.kind,
          action: plan.action,
        });
        errorAttemptsRef.current = plan.attempts;
        if (!entry) return; // evento de uma faixa que já não é a corrente: só o log

        showNotice(plan.notice);
        if (plan.action === 'retry') retryCurrentYouTube(entry.id);
        else if (plan.action === 'skip') advanceFrom(entry.id, 'error');
        return;
      }

      // Arquivo e URL não têm código transitório conhecido: recarregar o mesmo
      // arquivo ou a mesma URL é gastar segundos de silêncio sem chance real.
      const id = typeof payload.entryId === 'string' ? payload.entryId : null;
      const entry = entryById(sessionRef.current, id);
      showNotice(`Não consegui tocar “${entry?.title || 'a faixa'}”.`);
      if (id && isOwner()) advanceFrom(id, 'error');
    },
    [advanceFrom, currentIfVideo, isOwner, retryCurrentYouTube, showNotice],
  );

  const ensureEngine = useCallback(() => {
    if (!engineRef.current) {
      engineRef.current = new MusicEngine({
        getContext: getAudioContext,
        onEnded: handleEnded,
        onDurationKnown: handleDuration,
        onError: handlePlayerError,
        onBlocked: () => setAudioBlocked(true),
      });
    }
    return engineRef.current;
  }, [handleDuration, handleEnded, handlePlayerError]);

  /**
   * Ata o track do canal de música ao mesh — **uma vez**, e sempre o mesmo
   * objeto: o `MediaStreamDestination` do `MusicEngine` é criado uma vez e vive
   * enquanto o motor vive. A guarda contra `localMusicTrack` já ser este track
   * é o que faz um disparo de soundboard não custar `replaceTrack` nenhum
   * quando a música já está no ar.
   */
  const attachMusicTrack = useCallback(
    async (track: MediaStreamTrack | null) => {
      const mesh = meshRef.current;
      if (!mesh || !track) return;
      if (mesh.localMusicTrack === track) return;
      await mesh.setMusicTrack(track);
    },
    [meshRef],
  );

  /**
   * Devolve o canal ao silêncio — **a menos que o soundboard esteja com ele**.
   *
   * Era daqui que vinha o bug mais provável desta entrega: os cinco ramos de
   * reconciliação que "desligam o canal" desligariam também o soundboard, no
   * meio de um efeito, sem erro nenhum. Manter `setMusicTrack(null)` cru
   * nesses ramos "por segurança" é exatamente o anti-pattern.
   */
  const detachMusicTrack = useCallback(async () => {
    streamingMusicRef.current = false;
    if (soundboardHoldRef.current) return;
    await meshRef.current?.setMusicTrack(null);
  }, [meshRef]);

  const ensureYouTube = useCallback(() => {
    if (!youtubeRef.current && youtubeHostRef.current) {
      // O host é do React; **tudo dentro dele é do envelope**, que monta um nó
      // novo por faixa e o derruba junto com o iframe. `YT.Player` substitui o
      // elemento que recebe, então um container fixo criado aqui não
      // sobreviveria à segunda faixa — e um nó trocado por baixo do React
      // estoura na hora de desmontar.
      youtubeRef.current = new YouTubeTrackPlayer({
        host: youtubeHostRef.current,
        // O envelope diz de qual vídeo veio o evento; a conferência contra a
        // faixa corrente é a segunda trava contra o `ENDED` de um iframe que já
        // foi derrubado avançar a faixa **nova**.
        onEnded: (videoId) => {
          const entry = currentIfVideo(videoId);
          if (entry) handleEnded(entry.id);
        },
        onError: handlePlayerError,
        onDurationKnown: (videoId, duration) => {
          const entry = currentIfVideo(videoId);
          if (entry) handleDuration(entry.id, duration);
        },
        onTitle: () => setNowPlayingTick((tick) => tick + 1),
      });
    }
    return youtubeRef.current;
  }, [currentIfVideo, handleDuration, handleEnded, handlePlayerError]);

  /**
   * Reconcilia o que está tocando de verdade com o que o estado diz. Roda em
   * todos os clients: o que muda entre eles é **o papel** — quem é dono de faixa
   * em modo `stream` produz o áudio para o mesh; quem não é, só escuta o canal.
   */
  const reconcilePlayback = useCallback(async () => {
    const { playback } = sessionRef.current;
    const entry = entryById(sessionRef.current, playback.entryId);
    const me = selfIdRef.current;
    const token = (loadTokenRef.current += 1);

    if (!entry) {
      loadedRef.current = null;
      engineRef.current?.stop();
      youtubeRef.current?.stop();
      await detachMusicTrack();
      return;
    }

    const owner = playback.ownerId === me;
    // Em `stream` o áudio nasce numa máquina só; em `local` cada um toca a sua
    // cópia (YouTube sempre, URL sem CORS também).
    const role = entry.kind === 'youtube' || playback.delivery === 'local' ? 'local' : 'stream';
    if (role === 'stream' && !owner) {
      // A música chega pelo canal do dono; nada para tocar aqui.
      loadedRef.current = null;
      engineRef.current?.stop();
      youtubeRef.current?.stop();
      await detachMusicTrack();
      return;
    }

    const signature = `${entry.id}:${role}:${owner}`;
    if (loadedRef.current?.signature === signature) return;

    if (entry.kind === 'youtube') {
      engineRef.current?.stop();
      await detachMusicTrack();
      const player = ensureYouTube();
      if (!player) return;
      loadedRef.current = { signature, entryId: entry.id, kind: 'youtube', role };
      player.setVolume(volumeRef.current);
      const startSeconds = estimatePosition(playback, performance.now());
      const loaded = await player.load(entry.sourceRef, { startSeconds, autoplay: playback.playing });
      // Outra faixa entrou no meio do carregamento (o ramo de arquivo/URL já
      // fazia esta conferência): quem manda é a reconciliação mais nova, e ela
      // já cuidou do `loadedRef`.
      if (token !== loadTokenRef.current) return;
      // O envelope recusou carregar — deixar `loadedRef` afirmando que esta
      // faixa está no ar impediria qualquer nova tentativa.
      if (!loaded) loadedRef.current = null;
      return;
    }

    youtubeRef.current?.stop();
    const engine = ensureEngine();
    const file = localFilesRef.current.get(entry.id) || null;
    if (entry.kind === 'file' && !file) {
      // Arquivo de outra pessoa: só há como ouvir pelo canal dela.
      loadedRef.current = null;
      return;
    }

    loadedRef.current = { signature, entryId: entry.id, kind: entry.kind, role };
    engine.setMonitorVolume(volumeRef.current);
    await engine.load(entry, { file, delivery: role === 'stream' ? 'stream' : 'local', asOwner: role === 'stream' });
    if (token !== loadTokenRef.current) return; // outra faixa entrou no meio

    if (role === 'stream' && owner) {
      streamingMusicRef.current = true;
      await attachMusicTrack(engine.track);
    } else {
      await detachMusicTrack();
    }

    const position = owner ? playback.positionSec : estimatePosition(playback, performance.now());
    if (position > 0.5) engine.seek(position);
    if (playback.playing) {
      const ok = await engine.play();
      if (!ok) setAudioBlocked(true);
    }
  }, [attachMusicTrack, detachMusicTrack, ensureEngine, ensureYouTube]);

  // Reconcilia sempre que a **decisão** muda — não a cada tique de posição.
  useEffect(() => {
    reconcilePlayback().catch((err) => console.error('[music] reconcile falhou:', err));
  }, [
    reconcilePlayback,
    session.playback.entryId,
    session.playback.ownerId,
    session.playback.delivery,
    session.playback.version,
  ]);

  // Play/pause seguem o estado publicado, sem recarregar a faixa.
  useEffect(() => {
    const player = activePlayer();
    if (!player || !loadedRef.current) return;
    if (session.playback.playing) {
      Promise.resolve(player.play()).then((ok) => {
        if (ok === false) setAudioBlocked(true);
      });
    } else {
      player.pause();
    }
  }, [activePlayer, session.playback.playing, session.playback.version]);

  // O dono republica a posição a cada 5s: é o que permite a quem está em modo
  // `local` corrigir a deriva, e a quem entra depois cair no meio da faixa.
  //
  // Trocando de faixa: o player ainda não sabe nada de si. Publicar ali seria
  // anunciar `{ positionSec: 0, playing: false }` **para a sala inteira** — o
  // estado é autoritativo, e todos obedeceriam a um "pausado" que só existe
  // porque o iframe ainda está subindo.
  //
  // A outra metade do mesmo raciocínio: o `playing` republicado é a **intenção**
  // corrente da sala, nunca o **transporte** do player. `player.playing` é falso
  // durante buffering (estado 3 do YouTube), com autoplay bloqueado e entre
  // `onReady` e o primeiro frame — e um tique caído em qualquer um desses
  // instantes pausava a sala de verdade, sem que ninguém desfizesse depois. Esta
  // política mora inteira em `planPositionHeartbeat`, e é lá que se testa: não
  // recrie nenhuma condição aqui, nem traga `player.playing` de volta.
   useEffect(() => {
    clearInterval(publishTimerRef.current ?? undefined);
    if (!session.playback.playing || session.playback.ownerId !== selfId) return undefined;
    publishTimerRef.current = setInterval(() => {
      // `sessionRef`, não a closure: o efeito não é recriado a cada mudança de
      // posição, então o `playback` da closure envelhece.
      const plan = planPositionHeartbeat({
        playback: sessionRef.current.playback,
        player: activePlayer(),
        recovering: recoveringRef.current,
      });
      if (plan.publish) publishPlayback(plan.publish);
    }, POSITION_PUBLISH_MS);
    return () => clearInterval(publishTimerRef.current ?? undefined);
  }, [activePlayer, publishPlayback, selfId, session.playback.playing, session.playback.ownerId]);

  // Correção de deriva no modo `local`, com limiar e intervalo mínimo.
  useEffect(() => {
    const { playback } = session;
    if (playback.ownerId === selfId || !playback.playing) return undefined;
    if (loadedRef.current?.role !== 'local') return undefined;

    const timer = setInterval(() => {
      const player = activePlayer();
      // Carregando ou em buffering, a posição não é dele ainda: corrigir contra
      // ela só aumentaria a deriva.
      if (!player || player.buffering || player.loading) return;
      const now = performance.now();
      if (now - lastSyncAtRef.current < SYNC_MIN_INTERVAL_MS) return;
      const expected = estimatePosition(sessionRef.current.playback, now);
      if (Math.abs(expected - player.positionSec) <= SYNC_THRESHOLD_SEC) return;
      lastSyncAtRef.current = now;
      player.seek(expected);
    }, 1_000);
    return () => clearInterval(timer);
  }, [activePlayer, selfId, session]);

  // Nada está tocando e a fila tem faixa: o dono da primeira começa. Todos
  // avaliam a mesma condição sobre o mesmo estado; só um satisfaz.
  //
  // A condição é "a faixa corrente não existe mais na fila" — e não "entryId é
  // nulo": quando alguém pula a faixa que estava tocando, o `entryId` continua
  // apontando para uma entrada que já virou tombstone, e é justamente aí que a
  // próxima precisa começar.
  useEffect(() => {
    if (!session.enabled) return;
    if (entryById(session, session.playback.entryId)) return;
    const first = orderedQueue(session)[0];
    if (!first) return;
    if (ownerFor(first, presentIds) !== selfId) return;
    publishPlayback({
      entryId: first.id,
      playing: true,
      positionSec: 0,
      delivery: deliveryFor(first),
      endedReason: null,
    });
  }, [deliveryFor, presentIds, publishPlayback, selfId, session]);

  // Uma retentativa agendada na faixa A não pode disparar depois de a faixa B
  // entrar — o disparo reconfere, e este cancelamento evita até a espera inútil.
  // A limpeza também roda no desmonte.
  useEffect(
    () => () => {
      clearTimeout(retryTimerRef.current ?? undefined);
      retryTimerRef.current = null;
      recoveringRef.current = false;
    },
    [session.playback.entryId],
  );

  // Volume é local e nunca trafega.
  useEffect(() => {
    engineRef.current?.setMonitorVolume(volume);
    youtubeRef.current?.setVolume(volume);
    soundboardRef.current?.setMonitorVolume(volume);
  }, [volume]);

  // -------------------------------------------------------------- soundboard

  const ensureSoundboard = useCallback(() => {
    if (!soundboardRef.current) {
      soundboardRef.current = new SoundboardPlayer({
        // O efeito é mixado no **mesmo** `MediaStreamDestination` do canal de
        // música — sem transceiver novo, sem `replaceTrack` por disparo e sem
        // renegociação de SDP. O tocador não é dono desse nó (ver `ensureOutput`).
        getOutput: () => ensureEngine().ensureOutput(),
      });
      soundboardRef.current.setMonitorVolume(volumeRef.current);
    }
    return soundboardRef.current;
  }, [ensureEngine]);

  /**
   * Quem está com o canal de música: o player, o soundboard, ou ninguém.
   *
   * Com o painel aberto o canal fica atado (quem vai disparar abriu o painel), e
   * depois do último efeito ele fica mais `SOUNDBOARD_TAIL_MS` — reativar um
   * sender custa alguns quadros, e um efeito de 1,2s perderia o ataque se a
   * ativação acontecesse no mesmo instante do clique.
   */
  const scheduleChannelRelease = useCallback(() => {
    clearTimeout(soundboardTailRef.current ?? undefined);
    soundboardTailRef.current = null;
    if (soundboardPanelOpenRef.current) return;
    // Nunca segurou o canal: não há o que devolver, e agendar um
    // `setMusicTrack(null)` daqui poderia disputar com a reconciliação.
    if (!soundboardHoldRef.current) return;
    soundboardTailRef.current = setTimeout(() => {
      soundboardTailRef.current = null;
      soundboardHoldRef.current = false;
      // Só devolve o canal se o player não estiver transmitindo: soltar o track
      // debaixo de uma faixa em curso silenciaria a sala sem erro nenhum.
      if (!streamingMusicRef.current) void meshRef.current?.setMusicTrack(null);
    }, SOUNDBOARD_TAIL_MS);
  }, [meshRef]);

  /** Ata o canal para o soundboard. Idempotente e sem custo quando já está lá. */
  const acquireSoundboardChannel = useCallback(async () => {
    const engine = ensureEngine();
    const output = engine.ensureOutput();
    if (!output) return false;
    soundboardHoldRef.current = true;
    clearTimeout(soundboardTailRef.current ?? undefined);
    soundboardTailRef.current = null;
    await attachMusicTrack(engine.track);
    return true;
  }, [attachMusicTrack, ensureEngine]);

  /** O painel abriu ou fechou. Nada disso trafega — é decisão desta aba. */
  const setSoundboardPanelOpen = useCallback(
    (open: boolean) => {
      soundboardPanelOpenRef.current = !!open;
      if (open) void acquireSoundboardChannel();
      else scheduleChannelRelease();
    },
    [acquireSoundboardChannel, scheduleChannelRelease],
  );

  const pushActivity = useCallback((item: SoundboardActivity) => {
    setSoundboardActivity((prev) => [item, ...prev].slice(0, ACTIVITY_LIMIT));
  }, []);

  /**
   * A janela de mute do ouvinte.
   *
   * No fio, efeito e música do player são **o mesmo sinal** — os dois vêm
   * mixados no canal daquele peer, e nenhum receptor consegue separá-los. O
   * único ponto de controle possível é temporal: emudecer o `<audio>` **daquele
   * peer** enquanto o efeito dura. A consequência tem que estar na cara do
   * usuário: se o peer silenciado estiver, no mesmo instante, transmitindo uma
   * faixa do player, a faixa dele também emudece durante a janela (tipicamente
   * 1–3s, no máximo ~16s). O rótulo do controle diz isso.
   */
  const openMuteWindow = useCallback((peerId: string, durationMs: number) => {
    setSoundboardSilenced((prev) => (prev.includes(peerId) ? prev : [...prev, peerId]));
    const anterior = muteTimersRef.current.get(peerId);
    if (anterior) clearTimeout(anterior);
    const timer = setTimeout(
      () => {
        muteTimersRef.current.delete(peerId);
        setSoundboardSilenced((prev) => prev.filter((id) => id !== peerId));
      },
      Math.max(0, Math.min(MAX_SOUND_MS, durationMs)) + MUTE_GUARD_MS,
    );
    muteTimersRef.current.set(peerId, timer);
  }, []);

  /**
   * Dispara um efeito: sonda, decodifica, **anuncia** e toca — nesta ordem.
   *
   * O anúncio vai antes do `start`, no mesmo tique, porque ele viaja por SCTP e
   * o áudio por SRTP/TURN: anunciar depois faria o mute de quem silenciou perder
   * a corrida em boa parte dos disparos. O silenciamento continua sendo
   * best-effort nas bordas, e um vazamento de dezenas de ms é aceitável — muito
   * mais que um atraso artificial no disparo, que custaria responsividade a todo
   * mundo.
   */
  const fireSoundboard = useCallback(
    async (favorite: Favorite): Promise<SoundboardFireResult> => {
      const now = performance.now();
      const decision = consume(outboundRateRef.current, now);
      if (!decision.allowed) {
        setSoundboardCooldownMs(decision.retryInMs);
        return { ok: false, reason: 'rate-limited' };
      }
      // A vaga é consumida **antes** do `await`: três cliques em sequência
      // rápida passariam todos por uma checagem feita depois do download.
      outboundRateRef.current = decision.state;
      setSoundboardCooldownMs(decision.retryInMs);

      const player = ensureSoundboard();
      let buffer: AudioBuffer;
      try {
        buffer = await player.load(favorite.sourceRef);
      } catch (err) {
        return { ok: false, reason: err instanceof SoundboardError ? err.reason : 'fetch-failed' };
      }

      // O canal precisa estar atado **antes** do som existir.
      if (!(await acquireSoundboardChannel())) return { ok: false, reason: 'no-audio-context' };

      const durationMs = player.durationMsOf(buffer);
      send(soundboardPlayMessage({ soundId: favorite.id, title: favorite.title, durationMs }));
      try {
        player.start(buffer);
      } catch {
        return { ok: false, reason: 'no-audio-context' };
      }
      pushActivity({
        id: newId(),
        peerId: selfIdRef.current,
        title: favorite.title,
        at: Date.now(),
      });
      scheduleChannelRelease();
      return { ok: true };
    },
    [acquireSoundboardChannel, ensureSoundboard, pushActivity, scheduleChannelRelease, send],
  );

  /** Enquanto houver cooldown, o botão mostra quanto falta. */
  const soundboardCooling = soundboardCooldownMs > 0;
  useEffect(() => {
    if (!soundboardCooling) return undefined;
    const timer = setInterval(() => {
      setSoundboardCooldownMs(retryInMs(outboundRateRef.current, performance.now()));
    }, 250);
    return () => clearInterval(timer);
  }, [soundboardCooling]);

  useEffect(
    () => () => {
      for (const timer of muteTimersRef.current.values()) clearTimeout(timer);
      muteTimersRef.current.clear();
      clearTimeout(soundboardTailRef.current ?? undefined);
      soundboardRef.current?.destroy();
      soundboardRef.current = null;
    },
    [],
  );

  // ------------------------------------------------------------------ votação

  const closeVoteLater = useCallback(() => {
    clearTimeout(voteCloseTimerRef.current ?? undefined);
    voteCloseTimerRef.current = setTimeout(() => {
      voteRef.current = null;
      myVoteRef.current = null;
      setVote(null);
      setMyVote(null);
    }, RESULT_LINGER_MS);
  }, []);

  const applyVoteResult = useCallback(
    (result: VoteResult) => {
      // Vale também para a votação que este participante dispensou: abster-se é
      // não votar, não é ficar de fora do que a sala decidiu.
      const active = voteRef.current?.voteId === result.voteId ? voteRef.current : null;
      const known =
        active || (dismissedVoteRef.current?.voteId === result.voteId ? dismissedVoteRef.current : null);
      if (!known) return;

      if (result.approved) {
        updateSession((prev) => ({ ...prev, enabled: true }));
        pushToast?.('join', 'Player de música liberado pela sala');
      } else {
        lastRejectedRef.current.set(known.proposerId, performance.now());
      }
      dismissedVoteRef.current = null;
      // Dispensou: o efeito vale, mas o card não volta à tela sem ser chamado.
      if (!active) return;

      const decided = { ...active, result };
      voteRef.current = decided;
      setVote(decided);
      closeVoteLater();
    },
    [closeVoteLater, pushToast, updateSession],
  );

  /** Só o árbitro (o proponente) apura e anuncia. */
  const finishArbitration = useCallback(() => {
    const current = voteRef.current;
    clearTimeout(arbiterTimerRef.current ?? undefined);
    if (!current || current.proposerId !== selfIdRef.current || current.result) return;
    const result = finalizeVote(current);
    send(voteResultMessage(result));
    applyVoteResult(result);
  }, [applyVoteResult, send]);

  const adoptVote = useCallback(
    (candidate: Vote | null) => {
      const chosen = chooseVote(voteRef.current?.result ? null : voteRef.current, candidate);
      if (!chosen) return;
      if (voteRef.current && chosen.voteId !== voteRef.current.voteId) {
        // Duas propostas no mesmo instante viram uma só, a mesma em todos: a
        // perdedora é cancelada localmente pela mesma regra em cada cliente.
        clearTimeout(arbiterTimerRef.current ?? undefined);
      }
      voteRef.current = chosen;
      setVote(chosen);
      if (chosen.proposerId === selfIdRef.current && !chosen.result) {
        clearTimeout(arbiterTimerRef.current ?? undefined);
        arbiterTimerRef.current = setTimeout(finishArbitration, remainingMs(chosen, performance.now()) + 50);
      }
    },
    [finishArbitration],
  );

  const registerVote = useCallback(
    (voterId: string, choice: VoteChoice) => {
      const current = voteRef.current;
      if (!current || current.result) return;
      const updated = castVote(current, voterId, choice);
      if (!updated || updated === current) return;
      voteRef.current = updated;
      setVote(updated);
      // O árbitro fecha assim que o resultado deixa de poder mudar.
      if (updated.proposerId === selfIdRef.current && isConclusive(updated)) finishArbitration();
    },
    [finishArbitration],
  );

  const proposeEnable = useCallback(() => {
    if (sessionRef.current.enabled || voteRef.current) return;
    const me = selfIdRef.current;
    const now = performance.now();
    if (!canPropose(lastRejectedRef.current.get(me), now)) {
      showNotice('A sala acabou de recusar. Tente de novo daqui a pouco.');
      return;
    }

    // Sozinho na sala não há o que votar — e sem esta regra um usuário sozinho
    // nunca conseguiria ligar o player.
    if (presentIdsRef.current.length <= 1) {
      updateSession((prev) => ({ ...prev, enabled: true }));
      return;
    }

    const { session: bumped, lamport } = bumpLamport(sessionRef.current);
    updateSession(() => bumped);

    const created = createVote({
      voteId: newId(),
      kind: 'enable',
      lamport,
      proposerId: me,
      proposerName: displayNameRef.current,
      electorate: presentIdsRef.current,
      durationMs: VOTE_DURATION_MS,
      openedAt: now,
    });
    send(
      voteOpenMessage({
        voteId: created.voteId,
        kind: created.kind,
        lamport,
        proposerName: created.proposerName,
        electorate: created.electorate,
        durationMs: created.durationMs,
      }),
    );
    adoptVote(created);
    // O "sim" de quem propõe conta e vai junto: propor é votar a favor.
    registerVote(me, 'yes');
    myVoteRef.current = 'yes';
    setMyVote('yes');
    send(voteCastMessage({ voteId: created.voteId, vote: 'yes' }));
  }, [adoptVote, registerVote, send, showNotice, updateSession]);

  const castMyVote = useCallback(
    (choice: VoteChoice) => {
      const current = voteRef.current;
      if (!current || current.result) return;
      myVoteRef.current = choice;
      setMyVote(choice);
      registerVote(selfIdRef.current, choice);
      send(voteCastMessage({ voteId: current.voteId, vote: choice }));
    },
    [registerVote, send],
  );

  const dismissVote = useCallback(() => {
    // Fechar o card é abster-se, não votar: o prazo resolve.
    //
    // A votação continua guardada, e isso importa: quem dispensa o card **não
    // sai da decisão da sala**. Sem esta memória, o anúncio do árbitro chegaria
    // sem votação correspondente, seria descartado, e a pessoa ficaria sem o
    // player que todos os outros acabaram de ligar.
    dismissedVoteRef.current = voteRef.current;
    voteRef.current = null;
    myVoteRef.current = null;
    setVote(null);
    setMyVote(null);
  }, []);

  // Prazo do lado de quem não é árbitro: o card some sozinho se o anúncio não
  // chegar (árbitro caiu no meio, por exemplo).
  useEffect(() => {
    if (!vote || vote.result) return undefined;
    const timer = setInterval(() => {
      const current = voteRef.current;
      if (!current || current.result) return;
      if (!isExpired(current, performance.now())) return;
      if (current.proposerId === selfIdRef.current) return; // o árbitro tem seu próprio timer
      clearInterval(timer);
      voteRef.current = null;
      setVote(null);
    }, 500);
    return () => clearInterval(timer);
  }, [vote]);

  // ---------------------------------------------------------------- fila

  const addToQueue = useCallback(
    // `input` é `null` quando a faixa vem de um arquivo escolhido no disco —
    // é o `MusicPanel` quem chama assim, e `parseFileSource` é quem decide.
    async (input: string | null, file: File | null = null) => {
      const me = selfIdRef.current;
      const parsed = file ? parseFileSource(file) : parseSource(input, { allowYouTube: isYouTubeEnabled() });
      if (!parsed.ok) {
        showNotice(SOURCE_ERRORS[parsed.reason] || 'Não consegui adicionar essa faixa.');
        return false;
      }
      if (hasSameSource(sessionRef.current, parsed.kind, parsed.sourceRef)) {
        showNotice(SOURCE_ERRORS.duplicate);
        return false;
      }
      if (countByPeer(sessionRef.current, me) >= MAX_PER_PEER) {
        showNotice(SOURCE_ERRORS['peer-limit']);
        return false;
      }
      if (orderedQueue(sessionRef.current).length >= MAX_QUEUE) {
        showNotice(SOURCE_ERRORS['queue-full']);
        return false;
      }

      // URL pode não deixar capturar o áudio; descobrir agora evita descobrir
      // depois, na forma de silêncio para a sala inteira. A sonda é rede, então
      // **nada de estado é lido antes dela**: uma faixa que outro participante
      // adicionasse durante a sonda desapareceria da fila deste cliente se ele
      // publicasse um estado calculado antes de ela chegar.
      //
      // O oEmbed é a **segunda** chamada de rede deste caminho e vale a mesma
      // regra: ela vai junto da sonda, e tudo que lê `sessionRef.current` para
      // compor o que será publicado fica depois das duas esperas. A recusa por
      // disponibilidade, logo abaixo, também mora depois delas — e não lê estado
      // nenhum de propósito: ela decide com `parsed` e o veredito, e nada mais.
      // Só os dois campos que a sonda de CORS olha; não é uma entrada de fila.
      const probeTarget = { kind: parsed.kind, sourceRef: parsed.sourceRef };
      const [delivery, meta]: [Delivery, Awaited<ReturnType<typeof resolveSourceMeta>>] = await Promise.all([
        parsed.kind === 'url' ? ensureEngine().probeDelivery(probeTarget) : Promise.resolve<Delivery>('stream'),
        // Só quem enfileira fala com a Google: o título viaja replicado no
        // `music-queue-add`, e os outros participantes não fazem requisição
        // nenhuma para exibir o nome do vídeo — nem para saber se ele toca.
        resolveSourceMeta(parsed, { fetchMeta: (videoId) => fetchYouTubeOEmbed(videoId) }),
      ]);

      // O oEmbed já disse, nesta mesma resposta, que o vídeo não vai tocar:
      // recusar agora é a única hora em que a pessoa ainda está olhando para o
      // link que colou. Sem isso, a sala só descobre quando a faixa chega a
      // tocar, e quem colou já saiu da tela de adicionar.
      //
      // **Só prova recusa.** Rede caída, timeout, 429 e oEmbed fora do ar viram
      // `unknown`, e `unknown` enfileira como sempre enfileirou — um oEmbed
      // indisponível não pode virar "ninguém na sala consegue adicionar música".
      // O aviso em tempo de execução (`handlePlayerError`) continua obrigatório:
      // ele cobre o vídeo que fica privado depois de entrar na fila, a entrada
      // replicada de outro peer, que este cliente nunca sondou, e o `unknown`
      // que passou por aqui.
      //
      // Nada foi criado até este ponto — sem `newId()`, sem `localFilesRef`, sem
      // `lamport` consumido —, então a recusa não deixa lixo para trás. Mover a
      // criação da entrada para antes daqui "para reaproveitar o título" acaba
      // com essa propriedade.
      const refusal = REFUSAL_BY_AVAILABILITY[meta.availability];
      if (refusal) {
        showNotice(SOURCE_ERRORS[refusal]);
        return false;
      }

      const { session: bumped, lamport } = bumpLamport(sessionRef.current);
      const entry = sanitizeEntry(
        {
          id: newId(),
          kind: parsed.kind,
          title: meta.title,
          sourceRef: parsed.sourceRef,
          addedByName: displayNameRef.current,
          lamport,
        },
        { addedBy: me },
      );
      if (!entry) {
        showNotice('Não consegui adicionar essa faixa.');
        return false;
      }
      if (file) localFilesRef.current.set(entry.id, file);

      const result = addEntry(bumped, entry);
      updateSession(() => result.session);
      if (!result.ok) {
        localFilesRef.current.delete(entry.id);
        showNotice((result.reason && SOURCE_ERRORS[result.reason]) || 'Não consegui adicionar essa faixa.');
        return false;
      }
      send(queueAddMessage(entry));

      if (entry.kind === 'youtube' && !youtubeWarned) {
        setYoutubeWarned(true);
        showNotice(
          'Faixas do YouTube são carregadas pelo player da Google no navegador de cada participante.',
        );
      } else if (entry.kind === 'url' && delivery === 'local') {
        showNotice('Essa URL não libera captura de áudio: cada participante vai tocá-la direto da origem.');
      } else if (parsed.warning === 'unknown-extension') {
        showNotice('Não parece um arquivo de áudio — se não tocar, é por isso.');
      }
      // Guarda a decisão para quando esta faixa virar a corrente.
      deliveryHintRef.current.set(entry.id, delivery);
      return true;
    },
    [ensureEngine, send, showNotice, updateSession, youtubeWarned],
  );

  const removeFromQueue = useCallback(
    (entryId: string) => {
      const entry = entryById(sessionRef.current, entryId);
      if (!entry) return;
      const wasCurrent = sessionRef.current.playback.entryId === entryId;

      if (wasCurrent) {
        // Pular é remover a faixa corrente. Qualquer um pode — a autoria fica
        // visível na sala, que é controle social suficiente entre até 6 pessoas
        // que já se aprovaram mutuamente para entrar.
        const owner = sessionRef.current.playback.ownerId;
        if (owner === selfIdRef.current) {
          advanceFrom(entryId, 'skipped');
        } else {
          updateSession((prev) => removeEntry(prev, entryId));
          send(queueRemoveMessage({ entryId, byName: displayNameRef.current }));
        }
      } else {
        updateSession((prev) => removeEntry(prev, entryId));
        send(queueRemoveMessage({ entryId, byName: displayNameRef.current }));
      }
      localFilesRef.current.delete(entryId);
      deliveryHintRef.current.delete(entryId);
    },
    [advanceFrom, send, updateSession],
  );

  // --------------------------------------------------------------- comandos

  /** Pausar/retomar/seek: aplico se sou o dono, peço se não sou. */
  const requestPause = useCallback(() => {
    const { playback } = sessionRef.current;
    if (!playback.entryId) return;
    if (isOwner()) {
      // O `player.pause()` sai do efeito que segue o estado publicado, e o
      // envelope guarda a intenção mesmo carregando: pausar 200ms depois de
      // pular vale quando o player novo ficar pronto.
      publishPlayback({ playing: false, positionSec: currentPositionSec() });
    } else {
      send(commandMessage({ entryId: playback.entryId, action: 'pause' }));
    }
  }, [currentPositionSec, isOwner, publishPlayback, send]);

  const requestResume = useCallback(() => {
    const { playback } = sessionRef.current;
    if (!playback.entryId) return;
    if (isOwner()) {
      publishPlayback({ playing: true, positionSec: currentPositionSec() });
    } else {
      send(commandMessage({ entryId: playback.entryId, action: 'resume' }));
    }
  }, [currentPositionSec, isOwner, publishPlayback, send]);

  const requestSeek = useCallback(
    (positionSec: number) => {
      const { playback } = sessionRef.current;
      if (!playback.entryId) return;
      if (isOwner()) {
        activePlayer()?.seek(positionSec);
        publishPlayback({ positionSec, playing: playback.playing });
      } else {
        send(commandMessage({ entryId: playback.entryId, action: 'seek', positionSec }));
      }
    },
    [activePlayer, isOwner, publishPlayback, send],
  );

  const skipCurrent = useCallback(() => {
    const { playback } = sessionRef.current;
    if (playback.entryId) removeFromQueue(playback.entryId);
  }, [removeFromQueue]);

  const applyCommand = useCallback(
    (message: Extract<SanitizedMusicMessage, { type: 'music-command' }>) => {
      if (!isOwner()) return; // pedido dirigido a outro dono: ignorar em silêncio
      const { playback } = sessionRef.current;
      if (message.entryId && message.entryId !== playback.entryId) return;
      const player = activePlayer();
      switch (message.action) {
        case 'pause':
          publishPlayback({ playing: false, positionSec: currentPositionSec() });
          break;
        case 'resume':
          publishPlayback({ playing: true, positionSec: currentPositionSec() });
          break;
        case 'seek': {
          const posicao = message.positionSec;
          if (posicao !== null && Number.isFinite(posicao)) {
            player?.seek(posicao);
            publishPlayback({ positionSec: posicao, playing: playback.playing });
          }
          break;
        }
        default:
          break;
      }
    },
    [activePlayer, currentPositionSec, isOwner, publishPlayback],
  );

  // -------------------------------------------------- recepção do data channel

  const handleMusicMessage = useCallback(
    (peerId: string, raw: unknown) => {
      const message = sanitizeMusicMessage(raw, { fromPeerId: peerId });
      if (!message) return; // malformado: descartado sem tocar no estado

      switch (message.type) {
        case 'music-vote-open': {
          if (sessionRef.current.enabled) return;
          const now = performance.now();
          if (!canPropose(lastRejectedRef.current.get(message.proposerId), now)) return;
          updateSession((prev) => observeLamport(prev, message.lamport));
          adoptVote(
            createVote({
              voteId: message.voteId,
              kind: message.kind,
              lamport: message.lamport,
              proposerId: message.proposerId,
              proposerName: message.proposerName,
              electorate: message.electorate,
              durationMs: message.durationMs,
              openedAt: now,
              target: message.target,
            }),
          );
          // O "sim" de quem propôs vem no `music-vote-cast` dele, como o de todos.
          break;
        }

        case 'music-vote-cast':
          if (voteRef.current?.voteId !== message.voteId) return;
          registerVote(message.voterId, message.vote);
          break;

        case 'music-vote-result': {
          // Só o árbitro anuncia: um "resultado" de terceiro não vale nada, e é
          // por isso que o anúncio é conferido contra a votação que este cliente
          // conhece — inclusive uma que ele tenha dispensado da tela.
          const known =
            voteRef.current?.voteId === message.voteId
              ? voteRef.current
              : dismissedVoteRef.current?.voteId === message.voteId
                ? dismissedVoteRef.current
                : null;
          if (known?.proposerId !== message.arbiterId) return;
          applyVoteResult(message);
          break;
        }

        case 'music-queue-add': {
          updateSession((prev) => {
            const observed = observeLamport(prev, message.entry.lamport);
            return addEntry(observed, message.entry).session;
          });
          break;
        }

        case 'music-queue-remove': {
          const wasCurrent = sessionRef.current.playback.entryId === message.entryId;
          const entry = entryById(sessionRef.current, message.entryId);
          updateSession((prev) => removeEntry(prev, message.entryId));
          localFilesRef.current.delete(message.entryId);
          if (wasCurrent && entry) {
            showNotice(`“${entry.title}” foi pulada por ${message.byName}.`);
            if (sessionRef.current.playback.ownerId === selfIdRef.current) {
              advanceFrom(message.entryId, 'skipped');
            }
          }
          break;
        }

        case 'music-playback':
          updateSession((prev) => applyPlayback(prev, message.playback, performance.now()));
          break;

        case 'music-command':
          applyCommand(message);
          break;

        case 'music-snapshot':
          updateSession((prev) => mergeSnapshot(prev, message.snapshot, performance.now()));
          break;

        case 'soundboard-play': {
          // O limitador de entrada descarta **anúncios**, não som: o áudio já
          // vem mixado no canal daquele peer. O que ele protege é a lista de
          // atividade, o agendamento das janelas de mute e a CPU. Contra abuso
          // de áudio, a defesa é o mute daquele participante — por isso quem
          // estoura o limite aparece em `flooding`, e a UI oferece o botão.
          const agora = performance.now();
          const decisao = consume(inboundRateRef.current.get(message.peerId), agora);
          inboundRateRef.current.set(message.peerId, decisao.state);
          if (!decisao.allowed) {
            setSoundboardFlooding((prev) =>
              prev.includes(message.peerId) ? prev : [...prev, message.peerId],
            );
            return;
          }
          pushActivity({ id: newId(), peerId: message.peerId, title: message.title, at: Date.now() });
          // A escolha do ouvinte é consultada aqui e só aqui: ela não vira
          // mensagem, não é publicada e não sai desta aba.
          if (isSoundboardMutedRef.current?.(message.peerId)) {
            openMuteWindow(message.peerId, message.durationMs);
          }
          break;
        }

        default:
          break;
      }
    },
    [
      adoptVote,
      advanceFrom,
      applyCommand,
      applyVoteResult,
      openMuteWindow,
      pushActivity,
      registerVote,
      showNotice,
      updateSession,
    ],
  );

  const handleRemoteMusic = useCallback((peerId: string, stream: MediaStream) => {
    setMusicStreams((prev) =>
      prev.some((item) => item.peerId === peerId) ? prev : [...prev, { peerId, stream }],
    );
  }, []);

  /**
   * Snapshot para quem acabou de conectar. A posição vai **estimada para agora**:
   * mandar o último valor publicado faria quem entra começar alguns segundos
   * atrás do resto da sala.
   */
  const getMusicSnapshot = useCallback(() => {
    const current = sessionRef.current;
    const snapshot = buildSnapshot(current);
    if (snapshot.playback.entryId) {
      const player = current.playback.ownerId === selfIdRef.current ? activePlayer() : null;
      // Player carregando responde `0`: quem entrasse na sala durante uma troca
      // de faixa começaria do início dela.
      snapshot.playback.positionSec =
        player && !player.loading ? player.positionSec : estimatePosition(current.playback, performance.now());
    }
    return snapshot;
  }, [activePlayer]);

  // Handlers estáveis para o mesh, que é construído uma única vez.
  const handlersRef = useRef<{
    handleMusicMessage: (peerId: string, raw: unknown) => void;
    handleRemoteMusic: (peerId: string, stream: MediaStream) => void;
    getMusicSnapshot: () => SessionSnapshot;
  } | null>(null);
  handlersRef.current = { handleMusicMessage, handleRemoteMusic, getMusicSnapshot };
  const meshCallbacks = useMemo(
    () => ({
      onMusicMessage: (peerId: string, payload: unknown) =>
        handlersRef.current?.handleMusicMessage(peerId, payload),
      onRemoteMusic: (peerId: string, stream: MediaStream) =>
        handlersRef.current?.handleRemoteMusic(peerId, stream),
      getMusicSnapshot: () => handlersRef.current?.getMusicSnapshot() ?? null,
    }),
    [],
  );

  // ------------------------------------------------------- entradas e saídas

  useEffect(() => {
    const known = knownPeersRef.current;
    const current = new Set(participants.keys());
    const gone = [...known].filter((peerId) => !current.has(peerId));
    knownPeersRef.current = current;
    if (gone.length === 0) return;

    setMusicStreams((prev) => prev.filter((item) => !gone.includes(item.peerId)));
    // O `peerId` é o socket id daquela sessão: quem saiu não volta com o mesmo.
    // Guardar balde, janela de mute ou aviso de excesso dele é guardar lixo.
    setSoundboardSilenced((prev) => prev.filter((id) => !gone.includes(id)));
    setSoundboardFlooding((prev) => prev.filter((id) => !gone.includes(id)));
    for (const peerId of gone) {
      inboundRateRef.current.delete(peerId);
      const timer = muteTimersRef.current.get(peerId);
      if (timer) clearTimeout(timer);
      muteTimersRef.current.delete(peerId);
    }

    for (const peerId of gone) {
      // Votação do proponente que caiu não pode ficar pendurada na tela.
      if (voteRef.current && voteRef.current.proposerId === peerId && !voteRef.current.result) {
        clearTimeout(arbiterTimerRef.current ?? undefined);
        voteRef.current = null;
        setVote(null);
        setMyVote(null);
      }

      // Arquivo local de quem saiu não tem como continuar: ninguém mais o tem.
      // URL e YouTube continuam — qualquer um consegue tocá-los.
      const orphaned = orderedQueue(sessionRef.current).filter(
        (entry) => entry.addedBy === peerId && entry.kind === 'file',
      );
      const wasCurrent = orphaned.some((entry) => entry.id === sessionRef.current.playback.entryId);
      if (orphaned.length > 0) {
        updateSession((prev) => removeEntriesBy(prev, peerId, { kinds: ['file'] }));
      }

      const playback = sessionRef.current.playback;
      if (playback.ownerId !== peerId) continue;

      // O dono caiu: exatamente um participante assume, pela mesma regra em
      // todos os clientes.
      const heir = successorOwner(presentIdsRef.current);
      if (heir !== selfIdRef.current) continue;

      if (wasCurrent || !entryById(sessionRef.current, playback.entryId)) {
        if (wasCurrent) showNotice('A faixa que estava tocando saiu com quem a adicionou.');
        advanceFrom(playback.entryId, 'owner-left');
      } else {
        // Faixa que dá para continuar: assumo o relógio mestre daqui.
        publishPlayback({
          entryId: playback.entryId,
          playing: playback.playing,
          positionSec: estimatePosition(playback, performance.now()),
          delivery: playback.delivery,
        });
      }
    }
  }, [advanceFrom, participants, publishPlayback, showNotice, updateSession]);

  // ----------------------------------------------------------------- limpeza

  useEffect(
    () => () => {
      clearTimeout(arbiterTimerRef.current ?? undefined);
      clearTimeout(voteCloseTimerRef.current ?? undefined);
      clearInterval(publishTimerRef.current ?? undefined);
      clearTimeout(retryTimerRef.current ?? undefined);
      engineRef.current?.destroy();
      engineRef.current = null;
      youtubeRef.current?.destroy();
      youtubeRef.current = null;
      const host = youtubeHostRef.current;
      while (host?.firstChild) host.removeChild(host.firstChild);
      for (const id of localFilesRef.current.keys()) localFilesRef.current.delete(id);
    },
    [],
  );

  // -------------------------------------------------------------- visão da UI

  // Posição para a barra de progresso: do tocador local quando existe, estimada
  // a partir do último anúncio quando o áudio chega pronto pela rede (em modo
  // `stream` a posição é cosmética — não há deriva possível).
  const [position, setPosition] = useState(0);
  useEffect(() => {
    const update = () => {
      const player = activePlayer();
      // Durante a troca de faixa a estimativa é melhor que o `0` do player que
      // ainda está subindo — senão a barra pisca no começo a cada faixa.
      setPosition(
        player && !player.loading
          ? player.positionSec
          : estimatePosition(sessionRef.current.playback, performance.now()),
      );
    };
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [activePlayer, session.playback.entryId, session.playback.playing, session.playback.version]);

  const queue = useMemo(() => orderedQueue(session), [session]);
  const currentEntry = entryById(session, session.playback.entryId);
  const setVolume = useCallback((value: number) => {
    setVolumeState(Math.min(1, Math.max(0, value)));
  }, []);

  const unlockAudio = useCallback(async () => {
    setAudioBlocked(false);
    getAudioContext();
    const player = activePlayer();
    if (player && sessionRef.current.playback.playing) await player.play();
  }, [activePlayer]);

  return {
    session,
    enabled: session.enabled,
    queue,
    currentEntry,
    position,
    playback: session.playback,
    deliveryHint: deliveryHintRef,
    vote,
    myVote,
    volume,
    setVolume,
    musicStreams,
    audioBlocked,
    reportBlocked: () => setAudioBlocked(true),
    unlockAudio,
    notice,
    dismissNotice: () => setNotice(null),
    youtubeEnabled: isYouTubeEnabled(),
    youtubeHostRef,
    meshCallbacks,
    nowPlayingTick,
    isOwner: session.playback.ownerId === selfId && !!session.playback.entryId,
    /**
     * O soundboard, do ponto de vista do `Room`. Note o que **não** está aqui:
     * nenhuma escolha de mute é publicada, e nenhuma URL de efeito trafega.
     */
    soundboard: {
      /** Disparos recentes, com autoria — a lista da direita do painel. */
      activity: soundboardActivity,
      /** Peers com janela de mute aberta: o `RemoteMusicAudio` os emudece. */
      silencedPeerIds: soundboardSilenced,
      /** Peers que estouraram o limite de entrada (a UI oferece silenciá-los). */
      floodingPeerIds: soundboardFlooding,
      /** Quanto falta para o próximo disparo caber, em ms. `0` = pode disparar. */
      cooldownMs: soundboardCooldownMs,
      fire: fireSoundboard,
      setPanelOpen: setSoundboardPanelOpen,
    },
    actions: {
      proposeEnable,
      castMyVote,
      dismissVote,
      addToQueue,
      removeFromQueue,
      requestPause,
      requestResume,
      requestSeek,
      skipCurrent,
    },
  };
}
