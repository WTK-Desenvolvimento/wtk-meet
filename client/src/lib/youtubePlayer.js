/**
 * Origem YouTube — a única parte do player que depende de um terceiro, confinada
 * de propósito num arquivo só, que dá para desligar inteiro por flag
 * (`VITE_ENABLE_YOUTUBE`).
 *
 * **Por que YouTube toca em modo `local` e não retransmitido:** o player roda num
 * iframe cross-origin. Não existe API que dê acesso ao áudio dele — nem
 * `MediaElementSource`, nem captura de elemento, nada. As duas formas de
 * "retransmitir" seriam extrair o stream (viola os Termos de Serviço e exigiria
 * componente de servidor, que o escopo proíbe) ou capturar o áudio da aba, que
 * levaria junto a voz dos outros participantes e criaria realimentação. Então
 * cada client carrega o vídeo e a sincronização é por posição.
 *
 * **Consequência de privacidade, dita com todas as letras:** nesse modo o
 * navegador de *cada* participante fala com a Google, que passa a ver o IP de
 * todo mundo na sala e o que a sala está ouvindo. Isso contradiz a promessa de
 * "nenhuma dependência de terceiros" do `ARCHITECTURE.md` §1 — daí a flag e daí
 * o aviso explícito na UI ao adicionar a primeira faixa de YouTube da sessão.
 * Arquivo local e URL direta entregam o recurso sem nenhum terceiro envolvido.
 */

const API_SRC = 'https://www.youtube.com/iframe_api';

let apiPromise = null;

/** A origem YouTube está ligada nesta instalação? */
export function isYouTubeEnabled() {
  const flag = import.meta.env?.VITE_ENABLE_YOUTUBE;
  return flag === undefined || flag === '' || flag === 'true' || flag === true;
}

/**
 * Carrega a IFrame Player API **sob demanda** — nada de script de terceiro no
 * bundle nem no `index.html`: quem nunca adiciona uma faixa de YouTube nunca
 * fala com a Google.
 */
export function loadYouTubeApi() {
  if (apiPromise) return apiPromise;
  if (typeof window === 'undefined') return Promise.reject(new Error('sem window'));

  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) {
      resolve(window.YT);
      return;
    }
    const timer = setTimeout(() => reject(new Error('IFrame API não carregou')), 15_000);
    // A API chama este hook global quando termina de carregar. Encadeamos com o
    // que já estiver lá para não pisar em outro consumidor.
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      previous?.();
      resolve(window.YT);
    };
    if (!document.querySelector(`script[src="${API_SRC}"]`)) {
      const script = document.createElement('script');
      script.src = API_SRC;
      script.async = true;
      script.onerror = () => {
        clearTimeout(timer);
        reject(new Error('IFrame API bloqueada'));
      };
      document.head.appendChild(script);
    }
  }).catch((err) => {
    apiPromise = null; // deixa uma tentativa futura acontecer
    throw err;
  });

  return apiPromise;
}

/**
 * Envelope fino sobre o player do YouTube, com a mesma superfície do
 * `MusicEngine` (`play`/`pause`/`seek`/`positionSec`), para o `Room` tratar as
 * três origens pelo mesmo caminho.
 */
export class YouTubeTrackPlayer {
  constructor({ container, onEnded, onError, onDurationKnown, onTitle } = {}) {
    this.container = container;
    this.onEnded = onEnded;
    this.onError = onError;
    this.onDurationKnown = onDurationKnown;
    this.onTitle = onTitle;
    this.player = null;
    this.videoId = null;
    this.ready = false;
    this.destroyed = false;
    this.volume = 1;
  }

  async load(videoId, { startSeconds = 0, autoplay = false } = {}) {
    if (this.destroyed || !this.container) return false;
    const YT = await loadYouTubeApi();
    if (this.destroyed) return false;
    this.videoId = videoId;

    if (this.player) {
      this.ready = false;
      this.player.loadVideoById({ videoId, startSeconds });
      if (!autoplay) this.player.pauseVideo();
      return true;
    }

    await new Promise((resolve) => {
      this.player = new YT.Player(this.container, {
        videoId,
        // `playsinline` evita o player em tela cheia no iOS; `rel: 0` corta a
        // enxurrada de sugestões no fim do vídeo.
        playerVars: { playsinline: 1, rel: 0, controls: 0, disablekb: 1, start: Math.floor(startSeconds) },
        events: {
          onReady: () => {
            this.ready = true;
            this.setVolume(this.volume);
            this._announceMetadata();
            if (autoplay) this.player.playVideo();
            else this.player.pauseVideo();
            resolve();
          },
          onStateChange: (event) => {
            if (event.data === YT.PlayerState.ENDED) this.onEnded?.(this.videoId);
            if (event.data === YT.PlayerState.PLAYING) this._announceMetadata();
          },
          // Vídeo removido, privado ou com incorporação bloqueada. Vira "faixa
          // pulada com aviso" — nunca um player travado sem explicação.
          onError: (event) => this.onError?.('youtube-error', event?.data),
        },
      });
    });
    return true;
  }

  _announceMetadata() {
    if (!this.ready || !this.player) return;
    const duration = this.player.getDuration?.();
    if (Number.isFinite(duration) && duration > 0) this.onDurationKnown?.(this.videoId, duration);
    const title = this.player.getVideoData?.()?.title;
    if (title) this.onTitle?.(this.videoId, title);
  }

  play() {
    if (this.ready) this.player?.playVideo?.();
    return Promise.resolve(true);
  }

  pause() {
    if (this.ready) this.player?.pauseVideo?.();
  }

  seek(positionSec) {
    if (this.ready && Number.isFinite(positionSec)) {
      this.player?.seekTo?.(Math.max(0, positionSec), true);
    }
  }

  /** Volume é local, como em todo o resto do player (0–1 aqui, 0–100 no YT). */
  setVolume(value) {
    this.volume = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
    if (this.ready) this.player?.setVolume?.(Math.round(this.volume * 100));
  }

  get positionSec() {
    return (this.ready && this.player?.getCurrentTime?.()) || 0;
  }

  get durationSec() {
    const value = this.ready && this.player?.getDuration?.();
    return Number.isFinite(value) && value > 0 ? value : null;
  }

  get playing() {
    return this.ready && this.player?.getPlayerState?.() === 1;
  }

  get buffering() {
    return this.ready && this.player?.getPlayerState?.() === 3;
  }

  stop() {
    if (this.ready) this.player?.stopVideo?.();
    this.videoId = null;
  }

  destroy() {
    this.destroyed = true;
    this.ready = false;
    try {
      this.player?.destroy?.();
    } catch {
      // iframe já removido
    }
    this.player = null;
  }
}
