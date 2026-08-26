/**
 * Declaração **transitória** de `PeerAudio.jsx`.
 *
 * O componente continua JSX porque `peerAudioSink.test.mjs` lê o **texto** do
 * arquivo por caminho (`readFileSync('../src/components/PeerAudio.jsx')`) para
 * provar que ele usa `useAudibleMedia`, e nenhum hook de módulo intercepta uma
 * leitura de `fs`. Renomear agora quebraria o item 6 do DoD.
 *
 * Some na fase 7, junto com a conversão do teste e do próprio componente.
 */
import type { ReactElement } from 'react';

export default function PeerAudio(props: {
  participants: Map<string, { stream?: MediaStream | null }>;
  sinkId?: string;
  onSinkError?: (err: unknown) => void;
  onBlocked?: () => void;
  unlockNonce?: number;
}): ReactElement;
