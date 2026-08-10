import { useEffect, useRef } from 'react';

/**
 * Um tile da grade. Serve tanto para câmera quanto para compartilhamento de
 * tela, e tanto para o participante local quanto para os remotos.
 *
 * O anel azul de "está falando" é puramente derivado do nível de áudio medido
 * localmente (ver `lib/audioLevels.js`) — nenhum dado de volume chega pela rede.
 */
export default function VideoTile({
  stream,
  label,
  muted = false,
  mirrored = false,
  contain = false,
  speaking = false,
  level = 0,
  cameraOff = false,
  micOff = false,
  badge = null,
}) {
  const videoRef = useRef(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream || null;
    if (!stream) return undefined;

    // Câmera e tela entram/saem do mesmo MediaStream via replaceTrack, e alguns
    // navegadores não repintam o elemento sozinhos quando o conjunto de tracks
    // muda. Reatribuir o srcObject força o refresh.
    const refresh = () => {
      if (videoRef.current) videoRef.current.srcObject = stream;
    };
    stream.addEventListener('addtrack', refresh);
    stream.addEventListener('removetrack', refresh);
    return () => {
      stream.removeEventListener('addtrack', refresh);
      stream.removeEventListener('removetrack', refresh);
    };
  }, [stream]);

  const showVideo = !!stream && !cameraOff;
  const initial = (label || '?').trim().charAt(0).toUpperCase();

  return (
    <div
      className={`video-tile${speaking ? ' speaking' : ''}${contain ? ' contain' : ''}`}
      style={{ '--speak-level': level.toFixed(2) }}
    >
      {/* O <video> nunca é desmontado nem escondido com `display:none`: ele
          continua reproduzindo o áudio do peer mesmo com a câmera desligada.
          O placeholder é uma camada por cima. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={muted}
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
