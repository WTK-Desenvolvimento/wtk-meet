import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import VideoTile, { type Tile } from './VideoTile.js';
import type { LevelSnapshot } from '../lib/audioLevels.js';
import ThumbnailRail from './ThumbnailRail.js';
import { computeSpotlightLayout } from '../lib/spotlightLayout.js';
import { GRID_GAP } from '../lib/gridLayout.js';

import './SpotlightStage.css';

/**
 * O palco em modo destaque: uma tela compartilhada ocupando ~80% da área útil e
 * uma coluna rolável com todo o resto nos ~20% restantes.
 *
 * Mede a própria caixa com `ResizeObserver`, pergunta a `lib/spotlightLayout.js`
 * qual é a geometria daquele palco e escreve o resultado como custom properties
 * — os tiles não recebem estilo inline, exatamente como em `VideoGrid`.
 *
 * O elemento observado é dimensionado **pelo pai** e o conteúdo dentro dele é
 * `position: absolute`: é isso que impede o clássico "ResizeObserver loop", que
 * aqui seria fácil de provocar, já que a coluna rola e está dentro da caixa
 * medida. Observar o `.thumb-rail` seria justamente o erro.
 *
 * Abaixo do limiar de largura (medido, não por media query — o palco encolhe
 * quando o chat abre) o destaque vai a largura cheia e a coluna vira um painel
 * sob demanda **sobreposto** ao destaque: uma terceira faixa de fluxo não
 * deixaria nada para o destaque em 400px de palco.
 */
export default function SpotlightStage({
  spotlight,
  thumbnails,
  audioLevels,
  onSelectScreen,
}: {
  /** Nunca nulo: o `Room` só monta o palco quando há uma tela em destaque. */
  spotlight: Tile;
  thumbnails: Tile[];
  audioLevels: LevelSnapshot;
  onSelectScreen?: (screenId: string) => void;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  const [panelOpen, setPanelOpen] = useState(false);

  useEffect(() => {
    const node = stageRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return undefined;

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const width = Math.floor(rect.width);
      const height = Math.floor(rect.height);
      setBox((prev) => (prev.width === width && prev.height === height ? prev : { width, height }));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const layout = useMemo(
    () =>
      computeSpotlightLayout({
        width: box.width,
        height: box.height,
        count: thumbnails.length,
      }),
    [box.width, box.height, thumbnails.length],
  );

  const narrow = layout.mode === 'spotlight-narrow';
  const closePanel = useCallback(() => setPanelOpen(false), []);

  // Sair do modo estreito (janela alargou, chat fechou) não pode deixar um
  // painel órfão flutuando sobre uma coluna que voltou a existir.
  useEffect(() => {
    if (!narrow || thumbnails.length === 0) setPanelOpen(false);
  }, [narrow, thumbnails.length]);

  // Ao contrário do modal de aprovação — que não fecha por Esc nem por clique
  // fora, de propósito, porque outra pessoa depende da decisão —, aqui não
  // depende ninguém: prender o usuário dentro do painel seria só um bug.
  useEffect(() => {
    if (!panelOpen) return undefined;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closePanel();
      toggleRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      // `target` é `EventTarget`; só um `Node` pode estar contido num elemento.
      const alvo = event.target instanceof Node ? event.target : null;
      if (panelRef.current?.contains(alvo)) return;
      if (toggleRef.current?.contains(alvo)) return; // o próprio botão alterna
      closePanel();
    };

    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [panelOpen, closePanel]);

  // `width === 0` é o primeiro render, antes da medição: os tiles continuam
  // montados, só não são pintados com um tamanho que seria errado por um frame.
  const measured = layout.spotlight.width > 0;
  const hasThumbnails = thumbnails.length > 0;

  const rail = hasThumbnails ? (
    <ThumbnailRail
      items={thumbnails}
      audioLevels={audioLevels}
      spotlightId={spotlight.screenId}
      onSelectScreen={onSelectScreen}
      scrolls={layout.rail.scrolls}
      className={narrow ? 'thumb-rail in-panel' : 'thumb-rail'}
    />
  ) : null;

  return (
    <div className="video-stage spotlight-stage" ref={stageRef}>
      <div
        className={`spotlight-layout ${layout.mode}${measured ? '' : ' unmeasured'}`}
        style={{
          '--spot-w': `${layout.spotlight.width}px`,
          '--spot-h': `${layout.spotlight.height}px`,
          '--rail-w': `${layout.rail.width}px`,
          '--thumb-w': `${layout.rail.thumbWidth}px`,
          '--thumb-h': `${layout.rail.thumbHeight}px`,
          '--grid-gap': `${GRID_GAP}px`,
        }}
      >
        <div className="spotlight-main">
          <VideoTile
            stream={spotlight.stream}
            label={spotlight.label}
            contain={spotlight.contain}
            badge={spotlight.badge}
            connection={spotlight.connection}
          />
        </div>

        {narrow && hasThumbnails && (
          <button
            type="button"
            ref={toggleRef}
            className="participants-toggle"
            aria-expanded={panelOpen}
            onClick={() => setPanelOpen((open) => !open)}
          >
            Participantes
            <span className="badge">{thumbnails.length}</span>
          </button>
        )}

        {narrow ? (
          panelOpen && (
            <div
              className="participants-panel"
              ref={panelRef}
              role="dialog"
              aria-label="Participantes e telas compartilhadas"
            >
              {rail}
            </div>
          )
        ) : (
          rail
        )}
      </div>
    </div>
  );
}
