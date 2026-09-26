/**
 * Flat config da extensão (ESLint 9 + typescript-eslint 8).
 *
 * Espelho do config do client, sem a parte de React e sem a parte de worklet:
 * popup e `manager` são DOM direto (ver `ARCHITECTURE.md` §11). O que se
 * acrescenta é o global `chrome`, que não está em `globals.browser`.
 *
 * Este arquivo continua sendo `.js` pela mesma razão do client: o ESLint carrega
 * o config antes de qualquer transpilação.
 */
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser, chrome: 'readonly' },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'after-used', ignoreRestSiblings: true },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  {
    // **O motor só fala `chrome.runtime` e `chrome.storage`.** O documento
    // offscreen não tem `chrome.tabs`, `chrome.action` nem
    // `chrome.offscreen`: chamá-las lá dentro é `TypeError` em runtime, e o
    // compilador não avisa. Quem precisa delas pede ao service worker por
    // mensagem (`target: 'sw'`). Esta regra é o que transforma a convenção em
    // algo que falha antes do navegador.
    files: ['src/offscreen.ts', 'src/engine/**'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'chrome',
          message:
            "O motor só fala chrome.runtime e chrome.storage — importe de 'lib/chromeCommon.js'. O resto é pedido ao service worker (target: 'sw').",
        },
      ],
    },
  },

  {
    // O build e os testes rodam no Node.
    files: ['build.ts', 'test/**', 'eslint.config.js'],
    languageOptions: { globals: { ...globals.node } },
  },
);
