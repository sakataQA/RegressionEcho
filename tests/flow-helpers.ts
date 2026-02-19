import { expect, type Page } from '@playwright/test';
import { HOME_URL, gotoHomeForScenario, dismissAllDialogs, isUnavailablePage } from './scenario-home';

/* ── シナリオ状態管理 ─────────────────────────── */
const SCENARIO_STATE_KEY = '__regressionEchoScenarioState__';

export function setScenarioValue(key: string, value: unknown): void {
  const store = getScenarioStore();
  store[key] = value;
}

export function getScenarioValue<T = unknown>(key: string): T | undefined {
  const store = getScenarioStore();
  return store[key] as T | undefined;
}

function getScenarioStore(): Record<string, unknown> {
  const g = globalThis as unknown as Record<string, unknown>;
  if (!g[SCENARIO_STATE_KEY]) g[SCENARIO_STATE_KEY] = {};
  return g[SCENARIO_STATE_KEY] as Record<string, unknown>;
}

/* ── ページ判定ヘルパー ──────────────────────────── */

// isUnavailablePage は scenario-home.ts からインポート済み

/* ── ナビゲーション ──────────────────────────────── */

/**
 * ホーム画面にいることを保証する。
 * - gotoHomeForScenario がUnavailableリトライ込みで遷移する
 */
export async function ensureHome(page: Page): Promise<void> {
  await gotoHomeForScenario(page);
}

/**
 * SHOP画面へ遷移する。
 * - ホームに行ってダイアログを閉じてからSHOPリンクをクリック
 * - Unavailableになっても最大5回リトライ
 *
 * セレクター: a[href="/shop"] を使用
 */
export async function goToShop(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    // すでに /shop にいてUnavailableでなければ完了
    if (page.url().includes('/shop') && !(await isUnavailablePage(page))) {
      await dismissAllDialogs(page);
      return;
    }

    // ホームに移動（内部でUnavailableリトライあり）
    await ensureHome(page);
    await dismissAllDialogs(page);

    // SHOP リンクをクリック（UI差分吸収のため複数候補 + JSフォールバック）
    const shopLinkSelectors = [
      'a[href="/shop"]',
      'a:has-text("SHOP")',
      'a:has-text("ショップ")',
    ];
    let clickedShop = false;
    for (const selector of shopLinkSelectors) {
      const loc = page.locator(selector).first();
      if ((await loc.count()) === 0) continue;
      const done = await loc
        .click({ timeout: 7000, force: true })
        .then(() => true)
        .catch(() => false);
      if (done) {
        clickedShop = true;
        break;
      }
    }

    if (!clickedShop) {
      clickedShop = await page.evaluate(() => {
        const anchors = Array.from(document.querySelectorAll('a[href="/shop"], a'));
        for (const a of anchors) {
          const text = (a.textContent || '').trim();
          if ((a as HTMLAnchorElement).getAttribute('href') === '/shop' || text.includes('SHOP') || text.includes('ショップ')) {
            (a as HTMLElement).click();
            return true;
          }
        }
        return false;
      });
    }

    if (!clickedShop) {
      console.log(`SHOPリンクが見つかりません (attempt ${attempt + 1}/5)`);
      // ホーム自体がおかしい可能性 → 強制リロード
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
      await dismissAllDialogs(page);
      continue;
    }

    // /shop への遷移完了を待つ
    const moved = await page
      .waitForURL(/\/shop/, { timeout: 25000 })
      .then(() => true)
      .catch(() => false);

    if (!moved) {
      console.log(`SHOP遷移失敗 (attempt ${attempt + 1}/5)`);
      continue;
    }

    // ページコンテンツの描画を待つ
    await page.waitForTimeout(3000);

    // SHOP ページ自体がUnavailableの場合はリトライ
    if (await isUnavailablePage(page)) {
      console.log(`SHOPページがUnavailable (attempt ${attempt + 1}/5)`);
      await page.waitForTimeout(3000 * (attempt + 1));
      continue;
    }

    // コンテンツが読み込まれたか確認（button もしくは何らかの要素があるか）
    const hasContent = await page.locator('button').first().waitFor({ state: 'visible', timeout: 10000 })
      .then(() => true)
      .catch(() => false);

    if (!hasContent) {
      console.log(`SHOP画面のコンテンツが読み込まれていません (attempt ${attempt + 1}/5)`);
      continue;
    }

    await dismissAllDialogs(page);
    return;
  }
  throw new Error('SHOP画面へ5回リトライしても遷移できませんでした');
}

/* ── SHOP画面操作 ────────────────────────────────── */

/**
 * バモスの現在所持数を取得する。
 *
 * SHOP画面では "SHOP" テキストの隣にボタンとして所持数が表示される：
 *   <div>SHOP</div> <button>500</button>
 * ボタンのテキストが純粋な数値（¥や×を含まない）の場合、それが所持数。
 */
export async function getBamosCount(page: Page): Promise<number | null> {
  // ページの描画を少し待つ
  await page.waitForTimeout(2000);

  return page.evaluate(() => {
    const parseNum = (t: string) => {
      const cleaned = t.replace(/[\s\u3000,]+/g, '').trim();
      return /^\d+$/.test(cleaned) ? Number(cleaned) : null;
    };
    const isVisible = (el: Element) => {
      const h = el as HTMLElement;
      const s = window.getComputedStyle(h);
      return s.display !== 'none' && s.visibility !== 'hidden' && h.offsetParent !== null;
    };

    // 方法1: data-testid を優先
    for (const sel of ['[data-testid*="bamos"]', '[data-testid*="vamos"]', '[data-testid*="currency"]']) {
      const node = document.querySelector(sel);
      if (node && isVisible(node)) {
        const v = parseNum(node.textContent || '');
        if (v !== null) return v;
      }
    }

    // 方法2: "SHOP" テキスト要素の兄弟から数値を探す
    const allElements = Array.from(document.querySelectorAll('body *'));
    for (const el of allElements) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim();
      if (text === 'SHOP') {
        const parent = el.parentElement;
        if (!parent) continue;
        for (const sibling of Array.from(parent.children)) {
          if (sibling === el) continue;
          const sibText = (sibling.textContent || '').replace(/[\s\u3000,]+/g, '').trim();
          if (/^\d+$/.test(sibText)) {
            return Number(sibText);
          }
        }
      }
    }

    // 方法3: 純粋な数値テキストを持つボタン（¥、×、バモス等を含まない）
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      const text = (btn.textContent || '').replace(/[\s\u3000,]+/g, '').trim();
      if (/^\d+$/.test(text) && !/¥|×|バモス|おトク/.test(btn.textContent || '')) {
        return Number(text);
      }
    }

    return null;
  });
}

/**
 * バモスの購入プランを選択する。
 * プランボタンをクリックし、確認ダイアログが開くのを待つ。
 * dispatchEvent と click の両方を試行する。
 * @returns 選択したプランの増加数 (例: 26)
 */
export async function selectBamosPlan(page: Page, preferredDelta = 26): Promise<number> {
  // まずブロッキングダイアログを閉じておく
  await dismissAllDialogs(page);

  const preferred = page.locator(`button:has-text("バモス ×${preferredDelta}")`).first();
  const target = (await preferred.count()) ? preferred : page.locator('button:has-text("バモス ×")').first();
  await target.waitFor({ state: 'visible', timeout: 10000 });
  const label = (await target.textContent()) || '';

  // dispatchEvent で直接クリックイベントを発火（オーバーレイに影響されない）
  await target.dispatchEvent('click');
  await page.waitForTimeout(1500);

  // 確認ダイアログが開いたか確認
  const dialogOpened = await page.locator('dialog[open]').first().isVisible().catch(() => false);
  if (!dialogOpened) {
    // フォールバック: JSで直接購入確認ダイアログの dialog を開く
    await page.evaluate(() => {
      const dialogs = document.querySelectorAll('dialog');
      for (const d of dialogs) {
        const btn = d.querySelector('button');
        if (btn && btn.textContent?.includes('購入する')) {
          if (typeof d.showModal === 'function') {
            try { d.showModal(); } catch { d.setAttribute('open', ''); }
          } else {
            d.setAttribute('open', '');
          }
          break;
        }
      }
    });
    await page.waitForTimeout(500);
  }

  return extractPlanDelta(label) ?? preferredDelta;
}

/**
 * 購入確認ダイアログの「購入する」ボタンを押す。
 * 座標クリックで被り要素に阻まれるケースがあるため dispatchEvent を優先する。
 */
export async function clickPurchaseButton(page: Page): Promise<void> {
  const clicked = await page.evaluate(() => {
    const inOpenDialog = Array.from(document.querySelectorAll('dialog[open] button'));
    for (const btn of inOpenDialog) {
      if ((btn.textContent || '').trim().includes('購入する')) {
        (btn as HTMLElement).click();
        return true;
      }
    }

    const allButtons = Array.from(document.querySelectorAll('button'));
    for (const btn of allButtons) {
      if ((btn.textContent || '').trim().includes('購入する')) {
        (btn as HTMLElement).click();
        return true;
      }
    }

    return false;
  });

  if (!clicked) {
    throw new Error('「購入する」ボタンが見つかりませんでした');
  }
}

/**
 * 3D Secure のテスト画面が出ている場合は「Complete」を押して認証を完了する。
 * iframe ネストやモーダル表示の差分を吸収するため、全フレームを走査する。
 */
export async function completeThreeDsIfPresent(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clicked = await (async () => {
      for (const frame of page.frames()) {
        const completeBtn = frame.locator('button:has-text("Complete")').first();
        const has = await completeBtn.count().catch(() => 0);
        if (has === 0) continue;
        const done = await completeBtn
          .click({ timeout: 2000, force: true })
          .then(() => true)
          .catch(() => false);
        if (done) return true;
      }
      return false;
    })();

    if (clicked) {
      await page.waitForTimeout(1000);
      return true;
    }

    await page.waitForTimeout(1500);
  }

  return false;
}

function extractPlanDelta(label: string): number | null {
  const m = label.match(/バモス\s*×\s*([0-9,]+)/);
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

/**
 * 複数のセレクター候補から最初に見つかったものをクリックする。
 */
export async function clickFirstVisible(page: Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) continue;
    try {
      await loc.click({ timeout: 5000, force: true });
      return true;
    } catch {
      // 次の候補へ
    }
  }
  return false;
}
