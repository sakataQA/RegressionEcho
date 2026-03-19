const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

class TestExecutor {
  constructor(testsDir, projectDir) {
    this.testsDir = testsDir;
    this.projectDir = projectDir;
  }

  listTestFiles(filterIds) {
    if (!fs.existsSync(this.testsDir)) {
      return [];
    }

    const files = fs.readdirSync(this.testsDir).filter((f) => f.endsWith('.spec.ts'));
    const sorted = [...files].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));

    if (filterIds && filterIds.length > 0) {
      const available = new Set(sorted);
      return filterIds
        .map((testId) => `${testId}.spec.ts`)
        .filter((fileName) => available.has(fileName));
    }

    return sorted;
  }

  buildCommand(testFiles, options) {
    const filePaths = testFiles.map((f) => path.join(this.testsDir, f)).join(' ');
    return `npx playwright test ${filePaths} --reporter=html`;
  }

  async run(filterIds, options) {
    const testFiles = this.listTestFiles(filterIds);

    if (testFiles.length === 0) {
      console.log('実行するテストが見つかりません。');
      return { exitCode: 0, testCount: 0 };
    }

    const configPath = this.generatePlaywrightConfig(options);
    const filePaths = testFiles.map((f) => path.join(this.testsDir, f)).join(' ');
    const cmd = `npx playwright test ${filePaths} --config=${configPath}`;
    const env = {
      ...process.env,
      ...(options.reuseContext ? { PW_TEST_REUSE_CONTEXT: '1' } : {}),
    };

    console.log('テストを実行中...\n');

    try {
      childProcess.execSync(cmd, { cwd: this.projectDir, stdio: 'inherit', env });
      return { exitCode: 0, testCount: testFiles.length };
    } catch (error) {
      return { exitCode: error.status || 1, testCount: testFiles.length };
    }
  }

  generatePlaywrightConfig(options) {
    const configPath = path.join(this.projectDir, 'playwright.config.js');
    const reportDir = path.join(this.projectDir, 'playwright-report');
    const jsonReportPath = path.join(this.projectDir, 'test-results', 'results.json');
    const globalSetupPath = this.generateGlobalSetup(options);
    const headless = options.headless === undefined ? false : Boolean(options.headless);
    const configuredTimeout = options.timeout || 60000;
    const testTimeout = options.reuseContext ? Math.max(configuredTimeout, 180000) : configuredTimeout;
    fs.mkdirSync(path.dirname(jsonReportPath), { recursive: true });

    const configContent = `
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '${this.testsDir.replace(/\\/g, '\\\\')}',
  timeout: ${testTimeout},
  globalSetup: '${globalSetupPath.replace(/\\/g, '\\\\')}',
  use: {
    baseURL: '${(options.baseURL || '').replace(/\\/g, '\\\\')}',
    storageState: '${(options.authPath || '').replace(/\\/g, '\\\\')}',
    headless: ${headless},
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  reporter: [
    ['html', { outputFolder: '${reportDir.replace(/\\/g, '\\\\')}', open: 'never' }],
    ['json', { outputFile: '${jsonReportPath.replace(/\\/g, '\\\\')}' }]
  ],
  workers: 1,
});
`;

    fs.writeFileSync(configPath, configContent);
    return configPath;
  }

  generateGlobalSetup(options) {
    const globalSetupPath = path.join(this.projectDir, 'playwright.global-setup.js');
    const baseURL = (options.baseURL || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const authPath = (options.authPath || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const timeout = options.authReadyTimeout || options.timeout || 30000;
    const pollInterval = options.authPollIntervalMs || 5000;
    const expectedPath = (options.authReadyPath || '/home').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const headless = options.headless === undefined ? false : Boolean(options.headless);

    const setupContent = `
const { chromium } = require('playwright');

module.exports = async () => {
  const browser = await chromium.launch({ headless: ${headless} });

  try {
    const context = await browser.newContext({ storageState: '${authPath}' });
    const page = await context.newPage();
    const targetUrl = '${baseURL}';
    const expectedPath = '${expectedPath}';
    const firstHomeDialogCloseButtonSelector = 'body > dialog.ModalDialogBox_dialogBox__8_dsu.undefined > div > div.ContentWithBottomActions_bottomActionsContents__w8Vlw > button';
    const firstHomeDialogCloseImageSelector = 'body > dialog.ModalDialogBox_dialogBox__8_dsu.undefined > div > div.ContentWithBottomActions_bottomActionsContents__w8Vlw > button > img';
    const genericHomeDialogSelector = 'dialog.ModalDialogBox_dialogBox__8_dsu';
    const openDialogOkSelector = 'dialog[open] button:has-text("OK")';
    const timeoutMs = ${timeout};
    const pollIntervalMs = ${pollInterval};
    const deadline = Date.now() + timeoutMs;

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    while (Date.now() < deadline) {
      const currentUrl = page.url();
      let currentPath = '';

      try {
        currentPath = new URL(currentUrl).pathname;
      } catch {
        currentPath = currentUrl;
      }

      if (currentPath.includes(expectedPath)) {
        try {
          const closeButton = page.locator(firstHomeDialogCloseButtonSelector).first();
          if (await closeButton.count() > 0) {
            await closeButton.click({ timeout: 5000, force: true });
          } else {
            await page.locator(firstHomeDialogCloseImageSelector).first().click({ timeout: 5000, force: true });
          }
          await page.waitForTimeout(500);
        } catch {
        }

        for (let i = 0; i < 5; i += 1) {
          try {
            const genericDialog = page.locator(genericHomeDialogSelector).first();
            if (await genericDialog.count() === 0) {
              break;
            }
            const dialogButton = genericDialog.locator('button').last();
            if (await dialogButton.count() > 0) {
              await dialogButton.click({ timeout: 3000, force: true });
              await page.waitForTimeout(250);
              continue;
            }
            break;
          } catch {
            break;
          }
        }

        for (let i = 0; i < 3; i += 1) {
          try {
            const okButton = page.locator(openDialogOkSelector).first();
            if (await okButton.count() === 0) {
              break;
            }
            await okButton.click({ timeout: 3000, force: true });
            await page.waitForTimeout(300);
          } catch {
            break;
          }
        }

        await page.evaluate(() => {
          const dialogs = Array.from(document.querySelectorAll('dialog.ModalDialogBox_dialogBox__8_dsu'));
          for (const dialog of dialogs) {
            if (typeof dialog.close === 'function') {
              dialog.close();
            }
            dialog.removeAttribute('open');
          }
          const overlays = Array.from(document.querySelectorAll('[class*="TapAreaOverlay_blockingOverlay"]'));
          for (const overlay of overlays) {
            overlay.remove();
          }
        });

        try {
          await context.storageState({ path: '${authPath}', indexedDB: true });
        } catch {
          await context.storageState({ path: '${authPath}' });
        }
        return;
      }

      const remaining = Math.max(0, deadline - Date.now());
      if (remaining === 0) {
        break;
      }

      await page.waitForTimeout(Math.min(pollIntervalMs, remaining));
    }

    throw new Error(
      '認証エラー: 認証済みURLへの到達確認に失敗しました。' +
      '期待パス=' + expectedPath + ' / 現在URL=' + page.url() +
      '。playwright-regression auth を再実行してください。'
    );
  } finally {
    await browser.close();
  }
};
`;

    fs.writeFileSync(globalSetupPath, setupContent);
    return globalSetupPath;
  }
}

module.exports = { TestExecutor };
