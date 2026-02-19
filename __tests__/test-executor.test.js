const path = require('path');
const fs = require('fs');
const os = require('os');
const { TestExecutor } = require('../lib/test-executor');

describe('test-executor', () => {
  let tmpDir;
  let testsDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'executor-test-'));
    testsDir = path.join(tmpDir, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('テストファイルの一覧を取得できる', () => {
    fs.writeFileSync(path.join(testsDir, 'TC001.spec.ts'), 'test code');
    fs.writeFileSync(path.join(testsDir, 'TC002.spec.ts'), 'test code');
    fs.writeFileSync(path.join(testsDir, 'README.md'), 'not a test');

    const executor = new TestExecutor(testsDir, tmpDir);
    const files = executor.listTestFiles();

    expect(files).toHaveLength(2);
    expect(files).toContain('TC001.spec.ts');
    expect(files).toContain('TC002.spec.ts');
  });

  test('テストIDでフィルタリングできる', () => {
    fs.writeFileSync(path.join(testsDir, 'TC001.spec.ts'), 'test code');
    fs.writeFileSync(path.join(testsDir, 'TC002.spec.ts'), 'test code');
    fs.writeFileSync(path.join(testsDir, 'TC003.spec.ts'), 'test code');

    const executor = new TestExecutor(testsDir, tmpDir);
    const files = executor.listTestFiles(['TC001', 'TC003']);

    expect(files).toHaveLength(2);
    expect(files).toContain('TC001.spec.ts');
    expect(files).toContain('TC003.spec.ts');
  });

  test('フィルタ指定順を維持できる', () => {
    fs.writeFileSync(path.join(testsDir, '1.spec.ts'), 'test code');
    fs.writeFileSync(path.join(testsDir, '2.spec.ts'), 'test code');
    fs.writeFileSync(path.join(testsDir, '3.spec.ts'), 'test code');

    const executor = new TestExecutor(testsDir, tmpDir);
    const files = executor.listTestFiles(['3', '1']);

    expect(files).toEqual(['3.spec.ts', '1.spec.ts']);
  });

  test('テストディレクトリが空の場合は空配列', () => {
    const executor = new TestExecutor(testsDir, tmpDir);
    const files = executor.listTestFiles();
    expect(files).toHaveLength(0);
  });

  test('Playwrightコマンドを正しく構築できる', () => {
    const executor = new TestExecutor(testsDir, tmpDir);
    const authPath = path.join(tmpDir, 'storage', 'auth.json');
    const reportDir = path.join(tmpDir, 'playwright-report');

    const cmd = executor.buildCommand(['TC001.spec.ts', 'TC002.spec.ts'], {
      authPath,
      reportDir,
      timeout: 30000,
    });

    expect(cmd).toContain('npx playwright test');
    expect(cmd).toContain('TC001.spec.ts');
    expect(cmd).toContain('TC002.spec.ts');
  });

  test('run時にreuseContext=trueなら環境変数を付与する', async () => {
    fs.writeFileSync(path.join(testsDir, '1.spec.ts'), 'test code');

    const childProcess = require('child_process');
    const execSpy = jest.spyOn(childProcess, 'execSync').mockImplementation(() => Buffer.from(''));

    try {
      const executor = new TestExecutor(testsDir, tmpDir);
      await executor.run(undefined, {
        authPath: path.join(tmpDir, 'storage', 'auth.json'),
        timeout: 30000,
        baseURL: 'https://development.pocket-heroes.net/home',
        reuseContext: true,
      });

      expect(execSpy).toHaveBeenCalled();
      // PW_TEST_REUSE_CONTEXT=1 はコマンド文字列ではなく env オブジェクト経由で渡す
      const callOptions = execSpy.mock.calls[0][1];
      expect(callOptions.env).toHaveProperty('PW_TEST_REUSE_CONTEXT', '1');
    } finally {
      execSpy.mockRestore();
    }
  });

  test('Playwright設定にbaseURLが含まれる', () => {
    const executor = new TestExecutor(testsDir, tmpDir);
    const authPath = path.join(tmpDir, 'storage', 'auth.json');

    const configPath = executor.generatePlaywrightConfig({
      authPath,
      timeout: 30000,
      baseURL: 'https://hotel-example-site.takeyaqa.dev/ja/reserve.html',
    });

    const configContent = fs.readFileSync(configPath, 'utf-8');
    expect(configContent).toContain('https://hotel-example-site.takeyaqa.dev/ja/reserve.html');
    expect(configContent).toContain('baseURL');
    expect(configContent).toContain('globalSetup');
    expect(configContent).toContain('headless: false');

    const globalSetupPath = path.join(tmpDir, 'playwright.global-setup.js');
    expect(fs.existsSync(globalSetupPath)).toBe(true);
    const globalSetupContent = fs.readFileSync(globalSetupPath, 'utf-8');
    expect(globalSetupContent).toContain('pollIntervalMs = 5000');
    expect(globalSetupContent).toContain('firstHomeDialogCloseButtonSelector');
    expect(globalSetupContent).toContain('genericHomeDialogSelector');
    expect(globalSetupContent).toContain('openDialogOkSelector');
    expect(globalSetupContent).toContain('context.storageState({ path:');
  });

  test('globalSetupに認証到達パスとポーリング間隔を反映できる', () => {
    const executor = new TestExecutor(testsDir, tmpDir);
    const authPath = path.join(tmpDir, 'storage', 'auth.json');

    executor.generatePlaywrightConfig({
      authPath,
      timeout: 30000,
      baseURL: 'https://development.pocket-heroes.net/home',
      authReadyPath: '/home',
      authPollIntervalMs: 5000,
      authReadyTimeout: 45000,
      headless: true,
    });

    const globalSetupPath = path.join(tmpDir, 'playwright.global-setup.js');
    const globalSetupContent = fs.readFileSync(globalSetupPath, 'utf-8');
    expect(globalSetupContent).toContain("const expectedPath = '/home'");
    expect(globalSetupContent).toContain('const pollIntervalMs = 5000');
    expect(globalSetupContent).toContain('const timeoutMs = 45000');
    expect(globalSetupContent).toContain('dialog.ModalDialogBox_dialogBox__8_dsu.undefined');
    expect(globalSetupContent).toContain('chromium.launch({ headless: true })');
  });
});
