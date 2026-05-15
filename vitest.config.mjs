import { defineConfig } from 'vitest/config';

// Vitest picks up *.test.js by default, which collides with Playwright
// specs (widget.test.js, router-e2e.test.js) that use Playwright's
// `test`/`describe` and fail at collection time inside vitest.
//
// Exclude them here so `npm test` only runs the pure-unit suites.
// Playwright still runs them via `npm run test:widget`.
export default defineConfig({
  test: {
    exclude: [
      'node_modules/**',
      'tests/widget.test.js',
      'tests/router-e2e.test.js',
    ],
    // Test files share data/ for the append-only JSONL fixtures (leads.jsonl,
    // pending_actions.jsonl). Parallel file execution races their beforeEach
    // file-deletion — force serial so writes don't get nuked mid-test.
    fileParallelism: false,
  },
});
