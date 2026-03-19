const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  createProgram,
  resolveAuthVerification,
  loadSelectorCatalog,
  resolveRunFilterIds,
  resolveRunInvocation,
} = require('../bin/cli');
const { TestExecutor } = require('../lib/test-executor');

describe('CLI', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('initコマンドで設定ファイルとディレクトリが作成される', async () => {
    const program = createProgram(tmpDir);
    program.exitOverride();

    await program.parseAsync(['node', 'playwright-regression', 'init', '--skip-browsers']);

    expect(fs.existsSync(path.join(tmpDir, 'config', 'config.json'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'storage'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, 'tests'))).toBe(true);

    const config = JSON.parse(fs.readFileSync(path.join(tmpDir, 'config', 'config.json'), 'utf-8'));
    expect(config.anthropic.apiKey).toBe('YOUR_API_KEY_HERE');
    expect(config.anthropic.model).toBe('claude-sonnet-4-5-20250929');
    expect(config.testUrl).toBeDefined();
  });

  test('initコマンドで既存の設定ファイルは上書きしない', async () => {
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ custom: true }));

    const program = createProgram(tmpDir);
    program.exitOverride();

    await program.parseAsync(['node', 'playwright-regression', 'init', '--skip-browsers']);

    const config = JSON.parse(fs.readFileSync(path.join(configDir, 'config.json'), 'utf-8'));
    expect(config.custom).toBe(true);
  });

  test('設定ファイルがない状態でgenerateを呼ぶとエラー', async () => {
    const program = createProgram(tmpDir);
    program.exitOverride();

    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

    await program.parseAsync(['node', 'playwright-regression', 'generate', 'test.csv']);

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining('設定ファイルが見つかりません')
    );

    consoleSpy.mockRestore();
  });

  test('loadConfig は環境変数 ANTHROPIC_API_KEY を優先する', async () => {
    const configDir = path.join(tmpDir, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({
      anthropic: { apiKey: 'file-key', model: 'claude-sonnet-4-5-20250929' },
      playwright: { headless: false, timeout: 30000 },
      testUrl: 'https://example.com',
    }));

    const originalEnv = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'env-key';

    try {
      const { loadConfig } = require('../bin/cli');
      const config = loadConfig(tmpDir);
      expect(config.anthropic.apiKey).toBe('env-key');
    } finally {
      if (originalEnv === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalEnv;
      }
    }
  });

  test('resolveAuthVerification は config の設定を使う', () => {
    const verification = resolveAuthVerification({
      authVerification: {
        enabled: true,
        urlIncludes: '/home',
        visibleSelectors: ['[data-testid="hero-home"]'],
        timeoutMs: 12000,
        pollIntervalMs: 5000,
      },
    }, {});

    expect(verification.enabled).toBe(true);
    expect(verification.urlIncludes).toBe('/home');
    expect(verification.visibleSelectors).toEqual(['[data-testid="hero-home"]']);
    expect(verification.timeoutMs).toBe(12000);
    expect(verification.pollIntervalMs).toBe(5000);
  });

  test('resolveAuthVerification は CLI オプションを優先する', () => {
    const verification = resolveAuthVerification(
      { authVerification: { enabled: true, urlIncludes: '/old', visibleSelectors: ['.old'] } },
      { checkUrl: '/home', checkSelector: ['[data-testid="new"]'], checkTimeout: 5000, checkInterval: 4000 }
    );

    expect(verification.enabled).toBe(true);
    expect(verification.urlIncludes).toBe('/home');
    expect(verification.visibleSelectors).toEqual(['[data-testid="new"]']);
    expect(verification.timeoutMs).toBe(5000);
    expect(verification.pollIntervalMs).toBe(4000);
  });

  test('resolveAuthVerification は skip 指定で無効化する', () => {
    const verification = resolveAuthVerification(
      { authVerification: { enabled: true, urlIncludes: '/home', visibleSelectors: ['.x'] } },
      { skipCheck: true }
    );
    expect(verification.enabled).toBe(false);
  });

  test('loadSelectorCatalog は既定パスの JSON を読み込む', () => {
    const storageDir = path.join(tmpDir, 'storage');
    fs.mkdirSync(storageDir, { recursive: true });
    const catalog = { pages: [{ path: '/home', selectors: [] }] };
    fs.writeFileSync(path.join(storageDir, 'selectors.json'), JSON.stringify(catalog));

    const loaded = loadSelectorCatalog(tmpDir);
    expect(loaded.pages[0].path).toBe('/home');
  });

  test('run --from で指定ID以降の順序を取得できる', () => {
    const testsDir = path.join(tmpDir, 'tests');
    fs.mkdirSync(testsDir, { recursive: true });
    fs.writeFileSync(path.join(testsDir, '1.spec.ts'), '');
    fs.writeFileSync(path.join(testsDir, '2.spec.ts'), '');
    fs.writeFileSync(path.join(testsDir, '10.spec.ts'), '');

    const executor = new TestExecutor(testsDir, tmpDir);
    const ids = executor.listTestFiles().map((f) => f.replace('.spec.ts', ''));
    const fromIndex = ids.indexOf('2');

    expect(fromIndex).toBeGreaterThanOrEqual(0);
    expect(ids.slice(fromIndex)).toEqual(['2', '10']);
  });

  test('resolveRunFilterIds は --scenario 未指定引数で全件を返す', () => {
    const executor = {
      listTestFiles: () => ['1.spec.ts', '2.spec.ts', '3.spec.ts'],
    };

    const resolved = resolveRunFilterIds(executor, [], { scenario: true });
    expect(resolved).toEqual(['1', '2', '3']);
  });

  test('resolveRunFilterIds は --scenario のID順を維持する', () => {
    const executor = {
      listTestFiles: () => ['1.spec.ts', '2.spec.ts', '3.spec.ts'],
    };

    const resolved = resolveRunFilterIds(executor, [], { scenario: '3,1' });
    expect(resolved).toEqual(['3', '1']);
  });

  test('resolveRunFilterIds は --scenario の未知IDでエラー', () => {
    const executor = {
      listTestFiles: () => ['1.spec.ts', '2.spec.ts', '3.spec.ts'],
    };

    expect(() => resolveRunFilterIds(executor, [], { scenario: '2,99' })).toThrow(
      'scenario に存在しないテストIDがあります: 99'
    );
  });

  test('resolveRunInvocation は末尾 slack を通知指定として扱う', () => {
    const resolved = resolveRunInvocation(['purchase', 'slack'], {});
    expect(resolved.testIds).toEqual(['purchase']);
    expect(resolved.slackRequested).toBe(true);
  });

  test('resolveRunInvocation は --slack 指定を優先する', () => {
    const resolved = resolveRunInvocation(['purchase'], { slack: true });
    expect(resolved.testIds).toEqual(['purchase']);
    expect(resolved.slackRequested).toBe(true);
  });
});
