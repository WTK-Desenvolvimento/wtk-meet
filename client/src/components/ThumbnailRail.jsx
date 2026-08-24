import { useCallback, useEffect, useRef, useState } from 'react';
import VideoTile from './VideoTile.jsx';
import { orderRailItems } from '../lib/spotlightLayout.js';

/**
 * A coluna de miniaturas do modo destaque: câmeras de todo mundo e as telas
 * compartilhadas. A tela em destaque nunca aparece aqui **com stream** —
 * renderizar a mesma imagem em dois `<video>` dobraria o custo de decodificação
 * sem entregar informação nova; quando há mais de uma tela ela entra como
 * marcador pressionado, montado pelo `Room` sem stream (o tile cai no
 * placeholder).
 *
 * O mesmo componente é o conteúdo do painel sob demanda no modo estreito: muda o
 * container, não a lista.
 *
 * Miniatura de tela é um `<button>` de verdade, com `aria-pressed`. Um `<div
 * onClick>` exigiria `tabindex`, handlers de Enter/Espaço e `role` na mão — a
 * fonte usual de regressão silenciosa de acessibilidade. Miniatura de câmera não
 * é clicável (fixar câmera está fora do escopo) e não entra na ordem de
 * tabulação.
 */
export default function ThumbnailRail({
  items,
  audioLevels,
  spotlightId,
  onSelectScreen,
  className = 'thumb-rail',
  scrolls = false,
}) {
  const previousOrderRef = useRef([]);
  // Reordenar a coluna enquanto o usuário rolou para olhar alguém no fim da
  // lista move o conteúdo debaixo da mão dele. Fora do topo, a ordem congela.
  const [frozen, setFrozen] = useState(false);

  const speaking = new Set(
    Object.entries(audioLevels || {})
      .filter(([, value]) => value?.speaking)
      .map(([audioId]) => audioId),
  );

  const ordered = orderRailItems({
    items,
    speaking,
    previousOrder: previousOrderRef.current,
    frozen,
  });

  useEffect(() => {
    previousOrderRef.current = ordered.map((item) => item.key);
  });

  const handleScroll = useCallback((event) => {
    const atTop = event.currentTarget.scrollTop <= 4;
    setFrozen((prev) => (prev === !atTop ? prev : !atTop));
  }, []);

  return (
    <div
      className={`${className}${scrolls ? ' scrolling' : ''}`}
      onScroll={handleScroll}
    >
      {ordered.map((item) => {
        const levels = item.audioId ? audioLevels?.[item.audioId] : null;
        const tile = (
          <VideoTile
            stream={item.stream}
            label={item.label}
            mirrored={item.mirrored}
            contain={item.contain}
            badge={item.badge}
            cameraOff={item.cameraOff}
            micOff={item.micOff}
            speaking={!!levels?.speaking}
            level={levels?.level || 0}
            connection={item.connection}
            compact
          />
        );

        if (!item.screenId) {
          return (
            <div className="thumb-item" key={item.key}>
              {tile}
            </div>
          );
        }

        // Grupo de escolha: a tela em destaque continua na lista como botão
        // pressionado (sem stream — ver `Room.jsx`), para que o estado "é esta
        // que você está vendo" exista para o teclado e o leitor de tela, e para
        // que ativar um botão não faça o foco sumir junto com a miniatura.
        const pressed = item.screenId === spotlightId;
        return (
          <button
            type="button"
            key={item.key}
            className={`thumb-item thumb-select${item.spotlighted ? ' spotlighted' : ''}`}
            aria-pressed={pressed}
            aria-label={`Ver a tela de ${item.owner || 'participante'} em destaque`}
            onClick={() => onSelectScreen?.(item.screenId)}
          >
            {tile}
          </button>
        );
      })}
    </div>
  );
}
