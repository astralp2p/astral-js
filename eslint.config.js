import tseslint from 'typescript-eslint';

// Flat config, non-type-checked recommended set (fast). Type-aware rules can be
// enabled later by pointing parserOptions.project at tsconfig.json.
export default tseslint.config(
  { ignores: ['dist/**', 'reference/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
);
