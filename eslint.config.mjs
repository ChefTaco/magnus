import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    '**/.next/**',
    '**/coverage/**',
    '**/dist/**',
    '**/node_modules/**',
    '**/out/**',
    '**/src/db/generated/**',
  ]),
  { linterOptions: { reportUnusedDisableDirectives: 'off' } },
  {
    files: ['**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'no-debugger': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-unreachable': 'error',
      'valid-typeof': 'error',
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: { parser: tseslint.parser },
    plugins: { '@typescript-eslint': tseslint.plugin },
  },
]);
