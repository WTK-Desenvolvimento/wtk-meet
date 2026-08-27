/**
 * Flat config do client (ESLint 9 + typescript-eslint 8).
 *
 * Substitui o `.eslintrc.json`, que o ESLint 9 não lê mais sem flag de
 * compatibilidade. Um config por pacote, e não um na raiz: flat config resolve
 * plugins a partir do diretório do próprio arquivo, e a raiz do repositório não
 * tem `node_modules` (os três pacotes são independentes, por decisão registrada
 * no ARCHITECTURE.md §7).
 *
 * **Sem type-aware linting** (`projectService`) nesta entrega: ele multiplica o
 * tempo de lint por ~5 e traz um conjunto de regras novas cujo vermelho se
 * confundiria com o da migração. Fica registrado como trabalho futuro.
 *
 * Este arquivo continua sendo `.js`: é exceção declarada do item 2 do DoD, e
 * precisa ser, porque o ESLint carrega o config antes de qualquer transpilação.
 */
import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'dist-smoke/', 'node_modules/'] },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  react.configs.flat.recommended,
  react.configs.flat['jsx-runtime'],
  {
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      // Paridade com o `.eslintrc.json` que este arquivo substitui.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { args: 'after-used', ignoreRestSiblings: true },
      ],
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Os tipos são o contrato agora; `prop-types` seria a mesma informação
      // escrita duas vezes, e as duas divergiriam.
      'react/prop-types': 'off',
    },
  },

  {
    // O worklet roda no `AudioWorkletGlobalScope`: `sampleRate`,
    // `registerProcessor` e `AudioWorkletProcessor` são globais de lá, e não de
    // `window`. Declarados no `src/types/audioworklet.d.ts` para o TypeScript;
    // aqui, para o ESLint.
    files: ['src/lib/noiseSuppressorWorklet.ts'],
    languageOptions: {
      globals: { sampleRate: 'readonly', currentTime: 'readonly', registerProcessor: 'readonly', AudioWorkletProcessor: 'readonly' },
    },
  },

  {
    // Testes, hooks de módulo, o probe de diagnóstico e o config do Vite rodam
    // no Node.
    files: ['test/**', 'vite.config.ts', 'eslint.config.js', 'probe4.mjs'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      // Os testes de hook do projeto chamam o hook sob teste de dentro de um
      // `render` próprio, com dispatcher montado à mão — é o padrão que permite
      // exercitar `useMusicRoom` em `node --test` sem navegador. A regra existe
      // para código de aplicação, e ali continua valendo.
      //
      // Isto não é afrouxamento: o `.eslintrc.json` que este arquivo substitui
      // rodava com `eslint src`, e nunca chegou a olhar `test/`.
      'react-hooks/rules-of-hooks': 'off',
    },
  },
);
