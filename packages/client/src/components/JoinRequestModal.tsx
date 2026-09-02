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
/** Um pedido de entrada aguardando decisão. */
export interface JoinRequest {
  requesterId: string;
  displayName: string;
}

export default function JoinRequestModal({
  requests,
  onApprove,
  onDeny,
}: {
  requests: JoinRequest[];
  onApprove: (requesterId: string) => void;
  onDeny: (requesterId: string) => void;
}) {
  const approveRef = useRef<HTMLButtonElement | null>(null);
  const openerRef = useRef<Element | null>(null);
  const [hint, setHint] = useState<string | null>(null);

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
      // `activeElement` é `Element`; só `HTMLElement` tem `focus`, e o `typeof`
      // abaixo é a checagem que já existia — aqui ela também estreita o tipo.
      if (opener && opener.isConnected && opener instanceof HTMLElement) opener.focus();
    };
  }, [open]);

  // Resolver um pedido remove o botão que estava focado; o foco iria para o
  // <body> e o teclado ficaria perdido. Recoloca no primeiro "Aprovar" restante.
  useEffect(() => {
    if (firstId) approveRef.current?.focus();
  }, [firstId]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
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
          {requests.map((request: JoinRequest, index: number) => (
            <li key={request.requesterId} className="join-request">
              <span className="join-request-avatar" aria-hidden="true">
                {(request.displayName || '?').trim().charAt(0).toUpperCase()}
              </span>
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
