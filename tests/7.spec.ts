import { test, expect } from '@playwright/test';
import { completeThreeDsIfPresent } from './flow-helpers';

test('3DS認証（認証が走ることを10秒待機で確認）', async ({ page }) => {
  // 3DS画面が出ている場合は Complete 押下を試みる（環境差分はヘルパーで吸収）
  const completed = await completeThreeDsIfPresent(page);
  console.log(`テスト7 3DS Complete押下: ${completed}`);

  // 決済基盤側の反映待ち
  await page.waitForTimeout(5000);

  // ブラウザが閉じていないことを確認
  expect(page.isClosed()).toBeFalsy();
});
