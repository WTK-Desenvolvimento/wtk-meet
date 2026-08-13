import { useEffect, useRef } from 'react';

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
 * O volume é **local**: cada participante escolhe o quanto ouve, e isso nunca
 * trafega pelo data channel (o que pode ser local, é local).
 */
export default function RemoteMusicAudio({ streams = [], volume = 1, muted = false, onBlocked }) {
  return (
    <div className="remote-music-audio" aria-hidden="true">
      {streams.map(({ peerId, stream }) => (
        <PeerMusicAudio
          key={peerId}
          stream={stream}
          volume={volume}
          muted={muted}
          onBlocked={onBlocked}
        />
      ))}
    </div>
  );
}

function PeerMusicAudio({ stream, volume, muted, onBlocked }) {
  const ref = useRef(null);
  // O callback muda de identidade a cada render do `Room`; guardá-lo num ref
  // evita reatribuir o `srcObject` (que reinicia a reprodução) por causa disso.
  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;

  useEffect(() => {
    const element = ref.current;
    if (!element || !stream) return undefined;

    if (element.srcObject !== stream) element.srcObject = stream;

    let cancelled = false;
    const promise = element.play();
    // Nem todo navegador devolve Promise aqui; `Promise.resolve` normaliza.
    Promise.resolve(promise).catch(() => {
      if (!cancelled) onBlockedRef.current?.();
    });

    return () => {
      cancelled = true;
    };
  }, [stream]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    element.volume = Math.min(1, Math.max(0, volume));
    element.muted = muted;
  }, [volume, muted]);

  return <audio ref={ref} autoPlay />;
}
