const { defineConfig } = require('@playwright/test');
const path = require('path');

const ROOT_DIR = __dirname;

const headlessFromEnv = process.env.PW_HEADLESS;
const isHeadless = headlessFromEnv === undefined
  ? false
  : ['1', 'true', 'yes'].includes(headlessFromEnv.toLowerCase());

module.exports = defineConfig({
  testDir: path.join(ROOT_DIR, 'tests'),
  timeout: 30000,
  globalSetup: path.join(ROOT_DIR, 'playwright.global-setup.js'),
  use: {
    baseURL: 'https://development.pocket-heroes.net/home',
    storageState: path.join(ROOT_DIR, 'storage', 'auth.json'),
    headless: isHeadless,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  reporter: [['html', { outputFolder: path.join(ROOT_DIR, 'playwright-report'), open: 'never' }]],
  workers: 1,
});
