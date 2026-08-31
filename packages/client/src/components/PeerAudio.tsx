import { useRef } from 'react';
import { useAudibleMedia } from '../lib/audibleMedia.js';

import type { AudibleMediaOptions } from '../lib/audibleMedia.js';

import './PeerAudio.css';

/**
 * O que o `PeerAudio` precisa de cada participante: o stream, quando ele já
 * existe. É de propósito mais frouxo que o `Participant` do `Room` — este
 * componente não lê mais nada, e amarrá-lo à forma inteira criaria acoplamento
 * que o teste teria de reproduzir sem motivo.
 */
export interface PeerAudioParticipant {
  stream?: MediaStream | null;
}

export interface PeerAudioProps extends Omit<AudibleMediaOptions, 'stream'> {
  participants: Map<string, PeerAudioParticipant>;
}

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
 * **É aqui que mora o roteamento de saída de áudio.** Quando o som saiu do
 * `<video>` do tile, o `setSinkId` ficou para trás — continuou sendo chamado
 * sobre um elemento `muted`, com sucesso e sem produzir som nenhum, e o seletor
 * "Saída de áudio" do modal deixou de ter qualquer efeito sobre a voz dos
 * participantes. Elemento que produz som é elemento que roteia saída: as duas
 * coisas andam juntas, e é o `lib/audibleMedia.js` que as mantém juntas.
 *
 * Não confundir com `lib/audioLevels.js`: aquele analisa o stream para o anel de
 * fala e não reproduz nada. Este reproduz e não analisa.
 */
function PeerAudioElement({
  stream,
  sinkId,
  onSinkError,
  onBlocked,
  unlockNonce,
}: AudibleMediaOptions) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useAudibleMedia(ref, { stream, sinkId, onSinkError, onBlocked, unlockNonce });

  // `playsInline` não existe em `<audio>` (é atributo de vídeo em iOS).
  return <audio ref={ref} autoPlay />;
}

export default function PeerAudio({
  participants,
  sinkId = '',
  onSinkError,
  onBlocked,
  unlockNonce = 0,
}: PeerAudioProps) {
  const entries: [string, MediaStream][] = [];
  for (const [peerId, info] of participants) {
    if (info?.stream) entries.push([peerId, info.stream]);
  }

  return (
    <div className="peer-audio-sinks" aria-hidden="true">
      {entries.map(([peerId, stream]) => (
        <PeerAudioElement
          key={peerId}
          stream={stream}
          sinkId={sinkId}
          onSinkError={onSinkError}
          onBlocked={onBlocked}
          unlockNonce={unlockNonce}
        />
      ))}
    </div>
  );
}
