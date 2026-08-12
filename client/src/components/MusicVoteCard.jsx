import { useEffect, useRef, useState } from 'react';
import { remainingMs, tally } from '../lib/musicVote.js';

/**
 * Card de votação da sala — ligar o player, ou pular a faixa corrente.
 *
 * **Não é modal, e isso é uma decisão, não uma economia.** O modal bloqueante
 * existe para pedido de entrada porque ali o custo de ignorar é alguém preso do
 * lado de fora. Música não tem esse custo: bloquear a tela de uma reunião com
 * uma votação de playlist é o tipo de coisa que faz desligarem o recurso. Aqui
 * dá para silenciar o microfone, abrir o chat e clicar em qualquer controle com
 * o card aberto — e fechar sem votar, porque abster-se é legítimo e o prazo
 * resolve.
 *
 * O `z-index` (25) fica acima dos toasts (20) e **abaixo** do modal de entrada
 * (30): controle de acesso nunca fica atrás de música.
 */
export default function MusicVoteCard({ vote, myVote, onVote, onClose }) {
  const [remaining, setRemaining] = useState(() => remainingMs(vote, performance.now()));
  const cardRef = useRef(null);

  useEffect(() => {
    if (!vote) return undefined;
    // Relógio local monótono: o prazo é contado do instante em que **este**
    // client recebeu a abertura. O resultado oficial vem do árbitro; esta
    // contagem é só para a pessoa saber quanto tempo ainda tem.
    const update = () => setRemaining(remainingMs(vote, performance.now()));
    update();
    const timer = setInterval(update, 250);
    return () => clearInterval(timer);
  }, [vote]);

  useEffect(() => {
    if (!vote) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    const onPointerDown = (event) => {
      if (cardRef.current && !cardRef.current.contains(event.target)) onClose?.();
    };
    window.addEventListener('keydown', onKeyDown);
    // `click` no capture: fechar sem engolir o clique que o usuário deu em
    // outro controle da sala — o card não bloqueia nada.
    window.addEventListener('click', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('click', onPointerDown, true);
    };
  }, [vote, onClose]);

  if (!vote) return null;

  const result = tally(vote);
  const seconds = Math.ceil(remaining / 1000);
  const decided = !!vote.result;

  return (
    <aside
      className="music-vote-card"
      ref={cardRef}
      role="region"
      aria-label="Votação de música"
    >
      <header className="music-vote-header">
        <strong>{vote.proposerName || 'Alguém'}</strong>
        <span className="music-vote-question">
          {vote.kind === 'skip'
            ? `quer pular “${vote.target?.title || 'a faixa atual'}”`
            : 'quer ligar o player de música da sala'}
        </span>
      </header>

      <p className="music-vote-tally">
        {result.yes} sim · {result.no} não
        <span className="music-vote-quorum">
          {' '}
          · {result.electorateSize} {result.electorateSize === 1 ? 'eleitor' : 'eleitores'}
        </span>
      </p>

      {decided ? (
        <p className={`music-vote-result${vote.result.approved ? ' approved' : ''}`}>
          {vote.result.approved ? 'Aprovado.' : 'Reprovado.'}
        </p>
      ) : (
        <>
          <div className="music-vote-actions">
            <button
              type="button"
              className={myVote === 'yes' ? 'chosen' : ''}
              onClick={() => onVote?.('yes')}
            >
              Sim
            </button>
            <button
              type="button"
              className={myVote === 'no' ? 'chosen' : ''}
              onClick={() => onVote?.('no')}
            >
              Não
            </button>
          </div>
          <p className="music-vote-timer">
            {seconds > 0 ? `${seconds}s para votar` : 'Apurando…'}
          </p>
        </>
      )}
    </aside>
  );
}
