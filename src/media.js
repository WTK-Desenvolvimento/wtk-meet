/**
 * Dono de todas as midias locais.
 *
 * A regra central deste modulo, e o motivo dele existir:
 *
 *   Desligar a camera FECHA o dispositivo (`track.stop()`).
 *   Nunca `track.enabled = false`.
 *
 * `enabled = false` so troca os quadros por preto — o dispositivo continua
 * aberto e o LED do notebook continua aceso. Para o usuario isso e uma promessa
 * quebrada. O custo de fechar de verdade e ~200-800 ms para religar; aceitamos.
 *
 * O microfone e o caso oposto: mutar precisa ser instantaneo (voce corta o
 * proprio espirro), entao ali `enabled = false` e a escolha certa.
 */

export const SUPPORTS_SCREEN_SHARE =
  typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia);

export function createLocalMedia() {
  const listeners = new Set();

  const state = {
    micTrack: null,
    camTrack: null,
    screenTrack: null,
    micOn: true,
    camOn: false,
    /** deviceIds escolhidos, guardados para reabrir exatamente o mesmo hardware */
    videoDeviceId: null,
    audioDeviceId: null,
    /** guarda contra duplo clique durante a transicao assincrona */
    busy: false,
  };

  function notify() {
    for (const fn of listeners) fn(snapshot());
  }

  function snapshot() {
    return {
      micOn: state.micOn && Boolean(state.micTrack),
      camOn: Boolean(state.camTrack),
      sharing: Boolean(state.screenTrack),
      busy: state.busy,
      micTrack: state.micTrack,
      camTrack: state.camTrack,
      screenTrack: state.screenTrack,
    };
  }

  /** Stream so com o audio, usado pelo medidor de nivel. */
  function micStream() {
    return state.micTrack ? new MediaStream([state.micTrack]) : null;
  }

  async function startMic() {
    if (state.micTrack) return state.micTrack;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: state.audioDeviceId ? { exact: state.audioDeviceId } : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    state.micTrack = stream.getAudioTracks()[0];
    state.audioDeviceId = state.micTrack.getSettings().deviceId ?? state.audioDeviceId;
    state.micTrack.enabled = state.micOn;
    notify();
    return state.micTrack;
  }

  function toggleMic() {
    if (!state.micTrack) return snapshot();
    state.micOn = !state.micOn;
    state.micTrack.enabled = state.micOn; // mute instantaneo, de proposito
    notify();
    return snapshot();
  }

  /**
   * Liga a camera. Reabre sempre o mesmo deviceId da ultima vez — sem isso o
   * navegador pode escolher outra camera ao religar.
   */
  async function enableCamera() {
    if (state.busy || state.camTrack) return snapshot();
    state.busy = true;
    notify();
    try {
      // `await` aqui, e nao `return openCamera()`: sem ele o `finally` soltaria
      // a trava assim que a promessa fosse CRIADA, e um clique durante a
      // retentativa abriria uma segunda camera — orfa e com o LED aceso.
      return await openCamera();
    } finally {
      state.busy = false;
      notify();
    }
  }

  /**
   * Abre o dispositivo de fato. A trava `busy` e responsabilidade de quem chama,
   * e vale para a tentativa inicial E para a retentativa.
   * @param {boolean} podeCairParaPadrao permite uma unica retentativa
   */
  async function openCamera(podeCairParaPadrao = true) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: state.videoDeviceId ? { exact: state.videoDeviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      const track = stream.getVideoTracks()[0];
      state.camTrack = track;
      state.videoDeviceId = track.getSettings().deviceId ?? state.videoDeviceId;
      state.camOn = true;
      // Se o dispositivo for arrancado (USB removido), refletir na UI.
      track.addEventListener('ended', () => {
        if (state.camTrack === track) {
          state.camTrack = null;
          state.camOn = false;
          notify();
        }
      });
      return snapshot();
    } catch (err) {
      state.camOn = false;
      // deviceId exato indisponivel (camera trocada de porta): tenta o padrao.
      const sumiu = err.name === 'OverconstrainedError' || err.name === 'NotFoundError';
      if (podeCairParaPadrao && state.videoDeviceId && sumiu) {
        state.videoDeviceId = null;
        return openCamera(false);
      }
      throw err;
    }
  }

  /** Desliga a camera de verdade: o LED do dispositivo apaga. */
  function disableCamera() {
    if (state.busy || !state.camTrack) return snapshot();
    state.busy = true;
    const track = state.camTrack;
    state.camTrack = null;
    state.camOn = false;
    track.stop(); // <- o ponto inteiro deste modulo
    state.busy = false;
    notify();
    return snapshot();
  }

  async function toggleCamera() {
    return state.camTrack ? disableCamera() : enableCamera();
  }

  /**
   * @param {() => void} onNativeStop chamado quando o usuario encerra pelo
   * botao do proprio navegador — o caminho que a maioria das pessoas usa.
   */
  async function startScreen(onNativeStop) {
    if (!SUPPORTS_SCREEN_SHARE) throw new Error('sem-suporte');
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15, max: 30 } },
      audio: true,
    });
    const track = stream.getVideoTracks()[0];
    if ('contentHint' in track) track.contentHint = 'detail'; // nitidez > fluidez
    state.screenTrack = track;
    track.addEventListener('ended', () => {
      if (state.screenTrack === track) {
        state.screenTrack = null;
        notify();
        onNativeStop?.();
      }
    });
    notify();
    return track;
  }

  function stopScreen() {
    if (!state.screenTrack) return snapshot();
    const track = state.screenTrack;
    state.screenTrack = null;
    track.stop();
    notify();
    return snapshot();
  }

  /** Encerra tudo. Chamado ao sair da sala e no unload — track vazado e bug. */
  function stopAll() {
    for (const track of [state.micTrack, state.camTrack, state.screenTrack]) track?.stop();
    state.micTrack = null;
    state.camTrack = null;
    state.screenTrack = null;
    state.camOn = false;
    notify();
  }

  return {
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    snapshot,
    micStream,
    startMic,
    toggleMic,
    enableCamera,
    disableCamera,
    toggleCamera,
    startScreen,
    stopScreen,
    stopAll,
    get raw() {
      return state;
    },
  };
}
