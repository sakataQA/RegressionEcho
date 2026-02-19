
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '/Users/kazunori.sakata.ts/MIXITools/RegressionEcho/.regression-echo-tmp/android-MEwKju',
  timeout: 120000,

  use: {
    baseURL: 'https://development.pocket-heroes.net/home',
    storageState: '/Users/kazunori.sakata.ts/MIXITools/RegressionEcho/storage/auth.json',
    headless: false,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  reporter: [['html', { outputFolder: '/Users/kazunori.sakata.ts/MIXITools/RegressionEcho/playwright-report', open: 'never' }]],
  workers: 1,
});
