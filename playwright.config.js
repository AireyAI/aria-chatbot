import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  testMatch: ['widget.test.js', 'router-e2e.test.js'],
  timeout: 30000,
  use: {
    baseURL: 'http://localhost:3003',
  },
});
