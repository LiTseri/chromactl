import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
  dts: false,
  shims: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
