import { defineConfig } from '@playwright/test';
import config from './playwright.config.js';

export default defineConfig({
  ...config,
  testMatch: 'production.spec.js',
  outputDir: './test-results/production',
  use: { ...config.use, baseURL: 'http://127.0.0.1:4173' },
  webServer: { ...config.webServer, command: 'npm run preview', url: 'http://127.0.0.1:4173' },
});
