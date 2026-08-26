/**
 * Flat config do server (ESLint 9 + typescript-eslint 8).
 *
 * O pacote não tinha lint nenhum até esta entrega. Mesma decisão do client: um
 * config por pacote (flat config resolve plugins a partir do diretório do
 * próprio arquivo) e sem type-aware linting nesta primeira entrega.
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
      globals: { ...globals.node },
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
);
