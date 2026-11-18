import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests must never inherit a developer's real keys or a real .env.
    env: {},
    restoreMocks: true,
  },
});
