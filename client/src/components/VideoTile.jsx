import { useEffect, useRef, useState } from 'react';

/**
 * Um tile de vídeo. Serve tanto para câmera quanto para compartilhamento de
 * tela, tanto para o participante local quanto para os remotos, e tanto na
 * grade uniforme quanto no destaque e na coluna de miniaturas (`compact`).
 *
 * O anel azul de "está falando" é puramente derivado do nível de áudio medido
 * localmente (ver `lib/audioLevels.js`) — nenhum dado de volume chega pela rede.
 *
 * O `<video>` é **sempre** `muted`: quem reproduz o áudio dos peers é o sink
 * dedicado de `PeerAudio.jsx`. Um tile muda de container quando o palco entra ou
 * sai do modo destaque, e o remonte do elemento cortaria o som do peer a cada
 * mudança de layout — desacoplar as duas coisas é o que impede esse bug.
 */
export default function VideoTile({
  stream,
  label,
  mirrored = false,
  contain = false,
  compact = false,
  speaking = false,
  level = 0,
  cameraOff = false,
  micOff = false,
  badge = null,
  sinkId = '',
  onSinkError,
}) {
  const videoRef = useRef(null);
  const sinkAppliedRef = useRef(false);
  /**
   * O stream tem track de vídeo **agora**?
   *
   * Um stream só de áudio satisfaz `!!stream`, e sem esta pergunta o `<video>`
   * é montado com nada para decodificar — um retângulo preto no lugar do
   * placeholder. É o piso estrutural do "placeholder desde o primeiro frame":
   * não depende de nenhuma mensagem chegar na ordem certa, porque sem track de
   * vídeo não há o que mostrar, por construção.
   *
   * **Não** derive "câmera desligada" de `track.muted`: um `replaceTrack(null)`
   * do outro lado não remove a track do stream recebido nem dispara `ended` —
   * ela só fica muda, e também fica muda em soluço de rede. Confundir os dois
   * faria a sala inteira piscar placeholder a cada engasgo de banda. Quem
   * responde por "desligou" é a mensagem `state`, e só ela.
   */
  const [hasVideoTrack, setHasVideoTrack] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream || null;
    if (!stream) {
      setHasVideoTrack(false);
      return undefined;
    }

    // Câmera e tela entram/saem do mesmo MediaStream via replaceTrack, e alguns
    // navegadores não repintam o elemento sozinhos quando o conjunto de tracks
    // muda. Reatribuir o srcObject força o refresh. Os mesmos dois listeners
    // mantêm a resposta de `hasVideoTrack` em dia — são exatamente os eventos
    // que a mudam.
    const refresh = () => {
      if (videoRef.current) videoRef.current.srcObject = stream;
      setHasVideoTrack(stream.getVideoTracks().length > 0);
    };
    refresh();
    stream.addEventListener('addtrack', refresh);
    stream.addEventListener('removetrack', refresh);
    return () => {
      stream.removeEventListener('addtrack', refresh);
      stream.removeEventListener('removetrack', refresh);
    };
  }, [stream]);

  /**
   * Roteamento da saída de áudio. É por elemento de mídia — não existe um
   * "device de saída da página" — então cada tile aplica o seu.
   *
   * Toda rejeição é capturada: `setSinkId` rejeita com `NotAllowedError` (sem
   * permissão de microfone) ou `NotFoundError` (id que não existe mais), e uma
   * promise rejeitada dentro de um efeito viraria `unhandledrejection` — erro de
   * console, que a checagem G do E2E trata como falha.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof video.setSinkId !== 'function') return undefined;
    // Nada a fazer enquanto ninguém escolheu saída nenhuma: chamar com '' antes
    // disso só produziria uma chamada inútil por tile a cada montagem.
    if (!sinkId && !sinkAppliedRef.current) return undefined;
    sinkAppliedRef.current = true;
    video.setSinkId(sinkId).catch((err) => {
      onSinkError?.(err);
    });
    return undefined;
  }, [sinkId, onSinkError]);

  const showVideo = !!stream && hasVideoTrack && !cameraOff;
  const initial = (label || '?').trim().charAt(0).toUpperCase();

  return (
    <div
      className={
        `video-tile${speaking ? ' speaking' : ''}${contain ? ' contain' : ''}` +
        `${compact ? ' compact' : ''}`
      }
      style={{ '--speak-level': level.toFixed(2) }}
    >
      {/* O <video> nunca é escondido com `display:none`: o placeholder é uma
          camada por cima, e o elemento continua decodificando o que chega.
          `muted` é fixo — o som dos peers sai por `PeerAudio.jsx`. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className={mirrored ? 'mirrored' : undefined}
      />
      {!showVideo && (
        <div className="video-placeholder">
          <span className="avatar-initial" aria-hidden="true">
            {initial}
          </span>
        </div>
      )}
      <span className="video-label">
        {micOff && (
          <span className="mic-off" title="Microfone desligado" aria-label="Microfone desligado">
            🔇
          </span>
        )}
        {label}
      </span>
      {badge && <span className="tile-badge">{badge}</span>}
    </div>
  );
}
