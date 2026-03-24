const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  notifyFromPlaywrightReportByBot,
  uploadHtmlReportToSlack,
} = require('../lib/slack-notifier');

describe('slack-notifier', () => {
  let tmpDir;
  let originalFetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-notifier-'));
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('HTMLレポートをSlackにアップロードできる', async () => {
    const reportPath = path.join(tmpDir, 'index.html');
    fs.writeFileSync(reportPath, '<html><body>ok</body></html>');

    global.fetch = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true, upload_url: 'https://upload.slack.test', file_id: 'F123' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'ok',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      });

    const result = await uploadHtmlReportToSlack({
      botToken: 'xoxb-test',
      channelId: 'C123',
      reportPath,
    });

    expect(global.fetch).toHaveBeenNthCalledWith(
      1,
      'https://slack.com/api/files.getUploadURLExternal',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer xoxb-test',
        }),
      })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      2,
      'https://upload.slack.test',
      expect.objectContaining({ method: 'POST' })
    );
    expect(global.fetch).toHaveBeenNthCalledWith(
      3,
      'https://slack.com/api/files.completeUploadExternal',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer xoxb-test',
        }),
      })
    );
    expect(result).toEqual({ uploaded: true, fileId: 'F123' });
  });

  test('Slack APIがエラーを返した場合は例外', async () => {
    const reportPath = path.join(tmpDir, 'index.html');
    fs.writeFileSync(reportPath, '<html><body>ng</body></html>');

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: false, error: 'missing_scope' }),
    });

    await expect(uploadHtmlReportToSlack({
      botToken: 'xoxb-test',
      channelId: 'C999',
      reportPath,
    })).rejects.toThrow('missing_scope');
  });

  test('HTMLレポートが存在しない場合は例外', async () => {
    await expect(uploadHtmlReportToSlack({
      botToken: 'xoxb-test',
      channelId: 'C123',
      reportPath: path.join(tmpDir, 'missing.html'),
    })).rejects.toThrow('HTMLレポートが見つかりません');
  });

  test('BotでJSONレポート要約を投稿できる', async () => {
    const reportPath = path.join(tmpDir, 'results.json');
    fs.writeFileSync(reportPath, JSON.stringify({
      suites: [{
        specs: [{
          title: '課金フロー（purchase）',
          tests: [{ results: [{ status: 'passed', steps: [] }] }],
        }],
      }],
    }));

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, ts: '123.456' }),
    });

    const result = await notifyFromPlaywrightReportByBot({
      botToken: 'xoxb-test',
      channelId: 'C123',
      reportPath,
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer xoxb-test',
        }),
        body: expect.stringContaining('Playwright テスト結果'),
      })
    );
    expect(result).toEqual({ sent: true, caseCount: 1 });
  });
});
