/**
 * Avisos efêmeros de entrada/saída. O ciclo de vida (timer de ~4s) vive no
 * `Room`, junto com o bipe — aqui é só apresentação.
 */
import './Toasts.css';

/** Um aviso efêmero. O ciclo de vida (o timer) é do `Room`. */
export interface Toast {
  id: string | number;
  kind: 'join' | 'leave' | string;
  text: string;
}

export default function Toasts({ toasts }: { toasts: Toast[] }) {
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
