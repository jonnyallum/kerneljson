import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'artifacts/**'] },
  { files: ['**/*.ts'], extends: [js.configs.recommended, ...tseslint.configs.recommended], rules: {
    'prefer-const': ['error', { ignoreReadBeforeAssign: true }],
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }],
  } },
);
