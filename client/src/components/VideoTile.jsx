import { useEffect, useRef } from 'react';

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
 *
 * Por isso **não há `setSinkId` aqui**. Ele existiu, sobre este `<video>` mudo,
 * e era inerte por construção: a chamada tinha sucesso, não produzia som nenhum,
 * e o seletor "Saída de áudio" do modal não fazia efeito sobre a voz de
 * ninguém. Pior, era o único caminho que alimentava o `handleSinkError` do
 * `Room` — uma rejeição vinda de um elemento sem som podia apagar uma
 * preferência que funcionaria perfeitamente no `<audio>`. O roteamento de saída
 * saiu junto com o som, e mora em `lib/audibleMedia.js`.
 *
 * O indicador de conexão (`connection`) é irmão do `.video-label`, e não parte
 * dele, de propósito: vários roteiros do E2E comparam o `textContent` do
 * `.video-label`, e escrever "Sem conexão" ali quebraria checagens que não têm
 * nada a ver com o assunto.
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
  connection = null,
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
      className={
        `video-tile${speaking ? ' speaking' : ''}${contain ? ' contain' : ''}` +
        `${compact ? ' compact' : ''}${connection ? ` conn-${connection.level}` : ''}`
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
      {/* Ausente no caminho feliz: `describeConnection('connected')` devolve
          null, e um indicador aceso o tempo todo vira ruído que ninguém lê. */}
      {connection && (
        <span
          className={`tile-connection ${connection.level}`}
          role="status"
          aria-live={connection.live}
        >
          {connection.label}
        </span>
      )}
    </div>
  );
}
