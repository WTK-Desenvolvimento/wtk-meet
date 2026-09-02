import { FINGERPRINT_LENGTH } from '../lib/keyFingerprint.js';

/**
 * As oito cores da chave da sala — ver `lib/keyFingerprint.js` para a
 * derivação. Puramente apresentação: recebe a sequência já pronta (ou vazia,
 * enquanto o hash não resolve) e desenha os blocos.
 *
 * `size="lg"` é a versão da Home e do lobby (blocos altos, com legenda por
 * cima); `size="sm"` é a versão que cabe no cabeçalho da sala, ao lado do
 * contador de participantes.
 */
export default function KeyFingerprint({
  colors,
  size = 'lg',
  className = '',
}: {
  colors: string[];
  size?: 'lg' | 'sm';
  className?: string;
}) {
  // Enquanto o hash não resolveu (ou sem passphrase), oito placeholders
  // neutros mantêm o layout estável em vez de a fileira "pular" quando a
  // sequência de verdade chega um instante depois.
  const slots = colors.length === FINGERPRINT_LENGTH ? colors : Array(FINGERPRINT_LENGTH).fill(null);

  return (
    <div className={`key-fingerprint key-fingerprint-${size} ${className}`.trim()} aria-hidden="true">
      {slots.map((color, i) => (
        <span
          key={i}
          className="key-fingerprint-chip"
          style={color ? { background: color } : undefined}
        />
      ))}
    </div>
  );
}
