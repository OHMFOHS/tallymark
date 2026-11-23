import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['node_modules', 'dist', '.firecrawl', 'artifacts'] },
  ...tseslint.configs.recommended,
);
