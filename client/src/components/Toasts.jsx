/**
 * Avisos efêmeros de entrada/saída. O ciclo de vida (timer de ~4s) vive no
 * `Room`, junto com o bipe — aqui é só apresentação.
 */
export default function Toasts({ toasts }) {
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast toast-${toast.kind}`}>
          <span className="toast-icon" aria-hidden="true">
            {toast.kind === 'join' ? '→' : '←'}
          </span>
          {toast.text}
        </div>
      ))}
    </div>
  );
}
