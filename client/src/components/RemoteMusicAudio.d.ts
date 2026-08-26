/**
 * Declaração **transitória** de `RemoteMusicAudio.jsx`. Mesma razão de
 * `PeerAudio.d.ts`: `peerAudioSink.test.mjs` lê o texto deste arquivo por
 * caminho. Some na fase 7.
 */
import type { ReactElement } from 'react';

export default function RemoteMusicAudio(props: {
  streams?: { peerId: string; stream: MediaStream }[];
  volume?: number;
  muted?: boolean;
  onBlocked?: () => void;
  sinkId?: string;
  onSinkError?: (err: unknown) => void;
  unlockNonce?: number;
}): ReactElement;
