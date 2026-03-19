# RegressionEcho

リグレッションテストを効率化するCLIツール。複数段階認証が必要な環境で、手動突破後に認証状を利用してテストケースCSVから自動でPlaywrightテストを生成・実行することを想定しています。

## 特徴

- **認証状態の保存・再利用** - IAP、Okta等の多段階認証を一度突破すれば、以降は自動で認証状態を利用
- **AI駆動のテスト生成** - Claude APIを使用して、テストケースCSVから自動でPlaywrightテストコードを生成
- **リグレッションテスト最適化** - 一度生成したテストスクリプトを繰り返し実行（毎回AI呼び出し不要）
- **見やすいレポート** - Playwright標準のHTMLレポートで結果を確認
- **QA担当者向け** - コーディング不要、コマンド実行のみで完結

## 必要な環境

- Node.js v18以上
- Claude API キー（[Anthropic Console](https://console.anthropic.com/)で取得）

## インストール

```bash
git clone https://github.com/k-sakQA/RegressionEcho.git
cd RegressionEcho
npm install
npm link  # グローバルコマンドとして使用可能にする
```

## 使い方

## Dockerで実行する

Playwright同梱イメージを使って、ローカル環境に依存せず実行できます。

### 1. イメージ作成

```bash
docker compose build
```

### 2. テスト実行

```bash
# purchaseだけ実行
docker compose run --rm regressionecho run purchase

# 全テスト実行
docker compose run --rm regressionecho run

# Slack通知付き（config/config.json の webhookUrl を利用）
docker compose run --rm regressionecho run purchase slack

# Slack通知付き（環境変数で上書き）
SLACK_WEBHOOK_URL='https://hooks.slack.com/services/xxx/yyy/zzz' \
docker compose run --rm regressionecho run purchase slack
```

### 3. レポート確認（ホスト側で表示）

```bash
npx playwright show-report
```

- `playwright-report/` と `test-results/` はボリューム共有されるため、コンテナ実行後もホストで確認できます。
- コンテナでは `PW_HEADLESS=true` が既定です。
- `SLACK_WEBHOOK_URL` を設定すると、コンテナ実行時に通知先を上書きできます。


### 1. 初期セットアップ

```bash
playwright-regression init
```

- 設定ファイル（`config/config.json`）が生成されます
- `config/config.json`を開き、Claude APIキーを設定してください

```json
{
  "anthropic": {
    "apiKey": "sk-ant-xxxxx",
    "model": "claude-sonnet-4-5-20250929"
  },
  "playwright": {
    "headless": false,
    "timeout": 30000
  },
  "testUrl": "https://your-test-environment.example.com",
  "slack": {
    "webhookUrl": "https://hooks.slack.com/services/xxx/yyy/zzz"
  },
  "authVerification": {
    "enabled": false,
    "urlIncludes": "/home",
    "visibleSelectors": [
      "[data-testid=\"home-root\"]"
    ],
    "timeoutMs": 15000,
    "pollIntervalMs": 5000
  }
}
```

### 2. 認証状態の保存

```bash
playwright-regression auth
```

- ブラウザが起動するので、手動で認証を完了してください（IAP → Okta → JリーグID等）
- 認証完了後、Enterキーを押すと認証状態が保存されます
- `authVerification.enabled=true` の場合は、URL到達とセレクタ可視を検証してから保存します

例（サービス固有チェックをCLIオプションで差し込み）:

```bash
playwright-regression auth --check-url /home --check-selector '[data-testid="hero-home"]'
```

- URL検証は既定で5秒間隔ポーリング（`pollIntervalMs`）で実施します
- CLIからは `--check-interval 5000` で上書きできます

- 汎用利用したい場合は `--skip-check` で検証を無効化できます

### 3. テストケースCSVの準備

以下の形式でCSVファイルを作成してください。

**testcases.csv:**

```csv
テストID,テスト目的,前提条件,期待結果
TC001,100円ガチャ購入で通貨10個増加確認,ログイン済み・通貨100個以上保有,購入前後で通貨が10個増加していること
TC002,SSRガチャ演出の確認,ログイン済み,SSR排出時に専用演出が表示されること
TC003,購入履歴への反映確認,ログイン済み,購入後に履歴ページに記録が追加されること
```

### 4. テストスクリプトの生成

```bash
playwright-regression generate testcases.csv
```

- CSVの各行から、Playwrightテストコードが自動生成されます
- 生成されたコードは`tests/`ディレクトリに保存されます
- この操作は初回のみ必要です（リグレッションテストなので、以降は同じスクリプトを繰り返し実行）

特定のテストのみ生成したい場合:

```bash
playwright-regression generate testcases.csv --only TC001,TC003
```

DOM実測セレクタを使って生成精度を上げる場合:

```bash
# 認証済み状態でDOMを実測
playwright-regression discover-selectors /home /shop

# 実測セレクタを入力にして生成
playwright-regression generate testcases.csv --selectors storage/selectors.json
```

### 5. テストの実行

```bash
# 全テスト実行
playwright-regression run

# 特定のテストのみ実行
playwright-regression run TC001 TC003

# シナリオ実行（1 workerで指定順に実行）
playwright-regression run --scenario
playwright-regression run --scenario TC001,TC002,TC003

# 指定IDから末尾まで実行
playwright-regression run --from TC010

# Slack通知付き（末尾に slack）
playwright-regression run purchase slack

# Slack通知付き（オプション）
playwright-regression run purchase --slack
```

- `run` のテストID指定は半角スペース区切りです（例: `run TC001 TC003`）
- カンマ区切りは `--scenario` のID指定で使用します（例: `--scenario TC001,TC002,TC003`）
- `run` の引数は **ファイル名ではなくテストID** です  
  例: `tests/purchase.spec.ts` は `playwright-regression run purchase`
  例: `tests/pack-open.spec.ts` は `playwright-regression run pack-open`
- Slack通知時のWebhook URLは `SLACK_WEBHOOK_URL` を優先し、未設定時は `config/config.json` の `slack.webhookUrl` を使用します

### テストファイル名の変更（リネーム）

- `playwright-regression run` の対象は `tests/*.spec.ts` のみです
- ファイル名を変更する場合は、必ず `*.spec.ts` を維持してください
- 実行時は拡張子を除いたIDを指定します

```bash
# 例: ファイル名変更
mv tests/10.spec.ts tests/purchase.spec.ts
mv tests/11.spec.ts tests/pack-open.spec.ts

# 実行（拡張子は付けない）
playwright-regression run purchase pack-open
```

### 6. 結果の確認

```bash
playwright-regression report
```

- ブラウザでPlaywright標準のHTMLレポートが開きます

## ワークフロー例

### 初期構築時（初回のみ）

```bash
playwright-regression init          # 1. 初期設定
# config/config.json にAPIキーを設定
playwright-regression auth --check-url /home --check-selector '[data-testid="hero-home"]'  # 2. 認証状態を保存
playwright-regression discover-selectors /home /shop  # 3. DOM実測セレクタ収集
playwright-regression generate testcases.csv --selectors storage/selectors.json  # 4. テスト生成
playwright-regression run           # 5. テスト実行・動作確認
git add tests/ storage/selectors.json && git commit  # 6. 生成物をGit管理
```

### 日常のリグレッション実行

```bash
playwright-regression run           # テスト実行
playwright-regression report        # 結果確認
```

### シナリオ実行（順序保証が必要な回帰）

```bash
playwright-regression run --scenario
```

- UIフローが長いテストは、`--scenario`で順序通りに実行する運用を推奨します
- シナリオ実行時は内部的に1 workerで実行され、前段結果を後段で参照しやすくなります

### 単体実行（ピンポイント確認）

```bash
playwright-regression run TC001
```

- 単体実行では前段テストの共有状態が存在しないため、テストは自己完結（必要な前提を自分で準備）させてください
- 外部決済や認証画面が介在する場合は、待機時間・遷移待ち・フォールバック操作を実装すると安定します

### テストケース変更時

```bash
# testcases.csv を編集
playwright-regression generate testcases.csv --only TC002  # 該当テストのみ再生成
playwright-regression run TC002     # 動作確認
```

## コマンドリファレンス

| コマンド | 説明 |
|---------|------|
| `init` | 初期設定（設定ファイル生成・ディレクトリ作成） |
| `auth [--check-url ... --check-selector ... --skip-check]` | 認証状態の保存（任意の到達検証付き） |
| `discover-selectors [paths...]` | 認証済みページのDOMを実測しセレクタJSONを生成 |
| `generate <csv> [--only テストID,...] [--selectors path]` | CSVからテスト生成（実測セレクタ入力に対応） |
| `run [testIds...] [--scenario [ids]] [--from testId] [--slack]` | テスト実行（通常/順序実行/途中再開/Slack通知） |
| `report` | レポート表示 |

## GitHubへ反映

```bash
git add Dockerfile docker-compose.yml .dockerignore playwright.config.js README.md
git commit -m "Add Docker support for RegressionEcho"
git push origin main
```

## ディレクトリ構成

```
RegressionEcho/
├── config/
│   └── config.json         # 設定ファイル（APIキー等）
├── storage/
│   └── auth.json           # 認証状態（自動生成）
│   └── selectors.json      # DOM実測セレクタ（任意）
├── tests/                  # 生成されたテストスクリプト
│   ├── TC001.spec.ts
│   ├── TC002.spec.ts
│   └── TC003.spec.ts
└── playwright-report/      # テスト結果レポート（自動生成）
```

## .gitignore 推奨設定

```gitignore
# 認証情報（Git管理しない）
config/config.json
storage/

# レポート（自動生成）
playwright-report/
test-results/

# 依存関係
node_modules/
```

> **注意:** `tests/`ディレクトリはGit管理することを推奨します（テストの再現性確保のため）

## トラブルシューティング

### 認証が切れた場合

```bash
playwright-regression auth  # 再認証
```

### テスト生成がうまくいかない場合

- CSVフォーマットを確認してください（ヘッダー行が正しいか、文字コードがUTF-8か）
- Claude APIキーが正しく設定されているか確認してください
- 生成されたコードを手動で修正することも可能です（`tests/`配下のファイルを直接編集）

### テスト実行時にエラーが出る場合

- 認証状態が有効か確認してください
- `config.json`の`testUrl`が正しいか確認してください
- 生成されたテストコードをレビューし、必要に応じて修正してください
- 単体実行で失敗する場合は、前段テスト依存（共有状態不足）の可能性があります。`--scenario` での再現確認か、対象テストの自己完結化を行ってください

## 詳細仕様

詳細な仕様については[SPECIFICATION.md](./SPECIFICATION.md)を参照してください。

## 作者

Kaz SAKATA ([@k-sakQA](https://github.com/k-sakQA))
