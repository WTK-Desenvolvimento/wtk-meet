import { useEffect, useRef } from 'react';

/**
 * O padrão "elemento de mídia que de fato produz som", num lugar só.
 *
 * Este arquivo existe porque o padrão estava pela metade em dois componentes
 * diferentes, e cada metade que faltava era um bug em produção:
 *
 * - `PeerAudio.jsx` ligava o stream e não chamava `play()`. Com o autoplay
 *   bloqueado pelo navegador, a pessoa ficava em silêncio permanente, sem erro
 *   no console e sem nenhum caminho na UI para destravar. E existe entrada na
 *   sala **sem gesto**: recarregar a página com o nome em `sessionStorage` entra
 *   direto (ver `Room.jsx`).
 * - Nenhum dos dois aplicava `setSinkId`. Ele tinha ficado para trás no `<video>`
 *   do tile, que é `muted` fixo — a chamada tinha sucesso e não produzia som
 *   nenhum, então o seletor "Saída de áudio" do modal não tinha efeito sobre a
 *   voz dos participantes nem sobre a música. Quem tivesse como padrão do SO uma
 *   saída HDMI ou um fone pareado e ocioso não ouvia ninguém, e o app afirmava
 *   que estava tudo certo.
 *
 * Os dois componentes precisam **exatamente** do mesmo comportamento; é por isso
 * que aqui é um hook e não uma cópia. `RemoteMusicAudio.jsx` é a referência de
 * onde o padrão saiu.
 *
 * ## Três efeitos, nesta ordem, e a ordem importa
 *
 * `attach` → `sink` → `play`. React roda os efeitos na ordem de declaração
 * dentro do mesmo componente, e alguns navegadores só se comportam com
 * `setSinkId` quando o elemento já tem fonte. O que **não** se faz é encadear
 * (`setSinkId().then(play)`): isso acoplaria o destravamento do autoplay ao
 * sucesso do sink, e no Firefox — que não implementa `setSinkId` — o `play()`
 * nunca aconteceria.
 *
 * ## Callbacks por ref, sempre
 *
 * `onSinkError` e `onBlocked` vêm do `Room`, que recria a identidade deles a
 * cada render. Se eles entrassem nas deps do efeito de attach, o `srcObject`
 * seria reatribuído a cada render do `Room` e a reprodução reiniciaria — um
 * corte de áudio causado por um re-render. Ficam em refs; as deps dos efeitos
 * são só o que de fato muda o que o elemento deve fazer.
 */

/**
 * Vale a pena chamar `setSinkId` neste elemento, com esta preferência?
 *
 * Pura para poder ser testada sem DOM — é a regra que decide se o áudio de
 * alguém vai ou não sair pelo dispositivo escolhido.
 *
 */
export function shouldApplySink({
  /** Preferência atual (`''` = padrão do sistema). */
  sinkId,
  /** Este elemento já recebeu algum sink antes? */
  applied,
  /** O elemento implementa `setSinkId`? */
  hasSetSinkId,
}: {
  sinkId?: string;
  applied?: boolean;
  hasSetSinkId?: boolean;
}): boolean {
  // Firefox não tem `setSinkId` por padrão. Chamar mesmo assim lançaria um
  // `TypeError` dentro do efeito e quebraria a montagem do elemento de áudio —
  // isto é, silêncio total: o defeito que este módulo corrige, amplificado.
  if (!hasSetSinkId) return false;
  // Ninguém escolheu saída nenhuma e este elemento nunca recebeu sink: não há o
  // que reverter, e chamar com '' seria uma chamada inútil por elemento a cada
  // montagem. Depois de ter aplicado um id, `''` passa a ser trabalho de
  // verdade — é a volta para o padrão do sistema.
  if (!sinkId && !applied) return false;
  return true;
}

/**
 * Liga um `<audio>`/`<video>` a um `MediaStream` e garante que ele produza som:
 * roteia a saída para o dispositivo escolhido e reproduz, reportando as duas
 * falhas possíveis em vez de engoli-las.
 *
 */
export interface AudibleMediaOptions {
  stream?: MediaStream | null;
  /** Preferência de saída (`''` = padrão do sistema). */
  sinkId?: string;
  /** Rejeição de `setSinkId`. */
  onSinkError?: (err: unknown) => void;
  /** Rejeição de `play()` — autoplay barrado. */
  onBlocked?: () => void;
  /**
   * Muda para re-tentar a reprodução de todos os elementos montados — é o
   * clique no aviso de "o navegador bloqueou o som".
   */
  unlockNonce?: number;
}

export function useAudibleMedia(
  ref: { current: HTMLMediaElement | null },
  { stream, sinkId = '', onSinkError, onBlocked, unlockNonce = 0 }: AudibleMediaOptions = {},
): void {
  const onSinkErrorRef = useRef(onSinkError);
  onSinkErrorRef.current = onSinkError;
  const onBlockedRef = useRef(onBlocked);
  onBlockedRef.current = onBlocked;
  const sinkAppliedRef = useRef(false);

  // 1. Fonte. `srcObject` só é reatribuído quando de fato muda: reatribuir o
  //    mesmo stream reinicia a reprodução.
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const next = stream || null;
    if (element.srcObject !== next) element.srcObject = next;
    if (!stream) return undefined;

    // Tracks entram e saem do mesmo stream via `replaceTrack`, e nem todo
    // navegador reabre o sink sozinho quando o conjunto muda. Reatribuir força
    // o refresh.
    const refresh = () => {
      if (ref.current) ref.current.srcObject = stream;
    };
    stream.addEventListener('addtrack', refresh);
    stream.addEventListener('removetrack', refresh);
    return () => {
      stream.removeEventListener('addtrack', refresh);
      stream.removeEventListener('removetrack', refresh);
    };
  }, [ref, stream]);

  // 2. Saída. É por elemento de mídia — não existe um "device de saída da
  //    página" —, então cada elemento que produz som aplica o seu.
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const hasSetSinkId = typeof element.setSinkId === 'function';
    if (!shouldApplySink({ sinkId, applied: sinkAppliedRef.current, hasSetSinkId })) {
      return undefined;
    }
    sinkAppliedRef.current = true;
    // Nenhuma rejeição escapa: `setSinkId` rejeita com `NotAllowedError` (sem
    // permissão de microfone) ou `NotFoundError` (id que não existe mais), e uma
    // promise rejeitada dentro de um efeito viraria `unhandledrejection` — erro
    // de console, que a checagem G do E2E trata como falha.
    Promise.resolve(element.setSinkId(sinkId)).catch((err) => {
      onSinkErrorRef.current?.(err);
    });
    return undefined;
  }, [ref, sinkId]);

  // 3. Reprodução. A rejeição não é engolida: quem entrou sem clicar em nada
  //    simplesmente não ouviria, sem nenhum erro visível.
  useEffect(() => {
    const element = ref.current;
    if (!element || !stream) return undefined;

    let cancelled = false;
    // Nem todo navegador devolve Promise aqui; `Promise.resolve` normaliza.
    Promise.resolve(element.play()).catch(() => {
      if (!cancelled) onBlockedRef.current?.();
    });

    return () => {
      cancelled = true;
    };
    // `unlockNonce` é o gatilho de re-tentativa; os callbacks ficam fora de
    // propósito (ver o cabeçalho: eles reiniciariam a reprodução a cada render).
  }, [ref, stream, unlockNonce]);
}

export default useAudibleMedia;
