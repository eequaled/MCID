import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // Command tests run real commander programs; give them room for the
    // occasional listener/polling round-trip without flaking CI.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The reviewer's floor: the new command surface must stay covered, not
      // just the lib/ helpers the old suite tested.
      thresholds: {
        'src/commands/**': {
          statements: 35,
          branches: 25,
          functions: 35,
          lines: 35,
        },
      },
    },
  },
});
