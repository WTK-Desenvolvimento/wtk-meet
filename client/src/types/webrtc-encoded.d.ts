/**
 * WebRTC Encoded Transform (Insertable Streams) — a API do E2EE.
 *
 * A `lib.dom` já traz `RTCEncodedVideoFrame`/`RTCEncodedAudioFrame` e os
 * metadados deles, mas **não** traz o par de métodos que os produz
 * (`createEncodedStreams`) nem a flag de configuração que os habilita: os dois
 * são da especificação original do Chrome, que a proposta padronizada substituiu
 * por `RTCRtpScriptTransform`. O produto usa a versão do Chrome porque é a que
 * existe hoje no navegador alvo, e `lib/e2ee.ts` detecta a presença antes de
 * usar — o `?.` de lá não é decoração.
 *
 * Consumido por `lib/e2ee.ts` e `lib/webrtcMesh.ts`.
 */

/** Não está na lib.dom: é a API original do Chrome, não a padronizada. */
interface RTCRtpSender {
  createEncodedStreams?(): {
    readable: ReadableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>;
    writable: WritableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>;
  };
}

/** Não está na lib.dom: contraparte de recepção do método acima. */
interface RTCRtpReceiver {
  createEncodedStreams?(): {
    readable: ReadableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>;
    writable: WritableStream<RTCEncodedVideoFrame | RTCEncodedAudioFrame>;
  };
}

/** Não está na lib.dom: flag do Chrome que habilita os streams acima na conexão. */
interface RTCConfiguration {
  encodedInsertableStreams?: boolean;
}
