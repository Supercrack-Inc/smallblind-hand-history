import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/cards.ts', 'src/hand-evaluator.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2020',
  outExtension: ({ format }) => ({ js: format === 'cjs' ? '.cjs' : '.js' }),
})
