import { test, expect } from '@playwright/test';
import {
  clickFirstVisible,
  clickPurchaseButton,
  completeThreeDsIfPresent,
  ensureHome,
  getBamosCount,
  goToShop,
  selectBamosPlan,
} from './flow-helpers';

test('テストID-10 - 1〜9の通し実行', async ({ page }) => {
  test.setTimeout(300000);

  // 1. ホーム→SHOP遷移
  await ensureHome(page);
  await expect(page).toHaveURL(/\/home/, { timeout: 30000 });
  await goToShop(page);
  await expect(page).toHaveURL(/\/shop/, { timeout: 30000 });

  // 2. 購入前残高の取得
  const beforeBamos = await getBamosCount(page);
  expect(beforeBamos).not.toBeNull();
  expect(beforeBamos as number).toBeGreaterThanOrEqual(0);
  console.log(`購入前のバモス：${beforeBamos}`);

  // 3-4. 商品選択→購入確認ダイアログの進行
  const selectedDelta = await selectBamosPlan(page, 26);
  console.log(`購入したバモス：${selectedDelta}`);
  await page.waitForFunction(() => {
    const inOpenDialog = Array.from(document.querySelectorAll('dialog[open] button'));
    if (inOpenDialog.some((btn) => (btn.textContent || '').trim().includes('購入する'))) {
      return true;
    }
    const allButtons = Array.from(document.querySelectorAll('button'));
    return allButtons.some((btn) => (btn.textContent || '').trim().includes('購入する'));
  }, { timeout: 10000 });
  await clickPurchaseButton(page);

  // 5. 支払い確定操作
  await page.waitForTimeout(2000);
  const submitted = await clickFirstVisible(page, [
    'button:has-text("この内容で支払う")',
    'button:has-text("購入を確定")',
    'button:has-text("登録済み")',
    'button:has-text("お支払い方法")',
    'button:has-text("確定")',
    'button:has-text("購入する")',
    'button:has-text("OK")',
  ]);
  expect(submitted).toBeTruthy();

  // 6-8. 3DS/完了ダイアログの吸収
  const threeDsCompleted = await completeThreeDsIfPresent(page);
  console.log(`3DS Complete押下: ${threeDsCompleted}`);
  await page.waitForTimeout(12000);
  await clickFirstVisible(page, [
    'dialog[open] button:has-text("OK")',
    'button:has-text("OK")',
  ]);

  // 9. 購入後残高確認
  await goToShop(page);
  const afterBamos = await getBamosCount(page);
  console.log(`購入後のバモス：${afterBamos}`);
  expect(afterBamos).not.toBeNull();
  expect(afterBamos as number).toBeGreaterThanOrEqual((beforeBamos as number) + selectedDelta);
});
