import { defineConfig } from 'tsup';

// One entry per public subpath in package.json#exports. tsup (esbuild) emits
// .mjs + .cjs per entry and generates matching .d.ts + .d.cts, so plain-JS
// consumers get full type hints on both `import` and `require`. The apphost
// WebSocket client is bundled into the root entry (not its own subpath); `ws`
// stays external so browser bundles never pull it in.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'astral/index': 'src/astral/index.ts',
    'apphost/index': 'src/apphost/index.ts',
    'api/dir/index': 'src/api/dir/index.ts',
    'api/crypto/index': 'src/api/crypto/index.ts',
    'api/tree/index': 'src/api/tree/index.ts',
    'api/objects/index': 'src/api/objects/index.ts',
    'api/user/index': 'src/api/user/index.ts',
    'api/auth/index': 'src/api/auth/index.ts',
    'api/services/index': 'src/api/services/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'es2022',
  external: ['ws'],
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.mjs' };
  },
});
