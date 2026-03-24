const fs = require('fs');

function collectSpecs(suite, bucket) {
  if (!suite || typeof suite !== 'object') {
    return;
  }

  if (Array.isArray(suite.specs)) {
    bucket.push(...suite.specs);
  }

  if (Array.isArray(suite.suites)) {
    for (const child of suite.suites) {
      collectSpecs(child, bucket);
    }
  }
}

function findFirstFailedStep(steps) {
  if (!Array.isArray(steps)) {
    return null;
  }

  for (const step of steps) {
    const nested = findFirstFailedStep(step.steps);
    if (nested) {
      return nested;
    }
    if (step && step.error && step.title) {
      return step.title;
    }
  }

  return null;
}

function getFailedStepName(test) {
  if (!test || !Array.isArray(test.results)) {
    return null;
  }

  for (const result of test.results) {
    if (!result || result.status === 'passed' || result.status === 'skipped') {
      continue;
    }
    const failedStep = findFirstFailedStep(result.steps);
    if (failedStep) {
      return failedStep;
    }
  }

  return null;
}

function summarizePlaywrightReport(reportPath) {
  if (!fs.existsSync(reportPath)) {
    return [];
  }

  const json = JSON.parse(fs.readFileSync(reportPath, 'utf-8'));
  const specs = [];
  const roots = Array.isArray(json.suites) ? json.suites : [];
  for (const root of roots) {
    collectSpecs(root, specs);
  }

  const cases = [];
  for (const spec of specs) {
    const tests = Array.isArray(spec.tests) ? spec.tests : [];
    for (const test of tests) {
      const results = Array.isArray(test.results) ? test.results : [];
      const hasFailure = results.some((r) => r && !['passed', 'skipped'].includes(r.status));
      const caseName = spec.title || '名称未取得';
      cases.push({
        caseName,
        success: !hasFailure,
        failedStep: hasFailure ? getFailedStepName(test) : null,
      });
    }
  }

  return cases;
}

function buildSlackMessage(cases) {
  const lines = ['Playwright テスト結果'];

  for (const c of cases) {
    lines.push(`- ケース名（${c.caseName}）`);
    lines.push(`- ${c.success ? '成功:testpassed:' : '失敗:tesutfailed:'}`);
    if (!c.success) {
      lines.push(`- 失敗ステップ: ${c.failedStep || '取得できませんでした'}`);
    }
  }

  return lines.join('\n');
}

async function postToSlack(webhookUrl, text) {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack通知に失敗しました: ${response.status} ${body}`);
  }
}

async function postBotMessage({ botToken, channelId, text }) {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: channelId,
      text,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Slack Botメッセージ送信に失敗しました: ${response.status} ${body}`);
  }

  const json = await response.json();
  if (!json.ok) {
    throw new Error(`Slack Botメッセージ送信に失敗しました: ${json.error || 'unknown_error'}`);
  }
}

async function uploadHtmlReportToSlack({ botToken, channelId, reportPath, filename = 'playwright-report-index.html' }) {
  if (!fs.existsSync(reportPath)) {
    throw new Error(`HTMLレポートが見つかりません: ${reportPath}`);
  }

  const htmlContent = fs.readFileSync(reportPath);
  const length = htmlContent.byteLength;

  const startResponse = await fetch('https://slack.com/api/files.getUploadURLExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      filename,
      length: String(length),
    }),
  });

  if (!startResponse.ok) {
    const body = await startResponse.text();
    throw new Error(`SlackファイルアップロードURL取得に失敗しました: ${startResponse.status} ${body}`);
  }

  const startJson = await startResponse.json();
  if (!startJson.ok || !startJson.upload_url || !startJson.file_id) {
    throw new Error(`SlackファイルアップロードURL取得に失敗しました: ${startJson.error || 'unknown_error'}`);
  }

  const uploadResponse = await fetch(startJson.upload_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
    },
    body: htmlContent,
  });
  if (!uploadResponse.ok) {
    const body = await uploadResponse.text();
    throw new Error(`Slackファイル本体アップロードに失敗しました: ${uploadResponse.status} ${body}`);
  }

  const completeResponse = await fetch('https://slack.com/api/files.completeUploadExternal', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${botToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: [{ id: startJson.file_id, title: 'Playwright HTML Report' }],
      channel_id: channelId,
      initial_comment: 'Playwright HTML report (index.html)',
    }),
  });
  if (!completeResponse.ok) {
    const body = await completeResponse.text();
    throw new Error(`Slackファイルアップロード確定に失敗しました: ${completeResponse.status} ${body}`);
  }

  const completeJson = await completeResponse.json();
  if (!completeJson.ok) {
    throw new Error(`Slackファイルアップロードに失敗しました: ${completeJson.error || 'unknown_error'}`);
  }

  return { uploaded: true, fileId: startJson.file_id };
}

async function notifyFromPlaywrightReport(webhookUrl, reportPath) {
  const cases = summarizePlaywrightReport(reportPath);
  if (cases.length === 0) {
    return { sent: false, reason: 'no-cases' };
  }

  const message = buildSlackMessage(cases);
  await postToSlack(webhookUrl, message);
  return { sent: true, caseCount: cases.length };
}

async function notifyFromPlaywrightReportByBot({ botToken, channelId, reportPath }) {
  const cases = summarizePlaywrightReport(reportPath);
  if (cases.length === 0) {
    return { sent: false, reason: 'no-cases' };
  }

  const message = buildSlackMessage(cases);
  await postBotMessage({ botToken, channelId, text: message });
  return { sent: true, caseCount: cases.length };
}

module.exports = {
  summarizePlaywrightReport,
  buildSlackMessage,
  notifyFromPlaywrightReport,
  notifyFromPlaywrightReportByBot,
  uploadHtmlReportToSlack,
};
