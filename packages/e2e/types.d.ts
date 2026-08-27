/**
 * O que o E2E instala **dentro da página** e depois lê de fora.
 *
 * `INSTRUMENTATION` (em `harness.ts`) roda como init script em todo contexto e
 * instala estes ganchos: as `RTCPeerConnection` criadas, os contadores de
 * chamada, o registro de tracks vivas, o espelho do transporte do Socket.IO e
 * os dispositivos falsos. É o único jeito de o teste alcançar essas coisas — o
 * mesh não as expõe, e não deveria.
 *
 * Fica num `.d.ts` porque tudo aqui é global do **navegador sob teste**, não
 * deste processo: as funções em `page.evaluate` são serializadas e executadas
 * lá dentro, e é o `tsc` deste pacote que as confere.
 *
 * Nada aqui é opcional: o init script roda antes de qualquer script da app, em
 * todo contexto que o `openParticipant` abre.
 */

/** Um `getUserMedia`, com os deviceId **pedidos** — não os entregues. */
interface WtkGumRequest {
  /** `!!constraints.video`: a pergunta que o LED da webcam responde. */
  videoRequested: boolean;
  video: string | null;
  audio: string | null;
  audioProcessing: { noiseSuppression: boolean } | null;
}

/** Contadores acumulados desde o carregamento da página. */
interface WtkCounters {
  getUserMedia: number;
  getDisplayMedia: number;
  setLocalDescription: number;
  setRemoteDescription: number;
  raf: number;
  oscillators: number;
  /** Somado sobre todas as conexões: prova que nenhuma renegociação foi pedida. */
  negotiationNeeded: number;
  gumRequests: WtkGumRequest[];
}

/** Recorte serializável de uma `MediaStreamTrack` viva (ou já encerrada). */
interface WtkTrackState {
  kind: string;
  label: string;
  readyState: string;
  enabled: boolean;
}

/** Uma chamada de `setSinkId`, com a tag do elemento que a fez. */
interface WtkSinkCall {
  tag: string;
  sinkId: string;
}

/** Uma mensagem que cruzou o transporte do Socket.IO (WebSocket ou polling). */
interface WtkWireEntry {
  dir: 'in' | 'out';
  url: string;
  data: string;
}

/** Um dispositivo do registro simulado (o Chromium só expõe um de verdade). */
interface WtkDeviceInfo {
  deviceId: string;
  kind: string;
  label: string;
  groupId: string;
}

/** Um toast que a sala exibiu, capturado pelo observer que a checagem instala. */
interface WtkToastEntry {
  text: string;
  cls: string;
}

interface Window {
  __wtkPeers: RTCPeerConnection[];
  __wtkPeerCreatedAt: number[];
  __wtkCounters: WtkCounters;
  __wtkTrackStates: () => WtkTrackState[];
  __wtkLiveTracks: Set<MediaStreamTrack>;
  __wtkDisplayTracks: Set<MediaStreamTrack>;
  __wtkAudioContexts: AudioContext[];
  __wtkOrigAudioContext: typeof AudioContext;
  __wtkSinkIds: WtkSinkCall[];
  __wtkWire: WtkWireEntry[];
  __wtkFakeDevices: WtkDeviceInfo[];
  __wtkAddDevice: (info: WtkDeviceInfo) => void;
  __wtkRemoveDevice: (deviceId: string) => void;
  /** Liga o caminho de fallback do worklet num Chromium que suporta a constraint. */
  __wtkForceWorkletNs: boolean;
  /** Reproduz a rejeição de autoplay que o teste, com permissão concedida, nunca veria. */
  __wtkBlockAutoplay: boolean;
  __wtkPlayCalls: number;

  // Instalados por checagens específicas de `run.ts`, não pelo init script.
  __wtkToastLog: WtkToastEntry[];
  __wtkCarolVisto: number;
  __wtkCarolSemPlaceholder: number;
}

interface RTCPeerConnection {
  /**
   * Força uma transição de `connectionState`. Não há outro jeito de exercitar
   * `failed` sem derrubar o TURN — que levaria a conexão inteira junto, quando
   * o que está sob teste é a **leitura** do estado.
   */
  __wtkForceState: (state: RTCPeerConnectionState) => void;
}
