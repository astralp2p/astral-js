import { defineConfig } from 'vitest/config';

// Tests run against the TypeScript source under src/. The `node` environment is
// enough for the pure primitive unit tests and the in-process mock apphost
// WebSocket server (a real `ws` server with globalThis.WebSocket swapped in).
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
