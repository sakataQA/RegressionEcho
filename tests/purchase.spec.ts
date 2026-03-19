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

const PURCHASES_URL = 'https://development.pocket-heroes.net/purchases';
const EXPECTED_PAID_GAIN = 25;
const EXPECTED_FREE_GAIN = 1;

type PurchasesSnapshot = {
  paidBamos: number | null;
  freeBamos: number | null;
  paid25HistoryCount: number;
};

async function goToPurchases(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(PURCHASES_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await expect(page).toHaveURL(/\/purchases/, { timeout: 30000 });
  await page.waitForTimeout(1500);
}

async function readPurchasesSnapshot(page: import('@playwright/test').Page): Promise<PurchasesSnapshot> {
  await page.waitForLoadState('domcontentloaded');
  const parseNumericText = (text: string | null): number | null => {
    if (!text) return null;
    const m = text.replace(/[\s\u3000]+/g, '').match(/^([0-9][0-9,]*)$/);
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };

  const getBamosByLabel = async (label: string): Promise<number | null> => {
    const labelLocator = page.getByText(label, { exact: true }).first();
    await labelLocator.waitFor({ state: 'visible', timeout: 10000 });
    const valueText = await labelLocator.locator('xpath=following-sibling::*[1]').first().textContent();
    return parseNumericText(valueText);
  };

  const paidBamos = await getBamosByLabel('有償バモス');
  const freeBamos = await getBamosByLabel('無償バモス');
  const paid25HistoryCount = await page.locator('span').filter({ hasText: /^有償バモス\s*×\s*25$/ }).count();

  return { paidBamos, freeBamos, paid25HistoryCount };
}

async function fillNewCardInStripeFrame(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForSelector('dialog[open], [role="dialog"]', { timeout: 15000 });

  // 新規カード選択を明示（既定選択でも副作用なし）
  await clickFirstVisible(page, [
    'input[type="radio"][value="new_card"]',
    'label:has-text("新規クレジットカード")',
    'button:has-text("新規クレジットカード")',
  ]);

  const frameSelector = 'iframe[title*="支払い入力フレーム"], iframe[name^="__privateStripeFrame"]';
  await page.waitForSelector(frameSelector, { timeout: 20000 });
  const cardFrame = page.frameLocator(frameSelector).first();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await cardFrame.getByPlaceholder('1234 1234 1234 1234').fill('4000002760003184');
      await cardFrame.getByPlaceholder('MM / YY').fill('12 / 34');
      await cardFrame.getByPlaceholder('CVC').fill('123');
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await page.waitForTimeout(1000);
    }
  }
}

async function selectRegisteredCardIfPresent(page: import('@playwright/test').Page): Promise<boolean> {
  const savedRadio = page.locator('dialog[open] input[type="radio"][name="payment_method"][value^="pm_"], [role="dialog"] input[type="radio"][name="payment_method"][value^="pm_"]').first();
  if ((await savedRadio.count()) === 0) return false;

  const visible = await savedRadio.isVisible().catch(() => false);
  if (!visible) return false;

  await savedRadio.scrollIntoViewIfNeeded().catch(() => {});

  const selected = await savedRadio
    .check({ force: true, timeout: 5000 })
    .then(() => true)
    .catch(async () => {
      return savedRadio
        .click({ force: true, timeout: 5000 })
        .then(() => true)
        .catch(() => false);
    });

  if (selected) {
    await page.waitForTimeout(500);
    return true;
  }

  return page.evaluate(() => {
    const radio = document.querySelector('input[type="radio"][name="payment_method"][value^="pm_"]') as HTMLInputElement | null;
    if (!radio) return false;
    radio.click();
    const label = radio.closest('label');
    if (label) (label as HTMLElement).click();
    return true;
  });
}

test('課金フロー（purchase）', async ({ page }) => {
  test.setTimeout(300000);
  let beforeBamos: number | null = null;
  let selectedDelta = 26;
  let purchasesBefore: PurchasesSnapshot | null = null;
  let usedRegisteredCard = false;
  let submitted = false;
  let paymentMethodPath = '未判定';

  await test.step('開始', async () => {
    console.log(`[url-before-ensureHome] ${page.url()}`);
    await ensureHome(page);
    await expect(page).toHaveURL(/\/home/, { timeout: 30000 });
    await goToShop(page);
    await expect(page).toHaveURL(/\/shop/, { timeout: 30000 });
    console.log(`[url-after-goToShop] ${page.url()}`);
  });

  await test.step('数字をメモる（stdout）※購入前のバモス数', async () => {
    beforeBamos = await getBamosCount(page);
    expect(beforeBamos).not.toBeNull();
    expect(beforeBamos as number).toBeGreaterThanOrEqual(0);
    console.log(`[beforeBamos] ${beforeBamos}`);
  });

  await test.step('購入前の課金履歴ページ情報をメモる（stdout）', async () => {
    await goToPurchases(page);
    purchasesBefore = await readPurchasesSnapshot(page);
    console.log(`[purchasesBefore] ${JSON.stringify(purchasesBefore)}`);
    expect(purchasesBefore?.paidBamos).not.toBeNull();
    expect(purchasesBefore?.freeBamos).not.toBeNull();
    await goToShop(page);
  });

  await test.step('商品を選択して「購入する」を押す', async () => {
    selectedDelta = await selectBamosPlan(page, 26);
    console.log(`[selectedDelta] ${selectedDelta}`);
    await page.waitForFunction(() => {
      const inOpenDialog = Array.from(document.querySelectorAll('dialog[open] button'));
      if (inOpenDialog.some((btn) => (btn.textContent || '').trim().includes('購入する'))) {
        return true;
      }
      const allButtons = Array.from(document.querySelectorAll('button'));
      return allButtons.some((btn) => (btn.textContent || '').trim().includes('購入する'));
    }, { timeout: 10000 });
    await clickPurchaseButton(page);
  });

  await test.step('支払い方法を選択（登録済み or 新規カード）', async () => {
    await page.waitForTimeout(2000);
    usedRegisteredCard = await selectRegisteredCardIfPresent(page);

    if (!usedRegisteredCard) {
      const hasSavedCard = (await page.locator('input[type="radio"][name="payment_method"][value^="pm_"]').count()) > 0;
      console.log(`[hasSavedCardRadio] ${hasSavedCard}`);
    }

    if (!usedRegisteredCard) {
      await test.step('支払い方法: 新規カードを登録して利用', async () => {
        await fillNewCardInStripeFrame(page);

        const registered = await clickFirstVisible(page, [
          'button:has-text("このカードを登録する")',
          'button:has-text("カードを登録する")',
          'button:has-text("登録する")',
        ]);
        if (!registered) {
          console.log('「このカードを登録する」ボタンは未表示のため、「購入を確定する」へ進行');
        }
        paymentMethodPath = '新規カード登録';
        console.log('[paymentMethod] 新規カードを登録して続行');
        await page.waitForTimeout(1500);
      });
    } else {
      await test.step('支払い方法: 登録済みカードを利用', async () => {
        paymentMethodPath = '登録済みカード';
        console.log('[paymentMethod] 登録済みカードを利用して続行');
      });
    }

    console.log(`[paymentMethodPath] ${paymentMethodPath}`);
  });

  await test.step('「購入を確定する」を押下する', async () => {
    await page.waitForFunction(() => {
      const candidates = Array.from(document.querySelectorAll('dialog[open] button, button'));
      return candidates.some((btn) => {
        const text = (btn.textContent || '').trim();
        if (!text.includes('購入を確定')) return false;
        return !(btn as HTMLButtonElement).disabled;
      });
    }, { timeout: 20000 });

    const submittedByDialog = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"]'));
      const texts = ['購入を確定する', 'この内容で支払う', '購入を確定', '確定'];
      for (const root of dialogs) {
        const buttons = Array.from(root.querySelectorAll('button')) as HTMLButtonElement[];
        for (const btn of buttons) {
          const text = (btn.textContent || '').trim();
          if (!texts.some((t) => text.includes(t))) continue;
          if (btn.disabled) continue;
          btn.click();
          return true;
        }
      }
      return false;
    });

    submitted = submittedByDialog || (await clickFirstVisible(page, [
      'dialog[open] button:has-text("購入を確定する")',
      'button:has-text("この内容で支払う")',
      'button:has-text("購入を確定する")',
      'button:has-text("購入を確定")',
      'button:has-text("確定")',
      'button:has-text("購入する")',
      'button:has-text("OK")',
    ]));
    console.log(`[purchaseSubmitted] ${submitted}`);
    expect(submitted).toBeTruthy();
  });

  await test.step('3DS/完了ダイアログを吸収する', async () => {
    const threeDsCompleted = await completeThreeDsIfPresent(page);
    console.log(`[threeDsCompleted] ${threeDsCompleted}`);
    await page.waitForTimeout(12000);
    await clickFirstVisible(page, [
      'dialog[open] button:has-text("OK")',
      'button:has-text("OK")',
    ]);
  });

  await test.step('購入後のバモス数を確認（購入前 + 選択プラン以上）', async () => {
    let afterBamos: number | null = null;
    const expectedAfter = (beforeBamos as number) + selectedDelta;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await goToShop(page);
      afterBamos = await getBamosCount(page);
      if (afterBamos !== null && afterBamos >= expectedAfter) break;
      await page.waitForTimeout(5000);
    }
    console.log(`[afterBamos] ${afterBamos}`);
    expect(afterBamos).not.toBeNull();
    expect(afterBamos as number).toBeGreaterThanOrEqual(expectedAfter);
  });

  await test.step('課金履歴ページで課金結果を確認（有償+25, 無償+1, 履歴+1）', async () => {
    let purchasesAfter: PurchasesSnapshot | null = null;
    const expectedPaid = (purchasesBefore as PurchasesSnapshot).paidBamos as number;
    const expectedFree = (purchasesBefore as PurchasesSnapshot).freeBamos as number;
    const expectedHistoryCount = (purchasesBefore as PurchasesSnapshot).paid25HistoryCount;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await goToPurchases(page);
      purchasesAfter = await readPurchasesSnapshot(page);
      const paidOk = purchasesAfter.paidBamos === expectedPaid + EXPECTED_PAID_GAIN;
      const freeOk = purchasesAfter.freeBamos === expectedFree + EXPECTED_FREE_GAIN;
      const historyOk = purchasesAfter.paid25HistoryCount === expectedHistoryCount + 1;
      if (paidOk && freeOk && historyOk) break;
      await page.waitForTimeout(5000);
    }

    console.log(`[purchasesAfter] ${JSON.stringify(purchasesAfter)}`);
    expect(purchasesAfter).not.toBeNull();
    expect(purchasesAfter?.paidBamos).toBe(expectedPaid + EXPECTED_PAID_GAIN);
    expect(purchasesAfter?.freeBamos).toBe(expectedFree + EXPECTED_FREE_GAIN);
    expect(purchasesAfter?.paid25HistoryCount).toBe(expectedHistoryCount + 1);
  });

  await test.step('終了', async () => {
    console.log('[purchaseFlowCompleted] true');
  });
});
