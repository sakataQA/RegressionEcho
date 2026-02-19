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

    const isAndroid = options.deviceProfile === 'android';
    let runtime = { testDir: this.testsDir, testFiles, env: {}, cleanup: null };

    if (isAndroid) {
      // (1) adb 事前チェック — 端末が見つからなければここで明確なエラーを出す
      this.checkAdbDevice(options.androidSerial);
      // (2) 前回の強制終了等で残存した tmp ディレクトリを一掃する
      this.cleanStaleTmpDirs();
      runtime = this.prepareAndroidTestBundle(testFiles, options);
      console.log('Android実機モードで実行します（Playwright _android API）。');
    }

    const configPath = this.generatePlaywrightConfig(options, {
      testDir: runtime.testDir,
      disableGlobalSetup: isAndroid,
    });
    const filePaths = runtime.testFiles.map((f) => path.join(runtime.testDir, f)).join(' ');
    const cmd = `npx playwright test ${filePaths} --config=${configPath}`;
    const env = {
      ...process.env,
      ...runtime.env,
      ...(options.reuseContext ? { PW_TEST_REUSE_CONTEXT: '1' } : {}),
    };

    console.log('テストを実行中...\n');

    // (3) Android 実行中に Ctrl+C / SIGTERM で中断されても tmp を必ず消す
    //     - process.once で登録 → シグナル発火後は自動解除（二重登録なし）
    //     - SIGINT/SIGTERM は別ハンドラで定義し、各自が再送するシグナル名を保持
    //     - finally で必ず removeListener → 正常終了時にリスナーが残らない
    let cleanupDone = false;
    const doCleanup = () => {
      if (!cleanupDone && typeof runtime.cleanup === 'function') {
        cleanupDone = true;
        runtime.cleanup();
      }
    };
    // シグナルハンドラは Android 実行時のみ定義・登録する
    let sigintHandler = null;
    let sigtermHandler = null;
    if (isAndroid) {
      sigintHandler = () => {
        doCleanup();
        // once で登録しているため SIGINT は自動解除済み。SIGTERM 側だけ手動解除。
        process.removeListener('SIGTERM', sigtermHandler);
        process.kill(process.pid, 'SIGINT');
      };
      sigtermHandler = () => {
        doCleanup();
        process.removeListener('SIGINT', sigintHandler);
        process.kill(process.pid, 'SIGTERM');
      };
      process.once('SIGINT', sigintHandler);
      process.once('SIGTERM', sigtermHandler);
    }

    try {
      childProcess.execSync(cmd, { cwd: this.projectDir, stdio: 'inherit', env });
      return { exitCode: 0, testCount: testFiles.length };
    } catch (error) {
      return { exitCode: error.status || 1, testCount: testFiles.length };
    } finally {
      // 正常終了・例外終了いずれでも必ず解除する（once 発火済みなら no-op）
      if (isAndroid) {
        process.removeListener('SIGINT', sigintHandler);
        process.removeListener('SIGTERM', sigtermHandler);
      }
      doCleanup();
    }
  }

  /**
   * adb コマンドで接続済みデバイスを確認する。
   * Android 実行前の事前チェックとして呼び出す。
   * PC 実行（isAndroid=false）では一切呼ばれない。
   */
  checkAdbDevice(serial) {
    let adbOutput;
    try {
      adbOutput = childProcess.execSync('adb devices', { encoding: 'utf-8', timeout: 10000 });
    } catch {
      throw new Error(
        'adb コマンドの実行に失敗しました。Android SDK の adb が PATH に含まれているか確認してください。'
      );
    }

    // 先頭行「List of devices attached」を除いた各行をパース
    const deviceLines = adbOutput
      .split('\n')
      .slice(1)
      .map((line) => {
        const parts = line.split('\t');
        return parts.length >= 2
          ? { serial: parts[0].trim(), state: parts[1].trim() }
          : null;
      })
      .filter(Boolean)
      .filter((d) => d.serial.length > 0);

    // offline / unauthorized は明示エラー（device 状態のみ通す）
    const offlineDevices = deviceLines.filter((d) => d.state === 'offline').map((d) => d.serial);
    const unauthorizedDevices = deviceLines.filter((d) => d.state === 'unauthorized').map((d) => d.serial);
    const readyDevices = deviceLines.filter((d) => d.state === 'device').map((d) => d.serial);

    if (offlineDevices.length > 0) {
      throw new Error(
        `次のデバイスが offline 状態です: ${offlineDevices.join(', ')}\n` +
        '・USBケーブルを接続し直してください\n' +
        '・adb kill-server && adb start-server を試してください'
      );
    }

    if (unauthorizedDevices.length > 0) {
      throw new Error(
        `次のデバイスが unauthorized 状態です: ${unauthorizedDevices.join(', ')}\n` +
        '・端末画面に表示された「USBデバッグを許可しますか？」を承認してください'
      );
    }

    if (readyDevices.length === 0) {
      throw new Error(
        'USB 接続済みの Android デバイスが見つかりません。\n' +
        '・USBケーブルを接続してください\n' +
        '・端末の「USBデバッグ」を有効にしてください\n' +
        '・ターミナルで adb devices を実行して確認してください'
      );
    }

    // --android-serial 指定時はそのシリアルのみ検証
    if (serial && !readyDevices.includes(serial)) {
      throw new Error(
        `指定したシリアル "${serial}" が ready 状態のデバイス一覧に見つかりません。\n` +
        `ready 状態のデバイス: ${readyDevices.join(', ')}`
      );
    }

    return readyDevices;
  }

  /**
   * 前回の強制終了等で残った .regression-echo-tmp/android-* を削除する。
   * Android 実行前にのみ呼ばれる。PC 実行には影響しない。
   */
  cleanStaleTmpDirs(ttlMs = 24 * 60 * 60 * 1000) {
    const tempRoot = path.join(this.projectDir, '.regression-echo-tmp');
    if (!fs.existsSync(tempRoot)) return;

    // 削除対象は .regression-echo-tmp/android-* のみ。他ディレクトリは触らない。
    const entries = fs.readdirSync(tempRoot).filter((e) => e.startsWith('android-'));
    const now = Date.now();

    for (const entry of entries) {
      const entryPath = path.join(tempRoot, entry);
      let stat;
      try {
        stat = fs.statSync(entryPath);
      } catch {
        continue; // stat 取得失敗はスキップ
      }

      // TTL（デフォルト 24 時間）を超えた古いディレクトリのみ削除
      const ageMs = now - stat.mtimeMs;
      if (ageMs < ttlMs) continue;

      try {
        fs.rmSync(entryPath, { recursive: true, force: true });
      } catch {
        // 削除失敗は無視して続行（アクセス権限問題等）
      }
    }
  }

  prepareAndroidTestBundle(testFiles, options) {
    const tempRoot = path.join(this.projectDir, '.regression-echo-tmp');
    fs.mkdirSync(tempRoot, { recursive: true });
    const tempDir = fs.mkdtempSync(path.join(tempRoot, 'android-'));
    const allFiles = fs.readdirSync(this.testsDir).filter((f) => f.endsWith('.ts'));

    for (const fileName of allFiles) {
      const srcPath = path.join(this.testsDir, fileName);
      const dstPath = path.join(tempDir, fileName);
      const content = fs.readFileSync(srcPath, 'utf-8');
      const patched = content.replace(
        /from\s+['"]@playwright\/test['"]/g,
        "from './android-playwright-test'"
      );
      fs.writeFileSync(dstPath, patched, 'utf-8');
    }

    fs.writeFileSync(
      path.join(tempDir, 'android-playwright-test.ts'),
      this.generateAndroidFixtureModule(),
      'utf-8'
    );

    const env = {
      PW_ANDROID_AUTH_PATH: options.authPath || '',
      PW_ANDROID_BASE_URL: options.baseURL || '',
      ...(options.androidSerial ? { PW_ANDROID_SERIAL: options.androidSerial } : {}),
    };

    return {
      testDir: tempDir,
      testFiles,
      env,
      cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
    };
  }

  generateAndroidFixtureModule() {
    return `import * as base from '@playwright/test';
import * as fs from 'fs';
import { _android as android } from 'playwright';

type AuthState = {
  cookies?: Array<Record<string, unknown>>;
  origins?: Array<{
    origin: string;
    localStorage?: Array<{ name: string; value: string }>;
  }>;
};

function loadAuthState(): AuthState {
  const authPath = process.env.PW_ANDROID_AUTH_PATH;
  if (!authPath) return {};
  if (!fs.existsSync(authPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(authPath, 'utf-8')) as AuthState;
  } catch {
    return {};
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(label + ' timeout (' + timeoutMs + 'ms)'));
    }, timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

const test = base.test.extend({
  androidDevice: [async ({}, use) => {
    const devices = await android.devices();
    if (!devices.length) {
      throw new Error('Android実機が見つかりません。USB接続とadb devicesを確認してください。');
    }

    const requestedSerial = process.env.PW_ANDROID_SERIAL;
    const selected = requestedSerial
      ? devices.find((d) => {
          const serial = typeof (d as any).serial === 'function' ? (d as any).serial() : (d as any).serial;
          return String(serial) === requestedSerial;
        })
      : devices[0];

    if (!selected) {
      throw new Error('指定したAndroidシリアルが見つかりません: ' + requestedSerial);
    }

    await use(selected);
    await selected.close();
  }, { scope: 'worker' }],

  authState: [async ({}, use) => {
    await use(loadAuthState());
  }, { scope: 'worker' }],

  context: [async ({ androidDevice, authState }: any, use: any) => {
    console.log('[android] context setup start');

    // Step 1: 画面ウェイクアップ・ロック解除
    try {
      await androidDevice.shell('input keyevent KEYCODE_WAKEUP');
      await androidDevice.shell('wm dismiss-keyguard');
      console.log('[android] device wakeup done');
    } catch {
      console.log('[android] device wakeup skipped');
    }

    // Step 2: Chrome を完全停止する
    // launchBrowser() が DevTools フラグ付きで Chrome を自分で起動するため、
    // ここでは am start を呼ばない。手動で start すると DevTools なしで
    // Chrome が先に掴まれてしまい launchBrowser() が接続できなくなる。
    try {
      await androidDevice.shell('am force-stop com.android.chrome');
      await new Promise((r) => setTimeout(r, 1500));
      console.log('[android] Chrome stopped, ready for launchBrowser');
    } catch {
      console.log('[android] Chrome stop skipped');
    }

    // Step 3: launchBrowser() を最大 4 回、指数バックオフでリトライ
    // Playwright がデバッグフラグ付きで Chrome を起動 → DevTools ソケット確立 → CDP 接続
    // という一連の処理を行うため、初回は少し遅い場合がある。
    const RETRY_DELAYS = [0, 5000, 10000, 15000];
    let context: any;
    let lastError: any;

    for (let attempt = 0; attempt < RETRY_DELAYS.length; attempt++) {
      if (RETRY_DELAYS[attempt] > 0) {
        console.log(\`[android] launchBrowser retry \${attempt}/\${RETRY_DELAYS.length - 1}, waiting \${RETRY_DELAYS[attempt]}ms...\`);
        // リトライ前に Chrome を再停止してクリーンな状態にする
        try {
          await androidDevice.shell('am force-stop com.android.chrome');
          await new Promise((r) => setTimeout(r, 1000));
        } catch {}
        await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt] - 1000));
      }
      try {
        context = await withTimeout(
          androidDevice.launchBrowser(),
          45000,
          \`android.launchBrowser(attempt \${attempt + 1})\`
        );
        console.log(\`[android] launchBrowser ok (attempt \${attempt + 1})\`);
        break;
      } catch (err: any) {
        lastError = err;
        console.log(\`[android] launchBrowser attempt \${attempt + 1} failed: \${err?.message ?? err}\`);
      }
    }

    if (!context) {
      throw new Error(
        'Android browser context の起動に失敗しました（4 回試行）。\\n' +
        '以下を確認してください:\\n' +
        '・端末がアンロックされているか\\n' +
        '・USB デバッグが有効か（開発者向けオプション）\\n' +
        '・adb kill-server && adb start-server を試す\\n' +
        '・Chrome を一度手動で開いて閉じてから再実行する\\n' +
        '最終エラー: ' + (lastError?.message ?? String(lastError))
      );
    }

    if (Array.isArray(authState.cookies) && authState.cookies.length > 0) {
      try {
        await context.addCookies(authState.cookies as any);
        console.log('[android] cookies restored');
      } catch {
      }
    }

    if (Array.isArray(authState.origins) && authState.origins.length > 0) {
      await context.addInitScript((origins: any[]) => {
        try {
          const originState = origins.find((o) => o && o.origin === window.location.origin);
          if (!originState || !Array.isArray(originState.localStorage)) return;
          for (const item of originState.localStorage) {
            if (!item || typeof item.name !== 'string') continue;
            localStorage.setItem(item.name, String(item.value ?? ''));
          }
        } catch {
        }
      }, authState.origins);
    }

    await use(context);
    await context.close();
    console.log('[android] context closed');
  }, { timeout: 180000 }],

  page: [async ({ context, androidDevice }: any, use: any) => {
    const initialUrl = process.env.PW_ANDROID_BASE_URL;
    if (!initialUrl) {
      const p = context.pages()[0] || await context.newPage();
      await use(p);
      return;
    }

    // URL が実際のページかを判定するヘルパー
    // about:blank / chrome:// (NTP 等) は「未遷移」とみなす
    const isRealUrl = (url: string) =>
      Boolean(url) && !url.startsWith('about:') && !url.startsWith('chrome://');

    // launchBrowser() 直後は既存タブがある場合があるのでそちらを優先利用する
    const managedPage = context.pages()[0] || await context.newPage();

    // ── Phase 1: goto with 'commit' を最大 3 回リトライ ──────────────────
    // 'domcontentloaded' は about:blank でも即座に発火するため 'commit' を使う。
    // 'commit' は URL が target に切り替わった瞬間だけを待つので
    // Android Chrome のタイミング問題を回避できる。
    let navigated = false;
    for (let attempt = 0; attempt < 3 && !navigated; attempt++) {
      try {
        await managedPage.goto(initialUrl, { waitUntil: 'commit', timeout: 30000 });
      } catch {
        // commit タイムアウトでも URL が変わっている場合があるので落ちさせない
      }
      if (isRealUrl(String(managedPage.url() || ''))) {
        navigated = true;
      } else if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }

    // ── Phase 2: JS location.href フォールバック ─────────────────────────
    // goto が応答しないケースでも Chrome 内部のナビゲーションは動くことがある
    if (!navigated) {
      try {
        await managedPage.evaluate((url: string) => { window.location.href = url; }, initialUrl);
        await managedPage.waitForURL(
          (url) => isRealUrl(url.toString()),
          { timeout: 20000 }
        );
        navigated = true;
      } catch {
      }
    }

    // ── Phase 3: adb am start VIEW インテント ────────────────────────────
    // am start は既存タブを遷移させる場合と新タブを開く場合がある。
    // 既存の managedPage の URL 変化と、context の新ページ出現を
    // Promise.race で両方監視し、勝者を capturedPage に保持する。
    let capturedPage: any = null;
    if (!navigated) {
      try {
        const escapedUrl = initialUrl.replace(/"/g, '\\\\"');
        await androidDevice.shell(\`am start -a android.intent.action.VIEW -d "\${escapedUrl}" com.android.chrome\`);
      } catch {
      }

      await Promise.race([
        managedPage
          .waitForURL((url) => isRealUrl(url.toString()), { timeout: 25000 })
          .then(() => {
            navigated = true;
            capturedPage = managedPage;
          })
          .catch(() => {}),
        context
          .waitForEvent('page', { timeout: 25000 })
          .then(async (newPage: any) => {
            try {
              await newPage.waitForURL(
                (url: URL) => isRealUrl(url.toString()),
                { timeout: 15000 }
              );
            } catch {
            }
            // 新タブ側が勝った場合もキャプチャ（まだ navigated でなければ採用）
            if (!capturedPage) {
              navigated = true;
              capturedPage = newPage;
            }
          })
          .catch(() => {}),
      ]);
    }

    // ── 最終的に使用するページを決定 ────────────────────────────────────
    // Phase 1/2 で遷移済み → managedPage
    // Phase 3 で race に勝ったページ → capturedPage
    // いずれもなければ context.pages() から非ブランクを探すフォールバック
    let selectedPage: any = capturedPage ?? null;
    if (!selectedPage) {
      if (isRealUrl(String(managedPage.url() || ''))) {
        selectedPage = managedPage;
      } else {
        const allPages: any[] = context.pages();
        selectedPage = allPages.find((p) => isRealUrl(String(p.url() || ''))) ?? null;
      }
    }

    if (!selectedPage) {
      const urls = context.pages().map((p: any) => String(p.url() || '')).join(', ');
      throw new Error(
        'Android実機で初期URLを開けませんでした。\\n' +
        '現在のページURL: ' + urls + '\\n' +
        '端末のアンロック状態・Chrome の起動状態を確認してください。'
      );
    }

    try {
      await selectedPage.bringToFront();
      await selectedPage.waitForLoadState('domcontentloaded', { timeout: 15000 });
    } catch {
    }

    await use(selectedPage);
  }, { timeout: 180000 }],
});

export { test };
export const expect = base.expect;
export const request = base.request;
`;
  }

  generatePlaywrightConfig(options, runtime = {}) {
    const configPath = path.join(this.projectDir, 'playwright.config.js');
    const reportDir = path.join(this.projectDir, 'playwright-report');
    const testDir = runtime.testDir || this.testsDir;
    const disableGlobalSetup = Boolean(runtime.disableGlobalSetup);
    const globalSetupPath = disableGlobalSetup ? null : this.generateGlobalSetup(options);
    const headless = options.headless === undefined ? false : Boolean(options.headless);
    const isAndroid = options.deviceProfile === 'android';
    const configuredTimeout = options.timeout || 60000;
    const testTimeoutBase = options.reuseContext ? Math.max(configuredTimeout, 180000) : configuredTimeout;
    const testTimeout = isAndroid ? Math.max(testTimeoutBase, 120000) : testTimeoutBase;

    const configContent = `
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '${testDir.replace(/\\/g, '\\\\')}',
  timeout: ${testTimeout},
${globalSetupPath ? `  globalSetup: '${globalSetupPath.replace(/\\/g, '\\\\')}',` : ''}
  use: {
    baseURL: '${(options.baseURL || '').replace(/\\/g, '\\\\')}',
    storageState: '${(options.authPath || '').replace(/\\/g, '\\\\')}',
    headless: ${headless},
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  reporter: [['html', { outputFolder: '${reportDir.replace(/\\/g, '\\\\')}', open: 'never' }]],
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
