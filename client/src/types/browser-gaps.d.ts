/**
 * Lacunas pontuais da `lib.dom` — prefixo de fornecedor e API de terceiro.
 *
 * `setSinkId`/`sinkId` **não** estão aqui de propósito: a `lib.dom` desta versão
 * do TypeScript já os declara em `HTMLMediaElement`, e redeclarar geraria
 * conflito.
 */

/** Não está na lib.dom: prefixo do WebKit, ainda necessário no Safari. */
interface Window {
  webkitAudioContext?: typeof AudioContext;
}

/**
 * A IFrame Player API do YouTube. Não é do browser: é um script de terceiro que
 * se instala em `window.YT`, então nenhuma lib do TypeScript a descreve.
 * Consumida só por `lib/youtubePlayer.ts`, que a carrega sob demanda.
 */
interface YTPlayerEvent {
  target: YTPlayer;
  data: number;
}

interface YTPlayerOptions {
  videoId?: string;
  height?: string | number;
  width?: string | number;
  playerVars?: Record<string, string | number>;
  events?: {
    onReady?: (event: YTPlayerEvent) => void;
    onStateChange?: (event: YTPlayerEvent) => void;
    onError?: (event: YTPlayerEvent) => void;
  };
}

interface YTPlayer {
  loadVideoById(videoId: string, startSeconds?: number): void;
  cueVideoById(videoId: string, startSeconds?: number): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(seconds: number, allowSeekAhead?: boolean): void;
  setVolume(volume: number): void;
  getVolume(): number;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
}

interface YTNamespace {
  Player: new (element: HTMLElement | string, options: YTPlayerOptions) => YTPlayer;
  PlayerState: {
    UNSTARTED: -1;
    ENDED: 0;
    PLAYING: 1;
    PAUSED: 2;
    BUFFERING: 3;
    CUED: 5;
  };
}

/** Não está em nenhuma lib: instalado pelo script da Google em tempo de execução. */
interface Window {
  YT?: YTNamespace;
  onYouTubeIframeAPIReady?: (() => void) | undefined;
}
