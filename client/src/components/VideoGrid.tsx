import { useEffect, useMemo, useRef, useState } from 'react';
import VideoTile, { type Tile } from './VideoTile.js';
import type { LevelSnapshot } from '../lib/audioLevels.js';
import { computeGridLayout, GRID_GAP } from '../lib/gridLayout.js';

/**
 * A grade de vídeos. Mede o próprio palco, pergunta a `lib/gridLayout.js` qual é
 * a melhor grade para aquela caixa e escreve o resultado como custom properties
 * — os tiles nunca recebem estilo inline.
 *
 * O elemento observado (`.video-stage`) é dimensionado **pelo pai**, e a grade
 * dentro dele é `position: absolute`. Isso é o que impede o clássico
 * "ResizeObserver loop": o conteúdo não tem como empurrar a caixa que está sendo
 * medida. O `setState` também só dispara quando as dimensões inteiras mudam —
 * comparar float faria o subpixel de scrollbar/zoom oscilar para sempre.
 */
export default function VideoGrid({
  tiles,
  audioLevels,
}: {
  tiles: Tile[];
  audioLevels: LevelSnapshot;
}) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });

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
    () => computeGridLayout({ width: box.width, height: box.height, count: tiles.length }),
    [box.width, box.height, tiles.length],
  );

  // `tileWidth === 0` é o estado "ainda não medido" do primeiro render. Os tiles
  // continuam montados (o <video> é o que reproduz o áudio do peer), só não são
  // pintados com um tamanho que seria errado por um frame.
  const measured = layout.tileWidth > 0;

  return (
    <div className="video-stage" ref={stageRef}>
      <div
        className={
          `video-grid${layout.overflow ? ' overflowing' : ''}${measured ? '' : ' unmeasured'}`
        }
        style={{
          '--grid-cols': layout.cols,
          '--tile-w': `${layout.tileWidth}px`,
          '--grid-gap': `${GRID_GAP}px`,
        }}
      >
        {tiles.map((tile) => {
          const levels = tile.audioId ? audioLevels[tile.audioId] : null;
          return (
            <VideoTile
              key={tile.key}
              stream={tile.stream}
              label={tile.label}
              mirrored={tile.mirrored}
              contain={tile.contain}
              badge={tile.badge}
              cameraOff={tile.cameraOff}
              micOff={tile.micOff}
              speaking={!!levels?.speaking}
              level={levels?.level || 0}
              connection={tile.connection}
            />
          );
        })}
      </div>
    </div>
  );
}
