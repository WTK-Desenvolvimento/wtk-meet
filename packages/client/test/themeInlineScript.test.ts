/**
 * O script inline de tema do `index.html`, preso ao módulo que ele espelha.
 *
 * O script roda **antes de qualquer módulo** (é o que impede o flash de tema
 * errado), então ele não pode importar `lib/theme.ts` — e por isso o literal da
 * chave existe em dois lugares. Renomear só um lado dá "o tema não persiste":
 * silencioso, sem erro no console, e só em produção.
 *
 * Precedente direto: o teste que prende `PROCESSOR_NAME` entre
 * `noiseSuppression.ts` e o arquivo do worklet, pelo mesmo motivo (o worklet
 * também não pode importar nada).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { THEME, THEME_STORAGE_KEY } from '../src/lib/theme.js';

const raiz = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const html = readFileSync(path.join(raiz, 'index.html'), 'utf8');

test('o index.html usa exatamente a chave de storage do módulo', () => {
  assert.ok(
    html.includes(`'${THEME_STORAGE_KEY}'`) || html.includes(`"${THEME_STORAGE_KEY}"`),
    `index.html não menciona ${THEME_STORAGE_KEY}`,
  );
});

test('o script inline conhece os três valores de preferência', () => {
  for (const valor of Object.values(THEME)) {
    assert.ok(html.includes(`'${valor}'`), `index.html não menciona '${valor}'`);
  }
});

test('o tema é aplicado antes do bundle, e o bundle continua sendo module', () => {
  const posScript = html.indexOf('wtk-meet:theme');
  const posBundle = html.indexOf('<script type="module"');
  assert.ok(posScript >= 0 && posBundle >= 0, 'faltou o script inline ou o bundle');
  assert.ok(
    posScript < posBundle,
    'o script de tema precisa vir antes do bundle: `type="module"` é adiado, e ' +
      'um tema aplicado depois pisca o tema errado no primeiro paint',
  );
});

test('o script escreve o tema já resolvido — nunca "system" no <html>', () => {
  // O CSS tem só dois blocos de token (`[data-theme='dark']` e `[data-theme='light']`).
  // Um `data-theme="system"` no `<html>` não casaria com nenhum dos dois e a
  // página abriria sem cor nenhuma.
  assert.ok(
    /dataset\.theme\s*=\s*[^;]*'dark'\s*:\s*'light'/.test(html) ||
      /dataset\.theme\s*=\s*'(dark|light)'/.test(html),
    'o script deveria escrever apenas dark/light em data-theme',
  );
  assert.ok(
    !/dataset\.theme\s*=\s*['"]system['"]/.test(html),
    'o script nunca pode escrever "system" em data-theme',
  );
});

test('a ordem das camadas de CSS é declarada no <head>, antes de qualquer folha', () => {
  // A ordem de uma camada é fixada no seu primeiro aparecimento, e o CSS deste
  // produto é co-localizado com os componentes: um `.css` de componente pode ser
  // emitido antes de `src/styles.css`. Este `<style>` é a única posição
  // garantidamente anterior a todas as folhas do bundle.
  const declaracao = html.match(/@layer\s+([^;]+);/);
  assert.ok(declaracao, 'index.html não declara a ordem das camadas');
  assert.deepEqual(
    declaracao[1].split(',').map((n) => n.trim()),
    ['tokens', 'base', 'components', 'overlays'],
  );
});
