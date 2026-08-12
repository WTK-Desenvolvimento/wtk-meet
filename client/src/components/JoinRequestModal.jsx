import { useEffect, useRef, useState } from 'react';

const ESC_HINT = 'Esc não decide nada: o pedido continua pendente. Escolha Aprovar ou Negar.';
const DEFAULT_HINT = 'Cada pedido precisa de uma decisão: Aprovar ou Negar.';

/**
 * Modal de pedidos de entrada.
 *
 * O controle de acesso da sala é social — qualquer participante presente aprova
 * (ver `ARCHITECTURE.md` §4). Se a UI de aprovação é fácil de não ver, o
 * mecanismo de segurança degrada na prática para "ninguém entra". Por isso o
 * pedido é um modal centralizado sobre tudo, e não um bloco na coluna do
 * conteúdo: ele é montado fora do switch de fase do `Room`, então aparece
 * também em quem ainda está conectando ou aguardando aprovação.
 *
 * Não fecha por Esc nem por clique no backdrop **de propósito**: um fechamento
 * acidental deixaria alguém esperando indefinidamente do outro lado. As duas
 * tentativas recebem uma resposta explícita em vez de silêncio.
 */
export default function JoinRequestModal({ requests, onApprove, onDeny }) {
  const approveRef = useRef(null);
  const openerRef = useRef(null);
  const [hint, setHint] = useState(null);

  const open = requests.length > 0;
  const firstId = open ? requests[0].requesterId : null;

  // Foco vai para o modal ao abrir e volta para quem o tinha ao fechar. O
  // elemento anterior pode ter saído do DOM enquanto o modal estava aberto
  // (a barra de controles muda de rótulo), daí a checagem antes de devolver.
  useEffect(() => {
    if (!open) return undefined;
    const opener = document.activeElement;
    openerRef.current = opener;
    setHint(null);
    return () => {
      openerRef.current = null;
      if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
    };
  }, [open]);

  // Resolver um pedido remove o botão que estava focado; o foco iria para o
  // <body> e o teclado ficaria perdido. Recoloca no primeiro "Aprovar" restante.
  useEffect(() => {
    if (firstId) approveRef.current?.focus();
  }, [firstId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      // Captura: nenhum outro handler chega a interpretar esse Esc como "fechar".
      event.preventDefault();
      event.stopPropagation();
      setHint(ESC_HINT);
      approveRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  if (!open) return null;

  const title =
    requests.length === 1
      ? 'Pedido de entrada'
      : `${requests.length} pedidos de entrada`;

  return (
    <div className="modal-backdrop" onMouseDown={() => setHint(ESC_HINT)}>
      <div
        className="join-request-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="join-request-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="join-request-title">{title}</h2>

        <ul className="join-request-list">
          {requests.map((request, index) => (
            <li key={request.requesterId} className="join-request">
              <span className="join-request-name">
                <strong>{request.displayName}</strong> quer entrar na sala
              </span>
              <span className="join-request-actions">
                <button
                  type="button"
                  className="approve"
                  ref={index === 0 ? approveRef : null}
                  onClick={() => onApprove(request.requesterId)}
                >
                  Aprovar
                </button>
                <button type="button" onClick={() => onDeny(request.requesterId)}>
                  Negar
                </button>
              </span>
            </li>
          ))}
        </ul>

        <p className="join-request-hint" role="status">
          {hint || DEFAULT_HINT}
        </p>
      </div>
    </div>
  );
}
