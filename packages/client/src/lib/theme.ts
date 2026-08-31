/**
 * Preferência de tema: leitura, gravação, resolução e aplicação.
 *
 * Este módulo é **puro**, no mesmo padrão de `devices.ts` e
 * `noiseSuppression.ts`: não toca em `localStorage`, em `matchMedia` nem em
 * `document`. Ele recebe o objeto storage-like, um booleano de "o sistema está
 * no escuro" e — no caso de `applyTheme` — o elemento por parâmetro. Quem faz
 * I/O é quem chama. É essa pureza que permite testar as seis combinações de
 * resolução e os quatro modos de falha de storage em `node:test`, sem jsdom.
 *
 * ---
 * **Exceção declarada à regra de zero persistência.**
 * `ARCHITECTURE.md` §6.10 diz que este produto não grava nada; as exceções são
 * nomeadas uma a uma. Esta é a terceira, ao lado de `wtk-meet:devices`
 * (hardware) e `wtk-meet:audio` (supressão de ruído): **preferência de
 * apresentação, não conteúdo de chamada.** O tema não é conteúdo, não é
 * metadado de chamada, nunca sai do navegador, não vai para o servidor de
 * sinalização nem para os peers, e a alternativa (reescolher o tema a cada
 * aba) cobra um custo recorrente justamente de quem precisa do tema claro por
 * baixa visão ou por estar num notebook ao sol.
 *
 * **Chave própria, e não um sexto campo em `wtk-meet:devices`.** Não é
 * preferência de estilo: `wtk-meet:devices` responde "que hardware usar", tem
 * exatamente cinco campos e é reescrito sozinho por `reconcilePreferences`
 * quando o hardware some. Tema não é hardware e nunca é reconciliado. O
 * precedente é `wtk-meet:audio`, separado pelo mesmo argumento.
 *
 * **Valor string cru, e não JSON.** O script inline do `<head>` do
 * `index.html` — que é quem aplica o tema antes do primeiro paint — precisa ser
 * minúsculo e não pode lançar. `JSON.parse` de um valor corrompido é uma
 * exceção a mais para tratar no caminho mais crítico da página.
 *
 * **O literal da chave existe em dois lugares** (aqui e no script inline), e
 * não há como não existir: o script roda antes de qualquer módulo. Quem prende
 * os dois é `test/themeInlineScript.test.ts`, no mesmo padrão do teste que
 * prende `PROCESSOR_NAME` entre `noiseSuppression.ts` e o worklet.
 */

export const THEME_STORAGE_KEY = 'wtk-meet:theme';

/**
 * As três preferências. `system` é o default e o único que **não** é um tema:
 * é a instrução "siga o sistema", que só vira `light`/`dark` em `resolveTheme`.
 */
export const THEME = {
  SYSTEM: 'system',
  LIGHT: 'light',
  DARK: 'dark',
} as const;

export type ThemePreference = (typeof THEME)[keyof typeof THEME];

/** O que efetivamente é escrito no `<html>`. Nunca `system`. */
export type ResolvedTheme = typeof THEME.LIGHT | typeof THEME.DARK;

export const DEFAULT_THEME: ThemePreference = THEME.SYSTEM;

/** A ordem em que as opções aparecem na UI. */
export const THEME_ORDER: readonly ThemePreference[] = [THEME.SYSTEM, THEME.LIGHT, THEME.DARK];

/** Rótulos da UI, aqui para que o teste possa afirmar que as três existem. */
export const THEME_LABELS: Record<ThemePreference, string> = {
  [THEME.SYSTEM]: 'Sistema',
  [THEME.LIGHT]: 'Claro',
  [THEME.DARK]: 'Escuro',
};

/** Uma `Storage` mínima: só o que este módulo chama, e tudo opcional. */
export interface PreferenceStorage {
  getItem?(key: string): string | null;
  setItem?(key: string, value: string): void;
}

/** O mínimo de um elemento para receber o tema — o que torna `applyTheme` testável. */
export interface ThemeTarget {
  dataset: Record<string, string | undefined> | DOMStringMap;
}

function isPreference(valor: unknown): valor is ThemePreference {
  return valor === THEME.SYSTEM || valor === THEME.LIGHT || valor === THEME.DARK;
}

/**
 * Lê a preferência gravada. **Nunca lança**: chave ausente, valor
 * desconhecido, storage ausente ou `getItem` que lança (Safari privado) caem
 * todos em `system` — que é o default correto, e não um tema fixo.
 */
export function readTheme(storage?: PreferenceStorage | null): ThemePreference {
  try {
    const bruto = storage?.getItem?.(THEME_STORAGE_KEY);
    return isPreference(bruto) ? bruto : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * Grava a preferência e devolve o que efetivamente vale. **Nunca lança**:
 * `setItem` recusado (cota, modo privado) é engolido, e a sessão corrente
 * continua com a escolha aplicada mesmo sem persistir.
 *
 * Um valor inválido não é gravado: ele resolve para o default, e gravar o
 * default criaria a chave sem que ninguém tenha escolhido nada — exatamente o
 * que a regra de zero persistência proíbe.
 */
export function writeTheme(
  storage: PreferenceStorage | null | undefined,
  pref: unknown,
): ThemePreference {
  const efetiva: ThemePreference = isPreference(pref) ? pref : DEFAULT_THEME;
  if (!isPreference(pref)) return efetiva;
  try {
    storage?.setItem?.(THEME_STORAGE_KEY, efetiva);
  } catch {
    // sem persistência nesta sessão — não é motivo para quebrar a chamada
  }
  return efetiva;
}

/**
 * Da preferência ao tema concreto. É a única função que conhece a regra de
 * `system`, e é ela que garante que `data-theme` nunca receba `"system"`.
 */
export function resolveTheme(pref: unknown, prefersDark: boolean): ResolvedTheme {
  const efetiva: ThemePreference = isPreference(pref) ? pref : DEFAULT_THEME;
  if (efetiva === THEME.SYSTEM) return prefersDark ? THEME.DARK : THEME.LIGHT;
  return efetiva;
}

/**
 * A **única** função deste módulo que toca o DOM — e ela recebe o alvo por
 * parâmetro, então continua testável com um objeto de mentira.
 */
export function applyTheme(element: ThemeTarget | null | undefined, resolved: ResolvedTheme): void {
  if (!element?.dataset) return;
  (element.dataset as Record<string, string>).theme = resolved;
}
