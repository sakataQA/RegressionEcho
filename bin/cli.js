#!/usr/bin/env node

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const { AuthManager } = require('../lib/auth');
const { readTestCases } = require('../lib/csv-reader');
const { ClaudeClient } = require('../lib/claude-client');
const { TestGenerator } = require('../lib/test-generator');
const { TestExecutor } = require('../lib/test-executor');
const { DomScanner } = require('../lib/dom-scanner');

const CONFIG_TEMPLATE = {
  anthropic: {
    apiKey: 'YOUR_API_KEY_HERE',
    model: 'claude-sonnet-4-5-20250929',
  },
  playwright: {
    headless: false,
    timeout: 30000,
  },
  testUrl: 'https://your-test-environment.example.com',
  authVerification: {
    enabled: false,
    urlIncludes: '',
    visibleSelectors: [],
    timeoutMs: 15000,
    pollIntervalMs: 5000,
  },
};

function loadConfig(projectDir) {
  const configPath = path.join(projectDir, 'config', 'config.json');
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  if (process.env.ANTHROPIC_API_KEY) {
    config.anthropic.apiKey = process.env.ANTHROPIC_API_KEY;
  }
  return config;
}

function loadSelectorCatalog(projectDir, selectorsOptionPath) {
  const defaultPath = path.join(projectDir, 'storage', 'selectors.json');
  const selectorPath = selectorsOptionPath
    ? path.resolve(projectDir, selectorsOptionPath)
    : defaultPath;

  if (!fs.existsSync(selectorPath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(selectorPath, 'utf-8'));
}

function resolveAuthVerification(config, options = {}) {
  if (options.skipCheck) {
    return { enabled: false };
  }

  const fromConfig = config.authVerification || {};
  const cliSelectors = options.checkSelector || [];
  const hasCliOverrides = Boolean(options.checkUrl) || cliSelectors.length > 0 || options.checkTimeout || options.checkInterval;

  const merged = hasCliOverrides
    ? {
        enabled: true,
        urlIncludes: options.checkUrl || '',
        visibleSelectors: cliSelectors,
        timeoutMs: options.checkTimeout || fromConfig.timeoutMs || 15000,
        pollIntervalMs: options.checkInterval || fromConfig.pollIntervalMs || 5000,
      }
    : {
        enabled: Boolean(fromConfig.enabled),
        urlIncludes: fromConfig.urlIncludes || '',
        visibleSelectors: Array.isArray(fromConfig.visibleSelectors) ? fromConfig.visibleSelectors : [],
        timeoutMs: fromConfig.timeoutMs || 15000,
        pollIntervalMs: fromConfig.pollIntervalMs || 5000,
      };

  if (merged.enabled && !merged.urlIncludes && merged.visibleSelectors.length === 0) {
    throw new Error(
      'エラー: 認証検証が有効ですが検証条件が未設定です\nconfig.authVerification か auth --check-url/--check-selector を設定してください'
    );
  }

  return merged;
}

function resolveRunFilterIds(executor, testIds = [], options = {}) {
  const allIds = executor.listTestFiles().map((f) => f.replace('.spec.ts', ''));

  if (testIds.length > 0) {
    return testIds;
  }

  if (options.scenario !== undefined) {
    if (typeof options.scenario === 'string' && options.scenario.trim().length > 0) {
      const scenarioIds = options.scenario
        .split(',')
        .map((id) => id.trim())
        .filter((id) => id.length > 0);

      const unknown = scenarioIds.filter((id) => !allIds.includes(id));
      if (unknown.length > 0) {
        throw new Error(`エラー: scenario に存在しないテストIDがあります: ${unknown.join(', ')}`);
      }

      return scenarioIds;
    }

    return allIds;
  }

  if (options.from) {
    const fromIndex = allIds.indexOf(options.from);
    if (fromIndex === -1) {
      throw new Error(`エラー: 指定したテストIDが見つかりません: ${options.from}\n候補: ${allIds.join(', ')}`);
    }
    return allIds.slice(fromIndex);
  }

  return undefined;
}

function createProgram(projectDir) {
  const program = new Command();

  program
    .name('playwright-regression')
    .description('リグレッションテストを効率化するCLIツール')
    .version('1.0.0');

  // init command
  program
    .command('init')
    .option('--skip-browsers', 'ブラウザインストールをスキップ')
    .description('プロジェクト初期化・設定ファイル生成')
    .action(async (opts) => {
      const configDir = path.join(projectDir, 'config');
      const configPath = path.join(configDir, 'config.json');

      // Create config file if not exists
      fs.mkdirSync(configDir, { recursive: true });
      if (!fs.existsSync(configPath)) {
        fs.writeFileSync(configPath, JSON.stringify(CONFIG_TEMPLATE, null, 2));
        console.log('✓ 設定ファイルを作成しました: config/config.json');
      } else {
        console.log('設定ファイルは既に存在します: config/config.json');
      }

      // Create directories
      fs.mkdirSync(path.join(projectDir, 'storage'), { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
      console.log('✓ ディレクトリを作成しました');

      // Playwright browser install
      if (!opts.skipBrowsers) {
        try {
          const { execSync } = require('child_process');
          execSync('npx playwright install chromium', { stdio: 'inherit' });
          console.log('✓ Playwrightブラウザをインストールしました');
        } catch {
          console.log('⚠ Playwrightブラウザのインストールをスキップしました');
        }
      }

      console.log('\n次のステップ:');
      console.log('1. config/config.json に Claude APIキーを設定してください');
      console.log('2. playwright-regression auth で認証状態を保存してください');
    });

  // auth command
  program
    .command('auth')
    .option('--check-url <substring>', '認証後URLに含まれるべき文字列（例: /home）')
    .option(
      '--check-selector <selector>',
      '認証後に表示されるべきセレクタ（複数指定可）',
      (value, previous) => [...previous, value],
      []
    )
    .option('--check-timeout <ms>', '認証検証のタイムアウト(ミリ秒)', (v) => Number(v))
    .option('--check-interval <ms>', 'URL確認のポーリング間隔(ミリ秒)', (v) => Number(v))
    .option('--skip-check', '認証検証をスキップ')
    .description('認証状態の保存')
    .action(async (options) => {
      const config = loadConfig(projectDir);
      if (!config) {
        console.error('エラー: 設定ファイルが見つかりません\nplaywright-regression init を実行してください');
        return;
      }

      let verificationOptions;
      try {
        verificationOptions = resolveAuthVerification(config, options);
      } catch (error) {
        console.error(error.message);
        return;
      }

      const auth = new AuthManager(path.join(projectDir, 'storage'));
      try {
        await auth.runAuthFlow(config.testUrl, verificationOptions);
      } catch (error) {
        console.error(error.message || error);
        console.error('\nヒント:');
        console.error('- セレクタを見直す: playwright-regression auth --check-url /home --check-selector "[正しいselector]"');
        console.error('- 一時的に検証を外す: playwright-regression auth --skip-check');
      }
    });

  // generate command
  program
    .command('generate')
    .argument('<csv>', 'テストケースCSVファイルパス')
    .option('--only <ids>', '特定のテストIDのみ生成（カンマ区切り）')
    .option('--selectors <path>', 'DOM実測セレクタカタログJSONのパス（省略時: storage/selectors.json）')
    .description('CSVからテストスクリプト生成')
    .action(async (csvFile, options) => {
      const config = loadConfig(projectDir);
      if (!config) {
        console.error('エラー: 設定ファイルが見つかりません\nplaywright-regression init を実行してください');
        return;
      }

      const filterIds = options.only ? options.only.split(',') : undefined;

      let testCases;
      try {
        testCases = await readTestCases(csvFile, filterIds);
      } catch (error) {
        console.error(error.message);
        return;
      }

      const claudeClient = new ClaudeClient(config.anthropic);
      const generator = new TestGenerator(claudeClient, path.join(projectDir, 'tests'));
      const selectorCatalog = loadSelectorCatalog(projectDir, options.selectors);
      const generationContext = selectorCatalog ? { selectorCatalog } : {};

      if (selectorCatalog) {
        console.log(`セレクタカタログを読み込みました: ${options.selectors || 'storage/selectors.json'}`);
      } else {
        console.log('セレクタカタログは未指定（または未検出）のため、LLMのみで生成します');
      }

      console.log('テストスクリプトを生成中...');
      const results = await generator.generate(testCases, config.testUrl, generationContext);

      let successCount = 0;
      for (const result of results) {
        if (result.success) {
          console.log(`✓ ${result.testId}.spec.ts を生成しました`);
          successCount++;
        } else {
          console.error(`✗ ${result.testId}.spec.ts の生成に失敗しました: ${result.error}`);
        }
      }

      console.log(`\n${successCount}件のテストスクリプトを生成しました。`);
      console.log('tests/ ディレクトリを確認してください。');
      console.log('\n次のステップ:');
      console.log('playwright-regression run でテストを実行してください');
    });

  // discover-selectors command
  program
    .command('discover-selectors')
    .argument('[paths...]', 'DOMを実測する対象パス（例: /home /shop）')
    .option('--output <path>', '出力先JSONパス（省略時: storage/selectors.json）')
    .option('--timeout <ms>', 'ページ遷移タイムアウト(ミリ秒)', (v) => Number(v), 15000)
    .description('認証済みブラウザでDOMを実測し、セレクタカタログを生成')
    .action(async (pathsArg, options) => {
      const config = loadConfig(projectDir);
      if (!config) {
        console.error('エラー: 設定ファイルが見つかりません\nplaywright-regression init を実行してください');
        return;
      }

      const auth = new AuthManager(path.join(projectDir, 'storage'));
      if (!auth.hasStoredAuth()) {
        console.error('エラー: 認証状態が見つかりません\nplaywright-regression auth を実行してください');
        return;
      }

      const scanPaths = pathsArg.length > 0 ? pathsArg : ['/home'];
      const outputPath = options.output
        ? path.resolve(projectDir, options.output)
        : path.join(projectDir, 'storage', 'selectors.json');

      const scanner = new DomScanner(outputPath);
      const catalog = await scanner.scan({
        baseUrl: config.testUrl,
        authPath: auth.getAuthPath(),
        paths: scanPaths,
        timeout: options.timeout,
      });

      console.log(`✓ セレクタカタログを生成しました: ${outputPath}`);
      console.log(`  スキャン済みページ数: ${catalog.pages.length}`);
    });

  // run command
  program
    .command('run')
    .argument('[testIds...]', '実行するテストID')
    .option('--from <testId>', '指定したテストIDから末尾まで実行')
    .option('--scenario [ids]', 'シナリオ実行（省略時: 全件、指定時: カンマ区切りID順）')
    .description('テスト実行')
    .action(async (testIds, options) => {
      const config = loadConfig(projectDir);
      if (!config) {
        console.error('エラー: 設定ファイルが見つかりません\nplaywright-regression init を実行してください');
        return;
      }

      const auth = new AuthManager(path.join(projectDir, 'storage'));
      if (!auth.hasStoredAuth()) {
        console.error('エラー: 認証状態が見つかりません\nplaywright-regression auth を実行してください');
        return;
      }

      const executor = new TestExecutor(path.join(projectDir, 'tests'), projectDir);
      let filterIds;
      try {
        filterIds = resolveRunFilterIds(executor, testIds, options);
      } catch (error) {
        console.error(error.message || error);
        return;
      }

      const result = await executor.run(filterIds, {
        authPath: auth.getAuthPath(),
        timeout: config.playwright.timeout,
        headless: config.playwright.headless,
        reuseContext: options.scenario !== undefined,
        baseURL: config.testUrl,
        authReadyPath: (config.authVerification && config.authVerification.urlIncludes) || '/home',
        authPollIntervalMs: (config.authVerification && config.authVerification.pollIntervalMs) || 5000,
        authReadyTimeout: Math.max(
          (config.authVerification && config.authVerification.timeoutMs) || 0,
          config.playwright.timeout || 0,
          120000
        ),
      });

      if (result.testCount > 0) {
        console.log('\nレポートを表示するには: playwright-regression report');
      }
    });

  // report command
  program
    .command('report')
    .description('レポート表示')
    .action(async () => {
      const reportPath = path.join(projectDir, 'playwright-report', 'index.html');
      if (!fs.existsSync(reportPath)) {
        console.error('エラー: レポートが見つかりません\nplaywright-regression run を先に実行してください');
        return;
      }

      console.log('レポートを表示します...');
      const { exec } = require('child_process');
      const platform = process.platform;
      const openCmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${openCmd} ${reportPath}`);
    });

  return program;
}

// Export for testing
module.exports = { createProgram, loadConfig, resolveAuthVerification, loadSelectorCatalog, resolveRunFilterIds };

// Run if called directly
if (require.main === module) {
  const program = createProgram(process.cwd());
  program.parse();
}
