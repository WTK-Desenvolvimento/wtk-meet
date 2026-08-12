import { useEffect, useRef } from 'react';

/**
 * Sink de áudio dos participantes remotos — invisível, e deliberadamente **fora
 * do palco**.
 *
 * Até aqui quem reproduzia o áudio do peer era o `<video>` do tile, e isso
 * funcionava porque o tile nunca saía do lugar: a grade só mudava de tamanho. O
 * modo destaque quebra essa premissa — entrar e sair do destaque, ou trocar qual
 * tela está em destaque, **move** o tile de um container para outro na árvore
 * React, e mover um elemento entre pais o desmonta e remonta. O remonte corta o
 * áudio por um instante: um bug de som causado por uma mudança de layout.
 *
 * Separar o transporte de áudio do posicionamento do vídeo custa este arquivo e
 * torna qualquer rearranjo futuro de layout gratuito. Os `<video>` dos tiles
 * passam todos a ser `muted`; o som sai daqui, de elementos que são montados uma
 * única vez por participante e nunca mudam de pai.
 *
 * Não confundir com `lib/audioLevels.js`: aquele analisa o stream para o anel de
 * fala e não reproduz nada. Este reproduz e não analisa.
 */
function PeerAudioElement({ stream }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    el.srcObject = stream || null;
    if (!stream) return undefined;

    // Mesma razão do `VideoTile`: tracks entram e saem do stream via
    // `replaceTrack`, e nem todo navegador repinta/reabre o sink sozinho.
    const refresh = () => {
      if (ref.current) ref.current.srcObject = stream;
    };
    stream.addEventListener('addtrack', refresh);
    stream.addEventListener('removetrack', refresh);
    return () => {
      stream.removeEventListener('addtrack', refresh);
      stream.removeEventListener('removetrack', refresh);
    };
  }, [stream]);

  // `playsInline` não existe em `<audio>` (é atributo de vídeo em iOS).
  return <audio ref={ref} autoPlay />;
}

/**
 * @param {object} props
 * @param {Map<string, {stream?: MediaStream}>} props.participants
 */
export default function PeerAudio({ participants }) {
  const entries = [];
  for (const [peerId, info] of participants) {
    if (info?.stream) entries.push([peerId, info.stream]);
  }

  return (
    <div className="peer-audio-sinks" aria-hidden="true">
      {entries.map(([peerId, stream]) => (
        <PeerAudioElement key={peerId} stream={stream} />
      ))}
    </div>
  );
}
