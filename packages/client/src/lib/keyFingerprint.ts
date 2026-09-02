import { useEffect, useState } from 'react';

/**
 * A "impressão da chave" — a marca de privacidade da direção Rail.
 *
 * A passphrase da sala (`location.hash`, ver `lib/roomSlug.js`) é o segredo real
 * que decide quem entra na mesma sala de sinalização e — quando o E2EE estiver
 * ligado — a chave AES derivada dela. Este módulo traduz esse segredo em oito
 * cores, sempre as mesmas para quem tem a mesma passphrase: é o que permite
 * conferir de relance, sem ler hash nenhum, se duas pessoas abriram o mesmo
 * link. Não é decoração — é `SHA-256(passphrase)` de verdade, e diverge do
 * mesmo jeito que a passphrase diverge.
 *
 * A paleta de 16 cores é a mesma dos ramps `--color-accent-*` e
 * `--color-neutral-*` do design system: nenhuma cor nova entra só para isto.
 * 256 (o espaço de um byte) é múltiplo de 16, então `byte % 16` não tem viés —
 * cada cor da paleta tem a mesma chance de aparecer em cada posição.
 */

// Só os degraus 300–900: os dois mais claros de cada ramp (100/200) são quase
// brancos, e num chip de 26×44 sobre o fundo escuro do sistema eles destoam
// dos outros sete — a sequência de exemplo do protótipo também parou em 300.
// 14 cores, não 16: `byte % 14` tem um viés pequeno (256 não é múltiplo de
// 14) que não importa aqui — a impressão não precisa de entropia perfeita,
// só de ser estável e, na prática, diferente entre chaves diferentes.
const PALETTE = [
  '#d2cefd', // accent-300
  '#b5abfc', // accent-400
  '#968ae0', // accent-500
  '#796cbf', // accent-600
  '#5d5294', // accent-700
  '#423a6a', // accent-800
  '#2b2741', // accent-900
  '#cfd3e5', // neutral-300
  '#b2b6ca', // neutral-400
  '#9397ab', // neutral-500
  '#75798c', // neutral-600
  '#595d6c', // neutral-700
  '#3f424d', // neutral-800
  '#292b31', // neutral-900
] as const;

/** Quantas cores compõem a impressão — um por cada 16 bits dos 128 da chave. */
export const FINGERPRINT_LENGTH = 8;

const encoder = new TextEncoder();

/**
 * Deriva a sequência de cores de uma passphrase. `null`/`''` devolve `[]`: sem
 * chave não há o que desenhar, e quem chama decide o placeholder.
 *
 * Puro seed → saída: a mesma passphrase produz sempre a mesma sequência, em
 * qualquer aba, em qualquer máquina — é essa igualdade que faz duas pessoas na
 * mesma sala poderem comparar de relance.
 */
export async function deriveKeyFingerprint(passphrase: string | null | undefined): Promise<string[]> {
  if (!passphrase) return [];
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(passphrase));
  const bytes = new Uint8Array(digest);
  const colors: string[] = [];
  for (let i = 0; i < FINGERPRINT_LENGTH; i += 1) {
    colors.push(PALETTE[bytes[i] % PALETTE.length]);
  }
  return colors;
}

/**
 * A mesma derivação, como hook. `crypto.subtle.digest` é assíncrono; enquanto
 * ele não resolve (ou sem passphrase) o hook devolve `[]`, e quem chama decide
 * o placeholder — em geral `FINGERPRINT_LENGTH` blocos neutros piscando.
 */
export function useKeyFingerprint(passphrase: string | null | undefined): string[] {
  const [colors, setColors] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (!passphrase) {
      setColors([]);
      return undefined;
    }
    deriveKeyFingerprint(passphrase).then((next) => {
      if (!cancelled) setColors(next);
    });
    return () => {
      cancelled = true;
    };
  }, [passphrase]);

  return colors;
}
