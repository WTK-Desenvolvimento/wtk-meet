/**
 * Testes da preferência de tema.
 *
 * O que está aqui é o que o E2E não alcança de forma barata: as seis
 * combinações de resolução, e os quatro modos de falha de `localStorage`
 * (ausente, vazio, corrompido, lançando). Tudo é entrada→saída, então roda em
 * `node:test` sem navegador, sem jsdom e sem mock de `document` — mesmo padrão
 * de `devices.test.ts`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_THEME,
  THEME,
  THEME_LABELS,
  THEME_ORDER,
  THEME_STORAGE_KEY,
  applyTheme,
  readTheme,
  resolveTheme,
  writeTheme,
} from '../src/lib/theme.js';

import type { ThemePreference } from '../src/lib/theme.js';

/** `localStorage` de mentira, com gatilhos de falha por operação. */
function fakeStorage(
  initial: Record<string, string> = {},
  { failGet = false, failSet = false } = {},
) {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    data,
    getItem(key: string): string | null {
      if (failGet) throw new DOMException('SecurityError');
      return data.has(key) ? data.get(key)! : null;
    },
    setItem(key: string, value: string): void {
      if (failSet) throw new DOMException('QuotaExceededError');
      data.set(key, value);
    },
    dump: () => Object.fromEntries(data),
  };
}

/** O alvo mínimo de `applyTheme` — um objeto com `dataset`, e nada mais. */
const fakeElement = () => ({ dataset: {} as Record<string, string> });

// ------------------------------------------------------------------ contrato

test('a chave é própria, e não um sexto campo de wtk-meet:devices', () => {
  // O E2E afirma que `wtk-meet:devices` tem **exatamente** cinco chaves; um
  // sexto campo lá reprova a checagem. Ver o cabeçalho de `lib/theme.ts`.
  assert.equal(THEME_STORAGE_KEY, 'wtk-meet:theme');
  assert.notEqual(THEME_STORAGE_KEY, 'wtk-meet:devices');
  assert.notEqual(THEME_STORAGE_KEY, 'wtk-meet:audio');
});

test('o default é seguir o sistema — não um tema fixo', () => {
  assert.equal(DEFAULT_THEME, THEME.SYSTEM);
});

test('a UI oferece as três opções, nesta ordem, e cada uma tem rótulo', () => {
  assert.deepEqual([...THEME_ORDER], [THEME.SYSTEM, THEME.LIGHT, THEME.DARK]);
  for (const opcao of THEME_ORDER) {
    assert.equal(typeof THEME_LABELS[opcao], 'string');
    assert.ok(THEME_LABELS[opcao].length > 0, `sem rótulo para ${opcao}`);
  }
});

// -------------------------------------------------------------------- leitura

test('sem nada gravado, a preferência é "system"', () => {
  assert.equal(readTheme(fakeStorage()), THEME.SYSTEM);
});

test('um valor válido gravado é devolvido tal e qual', () => {
  for (const valor of [THEME.LIGHT, THEME.DARK, THEME.SYSTEM]) {
    assert.equal(readTheme(fakeStorage({ [THEME_STORAGE_KEY]: valor })), valor);
  }
});

test('valor corrompido cai no default em vez de virar tema', () => {
  // Uma versão futura, um typo, ou alguém editando o storage à mão. Nenhum
  // deles pode acender o tema errado nem lançar.
  for (const lixo of ['', 'Dark', 'DARK', 'null', '{"theme":"dark"}', 'sistema', '0']) {
    assert.equal(
      readTheme(fakeStorage({ [THEME_STORAGE_KEY]: lixo })),
      THEME.SYSTEM,
      `valor ${JSON.stringify(lixo)} deveria cair no default`,
    );
  }
});

test('storage ausente, sem getItem, ou com getItem que lança: nunca propaga', () => {
  assert.equal(readTheme(null), THEME.SYSTEM);
  assert.equal(readTheme(undefined), THEME.SYSTEM);
  assert.equal(readTheme({}), THEME.SYSTEM);
  // Safari em janela privada: o acesso em si lança.
  assert.equal(readTheme(fakeStorage({}, { failGet: true })), THEME.SYSTEM);
});

// ------------------------------------------------------------------ gravação

test('nada é gravado enquanto ninguém escolhe — a chave só nasce no clique', () => {
  const storage = fakeStorage();
  assert.equal(readTheme(storage), THEME.SYSTEM);
  assert.deepEqual(storage.dump(), {});
});

test('gravar persiste o valor cru, sem JSON', () => {
  const storage = fakeStorage();
  assert.equal(writeTheme(storage, THEME.LIGHT), THEME.LIGHT);
  // String crua: o script inline do `<head>` precisa ler isto sem `JSON.parse`.
  assert.deepEqual(storage.dump(), { [THEME_STORAGE_KEY]: 'light' });
});

test('gravar por cima substitui, e voltar para "system" também é uma escolha', () => {
  const storage = fakeStorage();
  writeTheme(storage, THEME.DARK);
  writeTheme(storage, THEME.SYSTEM);
  assert.deepEqual(storage.dump(), { [THEME_STORAGE_KEY]: 'system' });
  assert.equal(readTheme(storage), THEME.SYSTEM);
});

test('um valor inválido não é gravado: criaria a chave sem ninguém ter escolhido', () => {
  const storage = fakeStorage();
  assert.equal(writeTheme(storage, 'roxo'), THEME.SYSTEM);
  assert.deepEqual(storage.dump(), {});
});

test('setItem recusado não quebra a chamada — a sessão continua com a escolha', () => {
  const storage = fakeStorage({}, { failSet: true });
  assert.equal(writeTheme(storage, THEME.DARK), THEME.DARK);
  assert.deepEqual(storage.dump(), {});
  assert.equal(writeTheme(null, THEME.DARK), THEME.DARK);
  assert.equal(writeTheme({}, THEME.LIGHT), THEME.LIGHT);
});

// ------------------------------------------------------------------ resolução

test('as seis combinações de preferência x sistema', () => {
  const casos: [ThemePreference, boolean, string][] = [
    [THEME.SYSTEM, true, THEME.DARK],
    [THEME.SYSTEM, false, THEME.LIGHT],
    [THEME.LIGHT, true, THEME.LIGHT],
    [THEME.LIGHT, false, THEME.LIGHT],
    [THEME.DARK, true, THEME.DARK],
    [THEME.DARK, false, THEME.DARK],
  ];
  for (const [pref, sistemaEscuro, esperado] of casos) {
    assert.equal(
      resolveTheme(pref, sistemaEscuro),
      esperado,
      `${pref} com prefersDark=${sistemaEscuro}`,
    );
  }
});

test('resolveTheme nunca devolve "system" — é isso que o <html> depende', () => {
  for (const entrada of [THEME.SYSTEM, 'roxo', null, undefined, 42]) {
    for (const sistemaEscuro of [true, false]) {
      const saida = resolveTheme(entrada, sistemaEscuro);
      assert.ok(saida === THEME.LIGHT || saida === THEME.DARK, `devolveu ${saida}`);
    }
  }
});

// ------------------------------------------------------------------ aplicação

test('applyTheme escreve data-theme no alvo que recebe', () => {
  const el = fakeElement();
  applyTheme(el, THEME.LIGHT);
  assert.equal(el.dataset.theme, 'light');
  applyTheme(el, THEME.DARK);
  assert.equal(el.dataset.theme, 'dark');
});

test('applyTheme sem alvo é no-op, não exceção', () => {
  assert.doesNotThrow(() => applyTheme(null, THEME.DARK));
  assert.doesNotThrow(() => applyTheme(undefined, THEME.DARK));
  assert.doesNotThrow(() => applyTheme({} as never, THEME.DARK));
});

test('o ciclo completo: escolher, gravar, recarregar, aplicar', () => {
  const storage = fakeStorage();
  const el = fakeElement();

  // Primeira visita, sistema no claro.
  applyTheme(el, resolveTheme(readTheme(storage), false));
  assert.equal(el.dataset.theme, 'light');
  assert.deepEqual(storage.dump(), {});

  // A pessoa escolhe escuro.
  applyTheme(el, resolveTheme(writeTheme(storage, THEME.DARK), false));
  assert.equal(el.dataset.theme, 'dark');

  // Recarrega: a escolha sobrevive e continua vencendo o sistema no claro.
  const depoisDoReload = fakeElement();
  applyTheme(depoisDoReload, resolveTheme(readTheme(storage), false));
  assert.equal(depoisDoReload.dataset.theme, 'dark');
});
