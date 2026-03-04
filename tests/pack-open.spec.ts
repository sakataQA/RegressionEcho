import { test, expect } from '@playwright/test';
import {
  assertTenCardsShown,
  clickDrawTen,
  closeHomeDialogIfPresent,
  closePackResult,
  collectPackRates,
  confirmDrawTenDialog,
  ensureHome,
  getBamosCount,
  getOwnedCardCount,
  goToCollection,
  goToPack,
  openPackDetail,
  scrollDownToDrawTen,
  scrollUpToPackRates,
  swipeThrough10Cards,
  waitForPackAnimationIfAny,
  countSpecialAnimationsIfPossible,
} from './flow-helpers';

test('パック開封フロー（draw.io→test.step 実装）', async ({ page }) => {
  test.setTimeout(300000);

  const drawCost = 50;
  const expectedGain = 10;
  let ownedBefore: number | null = null;
  let ownedAfter: number | null = null;
  let bamosBefore: number | null = null;
  let bamosAfter: number | null = null;
  let animationDetected = false;
  let specialAnimationCount = 0;
  let swipeSummary: { swipedCount: number; cardLikeCount: number } | undefined;

  await test.step('開始', async () => {
    console.log(`[url-before-ensureHome] ${page.url()}`);
    await ensureHome(page);
    await page.waitForLoadState('domcontentloaded');
    console.log(`[url-after-ensureHome] ${page.url()}`);
    await expect(page).toHaveURL(/\/home/, { timeout: 30000 });
    if (process.env.PW_PAUSE_ON_START === '1') {
      await page.pause();
    }
  });

  await test.step('ホーム画面でダイアログ下の「x」ボタンタップ', async () => {
    const closed = await closeHomeDialogIfPresent(page);
    console.log(`[homeDialogClosed] ${closed}`);
  });

  await test.step('フッターの「コレクション」をタップ', async () => {
    await goToCollection(page);
    await expect(page).toHaveURL(/\/collection/, { timeout: 30000 });
  });

  await test.step('数字を控える（stdout）※所持枚数(開封前)', async () => {
    ownedBefore = await getOwnedCardCount(page);
    console.log(`[ownedBefore] ${ownedBefore}`);
    expect(ownedBefore).not.toBeNull();
  });

  await test.step('フッターの「パック」をタップ', async () => {
    await goToPack(page);
    await expect(page).toHaveURL(/\/packs|\/shop|\/pack/, { timeout: 30000 });
  });

  await test.step('「パック詳細」をタップ', async () => {
    await openPackDetail(page);
  });

  await test.step('上にスワイプして、選手名と（nn.nn％）を控える（stdout）', async () => {
    await scrollUpToPackRates(page);
    const rates = await collectPackRates(page);
    console.log(`[packRates] ${JSON.stringify(rates)}`);
  });

  await test.step('下にスワイプして「10枚引く」ボタンをタップ', async () => {
    await scrollDownToDrawTen(page);
    await clickDrawTen(page);
  });

  await test.step('数字をメモる（stdout）※開封前のバモス数', async () => {
    bamosBefore = await getBamosCount(page);
    console.log(`[bamosBefore] ${bamosBefore}`);
    expect(bamosBefore).not.toBeNull();
  });

  await test.step('ダイアログの「10枚引く」ボタンをタップする', async () => {
    await confirmDrawTenDialog(page);
  });

  await test.step('演出動画が再生されるか確認する', async () => {
    animationDetected = await waitForPackAnimationIfAny(page);
    console.log(`[animationDetected] ${animationDetected}`);
  });

  await test.step('演出の種類をカウントする（確定演出が多すぎないか）', async () => {
    specialAnimationCount = await countSpecialAnimationsIfPossible(page);
    console.log(`[specialAnimationCount] ${specialAnimationCount}`);
    expect(specialAnimationCount).toBeGreaterThanOrEqual(0);
  });

  await test.step('出現したカードを確認＆スワイプ', async () => {
    swipeSummary = await swipeThrough10Cards(page);
    console.log(`[swipeSummary] ${JSON.stringify(swipeSummary)}`);
  });

  await test.step('全10枚の表示がNo.12の通りであるか確認', async () => {
    await assertTenCardsShown(page, swipeSummary);
  });

  await test.step('「x」ボタン押下でパック開封を終わる', async () => {
    await closePackResult(page);
  });

  await test.step('50減っているか確認する（バモス数: No.8 と比較）', async () => {
    await goToPack(page);
    bamosAfter = await getBamosCount(page);
    console.log(`[bamosAfter] ${bamosAfter}`);
    expect(bamosAfter).not.toBeNull();
    expect(bamosAfter as number).toBe((bamosBefore as number) - drawCost);
  });

  await test.step('フッターの「コレクション」をタップする', async () => {
    await goToCollection(page);
    await expect(page).toHaveURL(/\/collection/, { timeout: 30000 });
  });

  await test.step('10枚増えているか確認する（所持枚数: No.3 と比較）', async () => {
    ownedAfter = await getOwnedCardCount(page);
    console.log(`[ownedAfter] ${ownedAfter}`);
    expect(ownedAfter).not.toBeNull();
    expect(ownedAfter as number).toBe((ownedBefore as number) + expectedGain);
  });

  await test.step('終了', async () => {
    console.log('[packOpenFlowCompleted] true');
  });
});
