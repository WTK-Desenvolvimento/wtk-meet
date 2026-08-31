import { useEffect, useRef } from 'react';
import { useAudibleMedia } from '../lib/audibleMedia.js';

import type { AudibleMediaOptions } from '../lib/audibleMedia.js';

import './RemoteMusicAudio.css';

/** A música de um peer: o stream do quarto canal, com dono. */
export interface RemoteMusicStream {
  peerId: string;
  stream?: MediaStream | null;
}

export interface RemoteMusicAudioProps extends Omit<AudibleMediaOptions, 'stream'> {
  streams?: RemoteMusicStream[];
  /** Volume do player da sala, 0–1. */
  volume?: number;
  muted?: boolean;
}

/**
 * Os `<audio>` ocultos que fazem a música do mesh virar som — um por peer,
 * ligados ao `musicStream` daquele peer (o quarto canal de mídia, dedicado a
 * música; ver `lib/webrtcMesh.js`).
 *
 * Três decisões deste componente, todas por causa de bugs que ele evita:
 *
 * 1. **Fica sempre montado**, no wrapper comum de overlays do `Room`, junto de
 *    `<Toasts />` e `<JoinRequestModal />` — nunca dentro do painel de música.
 *    Num ramo condicional, fechar o painel desmontaria os elementos e a música
 *    silenciaria; o sintoma pareceria problema de rede, e a causa estaria no JSX.
 * 2. **Não é `.video-tile` nem mora dentro de `.video-grid`.** Todo o e2e conta
 *    tiles por essas classes; um `<audio>` ali dentro quebraria a contagem em
 *    todos os roteiros.
 * 3. **A rejeição de `play()` não é engolida.** A política de autoplay bloqueia
 *    mídia sem gesto do usuário: quem entrou e não clicou em nada simplesmente
 *    não ouviria, sem nenhum erro visível. A rejeição vira `onBlocked`, e a UI
 *    mostra um aviso clicável.
 *
 * A decisão 3 é a referência de onde saiu o `lib/audibleMedia.js`: este era o
 * único componente do projeto que tratava a rejeição, o `PeerAudio` não tratava,
 * e a metade que faltava lá era o bug. O hook também traz o `setSinkId` que
 * faltava nos **dois** — sem ele a música ignorava a preferência de saída
 * exatamente como a voz dos participantes ignorava.
 *
 * O volume é **local**: cada participante escolhe o quanto ouve, e isso nunca
 * trafega pelo data channel (o que pode ser local, é local).
 */
export default function RemoteMusicAudio({
  streams = [],
  volume = 1,
  muted = false,
  onBlocked,
  sinkId = '',
  onSinkError,
  unlockNonce = 0,
}: RemoteMusicAudioProps) {
  return (
    <div className="remote-music-audio" aria-hidden="true">
      {streams.map(({ peerId, stream }) => (
        <PeerMusicAudio
          key={peerId}
          stream={stream}
          volume={volume}
          muted={muted}
          onBlocked={onBlocked}
          sinkId={sinkId}
          onSinkError={onSinkError}
          unlockNonce={unlockNonce}
        />
      ))}
    </div>
  );
}

function PeerMusicAudio({
  stream,
  volume = 1,
  muted = false,
  onBlocked,
  sinkId,
  onSinkError,
  unlockNonce,
}: AudibleMediaOptions & { volume?: number; muted?: boolean }) {
  const ref = useRef<HTMLAudioElement | null>(null);

  // Fonte, saída e reprodução — os três com o mesmo tratamento de rejeição do
  // `PeerAudio`. Os callbacks mudam de identidade a cada render do `Room`; é o
  // hook que os guarda em refs, para que isso não reatribua o `srcObject` (o que
  // reiniciaria a reprodução).
  useAudibleMedia(ref, { stream, sinkId, onSinkError, onBlocked, unlockNonce });

  // Volume e mudo continuam aqui: são só deste componente, e o `PeerAudio` não
  // tem equivalente — não há controle de volume por participante.
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.volume = Math.min(1, Math.max(0, volume));
    element.muted = muted;
  }, [volume, muted]);

  return <audio ref={ref} autoPlay />;
}
