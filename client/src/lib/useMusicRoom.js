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
import {
  commandMessage,
  playbackMessage,
  queueAddMessage,
  queueRemoveMessage,
  sanitizeMusicMessage,
  voteCastMessage,
  voteOpenMessage,
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
  nextEntryAfterKey,
  observeLamport,
  orderedQueue,
  removeEntriesBy,
  removeEntry,
  sanitizeEntry,
  successorOwner,
} from './musicSession.js';
import { parseFileSource, parseSource, SOURCE_ERRORS } from './musicSources.js';
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
import { isYouTubeEnabled, YouTubeTrackPlayer } from './youtubePlayer.js';

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

function newId() {
  return globalThis.crypto?.randomUUID?.() || `m-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

/**
 * Quem responde pela faixa: quem a adicionou, se ainda estiver na sala; senão o
 * presente de menor id. Determinístico e calculado por todos ao mesmo tempo, que
 * é o que faz exatamente um cliente agir — "quem descobrir primeiro assume" faria
 * dois assumirem, dois publicarem, e o estado oscilar.
 */
function ownerFor(entry, presentIds) {
  if (!entry) return null;
  if (presentIds.includes(entry.addedBy)) return entry.addedBy;
  return successorOwner(presentIds);
}

export function useMusicRoom({ meshRef, participants, getSelfId, displayName, pushToast }) {
  const [session, setSession] = useState(createSession);
  const [vote, setVote] = useState(null);
  const [myVote, setMyVote] = useState(null);
  const [volume, setVolumeState] = useState(0.8);
  const [musicStreams, setMusicStreams] = useState([]); // [{ peerId, stream }]
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [notice, setNotice] = useState(null);
  const [youtubeWarned, setYoutubeWarned] = useState(false);
  const [nowPlayingTick, setNowPlayingTick] = useState(0);

  const sessionRef = useRef(session);
  const voteRef = useRef(null);
  const myVoteRef = useRef(null);
  const volumeRef = useRef(volume);
  const engineRef = useRef(null);
  const youtubeRef = useRef(null);
  const youtubeHostRef = useRef(null);   // <div> onde o iframe é montado
  const localFilesRef = useRef(new Map()); // entryId -> File (só os meus)
  const loadedRef = useRef(null);          // { entryId, delivery, role }
  const loadTokenRef = useRef(0);
  const lastSyncAtRef = useRef(0);
  const deliveryHintRef = useRef(new Map()); // entryId -> 'stream' | 'local' (sonda de CORS)
  const lastRejectedRef = useRef(new Map()); // proposerId -> performance.now()
  const arbiterTimerRef = useRef(null);
  const voteCloseTimerRef = useRef(null);
  const publishTimerRef = useRef(null);
  const presentIdsRef = useRef([]);
  const knownPeersRef = useRef(new Set());
  const displayNameRef = useRef(displayName);

  displayNameRef.current = displayName;
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
  const updateSession = useCallback((fn) => {
    const next = fn(sessionRef.current);
    if (!next || next === sessionRef.current) return sessionRef.current;
    sessionRef.current = next;
    setSession(next);
    return next;
  }, []);

  const send = useCallback(
    (payload) => {
      meshRef.current?.sendMusicMessage(payload);
    },
    [meshRef],
  );

  const showNotice = useCallback((text) => {
    setNotice(text);
  }, []);

  /**
   * Como esta faixa será entregue. O padrão para qualquer coisa que não seja
   * arquivo local é `local`, e o `stream` só entra quando a sonda de CORS disse
   * que dá: o caminho `stream` sobre mídia que não libera captura não falha — ele
   * transmite **silêncio**, sem erro nenhum. Errar para o lado de "cada um toca a
   * sua cópia" custa banda; errar para o outro lado custa a funcionalidade.
   */
  const deliveryFor = useCallback((entry) => {
    if (!entry) return 'stream';
    if (entry.kind === 'file') return 'stream';
    return deliveryHintRef.current.get(entry.id) === 'stream' ? 'stream' : 'local';
  }, []);

  // -------------------------------------------------------------- reprodução

  /** O tocador ativo da faixa corrente: engine (arquivo/URL) ou YouTube. */
  const activePlayer = useCallback(() => {
    const loaded = loadedRef.current;
    if (!loaded) return null;
    return loaded.kind === 'youtube' ? youtubeRef.current : engineRef.current;
  }, []);

  const publishPlayback = useCallback(
    (patch) => {
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
   * Avança para a faixa seguinte. Quem publica é o dono da **próxima** — se a
   * fila acabou, quem publica o "nada tocando" é o dono da que terminou. Um
   * escritor por transição, sempre.
   */
  const advanceFrom = useCallback(
    (finishedEntryId, reason) => {
      const before = sessionRef.current;
      const finished = entryById(before, finishedEntryId);
      const key = finished || null;

      // A faixa que acabou sai da fila (o player é uma fila, não uma playlist).
      const after = finishedEntryId
        ? updateSession((prev) => removeEntry(prev, finishedEntryId))
        : before;
      if (finishedEntryId && finished) {
        send(queueRemoveMessage({ entryId: finishedEntryId, byName: displayNameRef.current }));
      }

      const next = key ? nextEntryAfterKey(after, key) : orderedQueue(after)[0] || null;
      const me = selfIdRef.current;

      if (!next) {
        // Ninguém para assumir: quem estava tocando declara o silêncio.
        if (after.playback.ownerId === me || !after.playback.ownerId) {
          publishPlayback({ entryId: null, playing: false, positionSec: 0, endedReason: reason || null });
        }
        return;
      }

      // Se o dono da próxima for outro, ele publica sozinho: o efeito de
      // "nada tocando e a fila tem faixa" roda em todos e só ele satisfaz.
      if (ownerFor(next, presentIdsRef.current) !== me) return;

      publishPlayback({
        entryId: next.id,
        playing: true,
        positionSec: 0,
        delivery: deliveryFor(next),
        endedReason: reason || null,
      });
    },
    [deliveryFor, publishPlayback, send, updateSession],
  );

  const handleEnded = useCallback(
    (entryId) => {
      if (sessionRef.current.playback.entryId !== entryId) return;
      // Só o dono decide a transição; os demais apenas verão o novo estado.
      if (isOwner()) advanceFrom(entryId, 'ended');
    },
    [advanceFrom, isOwner],
  );

  const handleDuration = useCallback(
    (entryId, durationSec) => {
      updateSession((prev) => applyDuration(prev, entryId, durationSec));
    },
    [updateSession],
  );

  const handlePlayerError = useCallback(
    (code, entryId) => {
      const id = typeof entryId === 'string' ? entryId : sessionRef.current.playback.entryId;
      const entry = entryById(sessionRef.current, id);
      showNotice(
        code === 'youtube-error'
          ? `“${entry?.title || 'A faixa'}” não pode ser tocada aqui (vídeo indisponível ou sem incorporação).`
          : `Não consegui tocar “${entry?.title || 'a faixa'}”.`,
      );
      if (id && isOwner()) advanceFrom(id, 'error');
    },
    [advanceFrom, isOwner, showNotice],
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

  const ensureYouTube = useCallback(() => {
    if (!youtubeRef.current && youtubeHostRef.current) {
      // O container é criado **fora** do React: `YT.Player` substitui o elemento
      // que recebe por um iframe, e um nó trocado por baixo do React estoura na
      // hora de desmontar. O React cuida do host; do filho, cuidamos nós.
      const mount = document.createElement('div');
      youtubeHostRef.current.appendChild(mount);
      youtubeRef.current = new YouTubeTrackPlayer({
        container: mount,
        onEnded: () => handleEnded(sessionRef.current.playback.entryId),
        onError: handlePlayerError,
        onDurationKnown: (_videoId, duration) =>
          handleDuration(sessionRef.current.playback.entryId, duration),
        onTitle: () => setNowPlayingTick((tick) => tick + 1),
      });
    }
    return youtubeRef.current;
  }, [handleDuration, handleEnded, handlePlayerError]);

  /**
   * Reconcilia o que está tocando de verdade com o que o estado diz. Roda em
   * todos os clients: o que muda entre eles é **o papel** — quem é dono de faixa
   * em modo `stream` produz o áudio para o mesh; quem não é, só escuta o canal.
   */
  const reconcilePlayback = useCallback(async () => {
    const { playback } = sessionRef.current;
    const entry = entryById(sessionRef.current, playback.entryId);
    const me = selfIdRef.current;
    const mesh = meshRef.current;
    const token = (loadTokenRef.current += 1);

    if (!entry) {
      loadedRef.current = null;
      engineRef.current?.stop();
      youtubeRef.current?.stop();
      await mesh?.setMusicTrack(null);
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
      await mesh?.setMusicTrack(null);
      return;
    }

    const signature = `${entry.id}:${role}:${owner}`;
    if (loadedRef.current?.signature === signature) return;

    if (entry.kind === 'youtube') {
      engineRef.current?.stop();
      await mesh?.setMusicTrack(null);
      const player = ensureYouTube();
      if (!player) return;
      loadedRef.current = { signature, entryId: entry.id, kind: 'youtube', role };
      player.setVolume(volumeRef.current);
      const startSeconds = estimatePosition(playback, performance.now());
      await player.load(entry.sourceRef, { startSeconds, autoplay: playback.playing });
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
      await mesh?.setMusicTrack(engine.track);
    } else {
      await mesh?.setMusicTrack(null);
    }

    const position = owner ? playback.positionSec : estimatePosition(playback, performance.now());
    if (position > 0.5) engine.seek(position);
    if (playback.playing) {
      const ok = await engine.play();
      if (!ok) setAudioBlocked(true);
    }
  }, [ensureEngine, ensureYouTube, meshRef]);

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
  useEffect(() => {
    clearInterval(publishTimerRef.current);
    if (!session.playback.playing || session.playback.ownerId !== selfId) return undefined;
    publishTimerRef.current = setInterval(() => {
      const player = activePlayer();
      if (!player) return;
      publishPlayback({ positionSec: player.positionSec, playing: player.playing !== false });
    }, POSITION_PUBLISH_MS);
    return () => clearInterval(publishTimerRef.current);
  }, [activePlayer, publishPlayback, selfId, session.playback.playing, session.playback.ownerId]);

  // Correção de deriva no modo `local`, com limiar e intervalo mínimo.
  useEffect(() => {
    const { playback } = session;
    if (playback.ownerId === selfId || !playback.playing) return undefined;
    if (loadedRef.current?.role !== 'local') return undefined;

    const timer = setInterval(() => {
      const player = activePlayer();
      if (!player || player.buffering) return;
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

  // Volume é local e nunca trafega.
  useEffect(() => {
    engineRef.current?.setMonitorVolume(volume);
    youtubeRef.current?.setVolume(volume);
  }, [volume]);

  // ------------------------------------------------------------------ votação

  const closeVoteLater = useCallback(() => {
    clearTimeout(voteCloseTimerRef.current);
    voteCloseTimerRef.current = setTimeout(() => {
      voteRef.current = null;
      myVoteRef.current = null;
      setVote(null);
      setMyVote(null);
    }, RESULT_LINGER_MS);
  }, []);

  const applyVoteResult = useCallback(
    (result) => {
      const current = voteRef.current;
      if (!current || current.voteId !== result.voteId) return;
      if (result.approved) {
        updateSession((prev) => ({ ...prev, enabled: true }));
        pushToast?.('join', 'Player de música liberado pela sala');
      } else {
        lastRejectedRef.current.set(current.proposerId, performance.now());
      }
      const decided = { ...current, result };
      voteRef.current = decided;
      setVote(decided);
      closeVoteLater();
    },
    [closeVoteLater, pushToast, updateSession],
  );

  /** Só o árbitro (o proponente) apura e anuncia. */
  const finishArbitration = useCallback(() => {
    const current = voteRef.current;
    clearTimeout(arbiterTimerRef.current);
    if (!current || current.proposerId !== selfIdRef.current || current.result) return;
    const result = finalizeVote(current);
    send(voteResultMessage(result));
    applyVoteResult(result);
  }, [applyVoteResult, send]);

  const adoptVote = useCallback(
    (candidate) => {
      const chosen = chooseVote(voteRef.current?.result ? null : voteRef.current, candidate);
      if (!chosen) return;
      if (voteRef.current && chosen.voteId !== voteRef.current.voteId) {
        // Duas propostas no mesmo instante viram uma só, a mesma em todos: a
        // perdedora é cancelada localmente pela mesma regra em cada cliente.
        clearTimeout(arbiterTimerRef.current);
      }
      voteRef.current = chosen;
      setVote(chosen);
      if (chosen.proposerId === selfIdRef.current && !chosen.result) {
        clearTimeout(arbiterTimerRef.current);
        arbiterTimerRef.current = setTimeout(finishArbitration, remainingMs(chosen, performance.now()) + 50);
      }
    },
    [finishArbitration],
  );

  const registerVote = useCallback(
    (voterId, choice) => {
      const current = voteRef.current;
      if (!current || current.result) return;
      const updated = castVote(current, voterId, choice);
      if (updated === current) return;
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
    (choice) => {
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
    async (input, file = null) => {
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

      const { session: bumped, lamport } = bumpLamport(sessionRef.current);
      const entry = sanitizeEntry(
        {
          id: newId(),
          kind: parsed.kind,
          title: parsed.title,
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

      // URL pode não deixar capturar o áudio; descobrir agora evita descobrir
      // depois, na forma de silêncio para a sala inteira.
      const delivery = entry.kind === 'url' ? await ensureEngine().probeDelivery(entry) : 'stream';

      const result = addEntry(bumped, entry);
      updateSession(() => result.session);
      if (!result.ok) {
        localFilesRef.current.delete(entry.id);
        showNotice(SOURCE_ERRORS[result.reason] || 'Não consegui adicionar essa faixa.');
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
    (entryId) => {
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
      const player = activePlayer();
      publishPlayback({ playing: false, positionSec: player?.positionSec ?? playback.positionSec });
    } else {
      send(commandMessage({ entryId: playback.entryId, action: 'pause' }));
    }
  }, [activePlayer, isOwner, publishPlayback, send]);

  const requestResume = useCallback(() => {
    const { playback } = sessionRef.current;
    if (!playback.entryId) return;
    if (isOwner()) {
      const player = activePlayer();
      publishPlayback({ playing: true, positionSec: player?.positionSec ?? playback.positionSec });
    } else {
      send(commandMessage({ entryId: playback.entryId, action: 'resume' }));
    }
  }, [activePlayer, isOwner, publishPlayback, send]);

  const requestSeek = useCallback(
    (positionSec) => {
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
    (message) => {
      if (!isOwner()) return; // pedido dirigido a outro dono: ignorar em silêncio
      const { playback } = sessionRef.current;
      if (message.entryId && message.entryId !== playback.entryId) return;
      const player = activePlayer();
      switch (message.action) {
        case 'pause':
          publishPlayback({ playing: false, positionSec: player?.positionSec ?? playback.positionSec });
          break;
        case 'resume':
          publishPlayback({ playing: true, positionSec: player?.positionSec ?? playback.positionSec });
          break;
        case 'seek':
          if (Number.isFinite(message.positionSec)) {
            player?.seek(message.positionSec);
            publishPlayback({ positionSec: message.positionSec, playing: playback.playing });
          }
          break;
        default:
          break;
      }
    },
    [activePlayer, isOwner, publishPlayback],
  );

  // -------------------------------------------------- recepção do data channel

  const handleMusicMessage = useCallback(
    (peerId, raw) => {
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

        case 'music-vote-result':
          // Só o árbitro anuncia: um "resultado" de terceiro não vale nada.
          if (voteRef.current?.proposerId !== message.arbiterId) return;
          applyVoteResult(message);
          break;

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

        default:
          break;
      }
    },
    [adoptVote, advanceFrom, applyCommand, applyVoteResult, registerVote, showNotice, updateSession],
  );

  const handleRemoteMusic = useCallback((peerId, stream) => {
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
      snapshot.playback.positionSec = player
        ? player.positionSec
        : estimatePosition(current.playback, performance.now());
    }
    return snapshot;
  }, [activePlayer]);

  // Handlers estáveis para o mesh, que é construído uma única vez.
  const handlersRef = useRef({});
  handlersRef.current = { handleMusicMessage, handleRemoteMusic, getMusicSnapshot };
  const meshCallbacks = useMemo(
    () => ({
      onMusicMessage: (peerId, payload) => handlersRef.current.handleMusicMessage(peerId, payload),
      onRemoteMusic: (peerId, stream) => handlersRef.current.handleRemoteMusic(peerId, stream),
      getMusicSnapshot: () => handlersRef.current.getMusicSnapshot(),
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

    for (const peerId of gone) {
      // Votação do proponente que caiu não pode ficar pendurada na tela.
      if (voteRef.current && voteRef.current.proposerId === peerId && !voteRef.current.result) {
        clearTimeout(arbiterTimerRef.current);
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
      clearTimeout(arbiterTimerRef.current);
      clearTimeout(voteCloseTimerRef.current);
      clearInterval(publishTimerRef.current);
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
      setPosition(
        player ? player.positionSec : estimatePosition(sessionRef.current.playback, performance.now()),
      );
    };
    update();
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [activePlayer, session.playback.entryId, session.playback.playing, session.playback.version]);

  const queue = useMemo(() => orderedQueue(session), [session]);
  const currentEntry = entryById(session, session.playback.entryId);
  const setVolume = useCallback((value) => {
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
