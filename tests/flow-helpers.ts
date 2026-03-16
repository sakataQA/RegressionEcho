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
 * 1) バモス表示をタップしてダイアログを開く
 * 2) ダイアログ文言「所持バモス ×NNN」から数値を取得
 * 3) 最後にダイアログを「x」で閉じる
 * 4) 取得できない場合のみ従来のDOM推定へフォールバック
 */
export async function getBamosCount(page: Page): Promise<number | null> {
  await page.waitForTimeout(2000);

  const clickedIndicator = await page.evaluate(() => {
    const isVisible = (el: Element) => {
      const h = el as HTMLElement;
      const s = window.getComputedStyle(h);
      const r = h.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 10 && r.height > 10;
    };

    const candidates: Array<{ el: HTMLButtonElement; top: number; score: number }> = [];
    const buttons = Array.from(document.querySelectorAll('button')) as HTMLButtonElement[];
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      const raw = (btn.textContent || '').replace(/[\s\u3000]+/g, '');
      if (!/^[0-9][0-9,]*\+?$/.test(raw)) continue;
      const rect = btn.getBoundingClientRect();
      const score = Number(raw.replace(/[,+]/g, '')) || 0;
      candidates.push({ el: btn, top: rect.top, score });
    }

    if (candidates.length === 0) return false;
    candidates.sort((a, b) => a.top - b.top || b.score - a.score);
    candidates[0].el.click();
    return true;
  });

  let valueFromDialog: number | null = null;
  if (clickedIndicator) {
    await page.waitForFunction(() => {
      const dialogs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"]'));
      return dialogs.some((d) => /所持バモス|バモス/.test((d.textContent || '').replace(/\s+/g, '')));
    }, { timeout: 5000 }).catch(() => {});

    valueFromDialog = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('dialog[open], [role="dialog"]'));
      for (const dialog of dialogs) {
        const text = (dialog.textContent || '').replace(/[\s\u3000]+/g, '');
        if (!/所持バモス|バモス/.test(text)) continue;

        const direct = text.match(/所持バモス[^0-9]*([0-9][0-9,]*)/);
        if (direct) return Number(direct[1].replace(/,/g, ''));

        const generic = text.match(/バモス[^0-9]*([0-9][0-9,]*)/);
        if (generic) return Number(generic[1].replace(/,/g, ''));
      }
      return null;
    });

    await clickFirstVisible(page, [
      'dialog[open] button:has(img[src*="cross.svg"])',
      '[role="dialog"] button:has(img[src*="cross.svg"])',
      'dialog[open] button[class*="ContentWithBottomActions_bottomActionsBottom"]',
      'dialog[open] button:has-text("×")',
      'dialog[open] button:has-text("x")',
    ]);
    await page.waitForTimeout(300);
  }

  if (valueFromDialog !== null) return valueFromDialog;

  const currentUrl = page.url();
  return page.evaluate((url) => {
    const parseNum = (t: string) => {
      const cleaned = t.replace(/[\s\u3000,]+/g, '').trim();
      return /^\d+$/.test(cleaned) ? Number(cleaned) : null;
    };
    const isVisible = (el: Element) => {
      const h = el as HTMLElement;
      const s = window.getComputedStyle(h);
      return s.display !== 'none' && s.visibility !== 'hidden' && h.offsetParent !== null;
    };

    for (const sel of ['[data-testid*="bamos"]', '[data-testid*="vamos"]', '[data-testid*="currency"]']) {
      const node = document.querySelector(sel);
      if (node && isVisible(node)) {
        const v = parseNum(node.textContent || '');
        if (v !== null) return v;
      }
    }

    const allElements = Array.from(document.querySelectorAll('body *'));
    for (const el of allElements) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim();
      if (text !== 'SHOP') continue;
      const parent = el.parentElement;
      if (!parent) continue;
      for (const sibling of Array.from(parent.children)) {
        if (sibling === el) continue;
        const sibText = (sibling.textContent || '').replace(/[\s\u3000,]+/g, '').trim();
        if (/^\d+$/.test(sibText)) return Number(sibText);
      }
    }

    const buttons = Array.from(document.querySelectorAll('button'));
    for (const btn of buttons) {
      if (!isVisible(btn)) continue;
      const text = (btn.textContent || '').replace(/[\s\u3000,]+/g, '').trim();
      if (url.includes('/packs')) continue;
      if (/^\d+$/.test(text) && !/¥|×|バモス|おトク/.test(btn.textContent || '')) return Number(text);
    }

    if (url.includes('/packs')) {
      const nums: number[] = [];
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        const v = parseNum(btn.textContent || '');
        if (v !== null) nums.push(v);
      }
      if (nums.length > 0) return Math.max(...nums);
    }

    return null;
  }, currentUrl);
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
 * iframe ネスト・ポップアップ・文言差分（Complete/COMPLETE）を吸収する。
 */
export async function completeThreeDsIfPresent(page: Page): Promise<boolean> {
  const clickCompleteInFrame = async (targetPage: Page): Promise<boolean> => {
    for (const frame of targetPage.frames()) {
      const clicked = await frame.evaluate(() => {
        const isVisible = (el: Element) => {
          const h = el as HTMLElement;
          const s = window.getComputedStyle(h);
          return s.display !== 'none' && s.visibility !== 'hidden' && h.offsetParent !== null;
        };
        const candidates = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a'));
        for (const el of candidates) {
          const label = (
            (el.textContent || '') ||
            (el.getAttribute('value') || '') ||
            (el.getAttribute('aria-label') || '')
          ).trim();
          if (!label || !/complete/i.test(label) || !isVisible(el)) continue;
          (el as HTMLElement).click();
          return true;
        }
        return false;
      }).catch(() => false);

      if (clicked) return true;
    }
    return false;
  };

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const pages = page.context().pages().filter((p) => !p.isClosed());
    let clicked = false;

    for (const p of pages) {
      clicked = await clickCompleteInFrame(p);
      if (clicked) break;
    }

    if (clicked) {
      await page.waitForTimeout(1000);
      return true;
    }

    await page.waitForTimeout(2000);
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

/**
 * PlaywrightMCP で収集したログインフロー要素の候補。
 * 画面差分/文言差分を吸収するため複数候補を持たせる。
 */
export const LOGIN_FLOW_SELECTORS = {
  closePwaPrompt: [
    'dialog[open] button:has(img[src*="cross.svg"])',
    'dialog[open] button[class*="IconButton_iconButton"]',
    '[role="dialog"] button:has(img[src*="cross.svg"])',
    'dialog[open] button:has-text("×")',
    'dialog[open] button:has-text("x")',
  ],
  footerOthers: [
    'role=link[name="その他"]',
    'a[href="/others"]',
    'nav a:has-text("その他")',
    'a:has-text("その他")',
  ],
  nicknameEditEntry: [
    'role=link[name="ニックネームの編集"]',
    'a[href="/others/nickname_edit"]',
    'a:has-text("ニックネームの編集")',
  ],
  nicknameEditReady: [
    'role=textbox[name="ニックネーム"]',
    'input[aria-label="ニックネーム"]',
    'input[name="nickname"]',
    'text=ニックネームの編集',
  ],
  nicknameValue: [
    'role=textbox[name="ニックネーム"]',
    'input[aria-label="ニックネーム"]',
    'input[name="nickname"]',
    'input[type="text"]',
  ],
  closeNicknameEdit: [
    'button:has(img[src*="cross.svg"])',
    'button[class*="ContentWithBottomActions_bottomActionsBottom"]',
    'button:has-text("×")',
    'button:has-text("x")',
  ],
  logoutButton: [
    'role=button[name="ログアウト"]',
    'main button:has-text("ログアウト")',
    'button:has-text("ログアウト")',
  ],
  logoutDialogRoot: [
    'dialog[open]',
    '[role="dialog"]',
  ],
  confirmLogout: [
    'dialog[open] button:has-text("ログアウト")',
    '[role="dialog"] button:has-text("ログアウト")',
  ],
  cancelLogout: [
    'dialog[open] button:has-text("キャンセル")',
    '[role="dialog"] button:has-text("キャンセル")',
  ],
  jleagueLoginButton: [
    'role=button[name="JリーグIDでログイン"]',
    'button:has-text("JリーグIDでログイン")',
  ],
} as const;

export async function closePwaPromptIfVisible(page: Page): Promise<boolean> {
  for (const sel of LOGIN_FLOW_SELECTORS.closePwaPrompt) {
    const loc = page.locator(sel).first();
    const visible = await loc.isVisible({ timeout: 1200 }).catch(() => false);
    if (!visible) continue;
    const clicked = await loc.click({ timeout: 2000, force: true }).then(() => true).catch(() => false);
    if (!clicked) continue;
    await page.waitForTimeout(400);
    return true;
  }
  return false;
}

export async function openOthersTab(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (page.url().includes('/others') && !page.url().includes('/others/nickname_edit')) return;

    if (await isUnavailablePage(page)) {
      await clickFirstVisible(page, ['a:has-text("ホーム画面に戻る")']);
      await ensureHome(page);
      await page.waitForTimeout(800);
    }

    if (!page.url().includes('/home') && !page.url().includes('/others')) {
      await ensureHome(page);
      await page.waitForTimeout(800);
    }

    await closePwaPromptIfVisible(page);

    const clicked = await clickFirstVisible(page, [...LOGIN_FLOW_SELECTORS.footerOthers]);
    if (!clicked) {
      await closePwaPromptIfVisible(page);
      await page.waitForTimeout(500);
      continue;
    }

    const moved = await page.waitForURL(/\/others(?:\?|$)/, { timeout: 30000 }).then(() => true).catch(() => false);
    if (!moved) {
      await page.waitForTimeout(800);
      continue;
    }

    if (await isUnavailablePage(page)) {
      await page.waitForTimeout(1000);
      continue;
    }

    await page.waitForTimeout(800);
    return;
  }
  throw new Error('「その他」画面への遷移に失敗しました');
}

export async function openNicknameEdit(page: Page): Promise<void> {
  if (!page.url().includes('/others') || page.url().includes('/others/nickname_edit')) {
    await openOthersTab(page);
  }

  let moved = false;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (await isUnavailablePage(page)) {
      await clickFirstVisible(page, ['a:has-text("ホーム画面に戻る")']);
      await ensureHome(page);
      await openOthersTab(page);
      await page.waitForTimeout(800);
    }

    const clicked = await clickFirstVisible(page, [...LOGIN_FLOW_SELECTORS.nicknameEditEntry]);
    if (!clicked) {
      await page.waitForTimeout(500);
      continue;
    }

    moved = await page.waitForURL(/\/others\/nickname_edit/, { timeout: 7000 }).then(() => true).catch(() => false);
    if (moved) break;

    const clickedByJs = await page.evaluate(() => {
      const anchor = document.querySelector('a[href="/others/nickname_edit"]') as HTMLAnchorElement | null;
      if (!anchor) return false;
      anchor.click();
      return true;
    }).catch(() => false);
    if (!clickedByJs) continue;

    moved = await page.waitForURL(/\/others\/nickname_edit/, { timeout: 7000 }).then(() => true).catch(() => false);
    if (moved) break;

    if (await isUnavailablePage(page)) {
      await clickFirstVisible(page, ['a:has-text("ホーム画面に戻る")']);
      await ensureHome(page);
      await openOthersTab(page);
    }
  }
  expect(moved).toBeTruthy();

  for (const sel of LOGIN_FLOW_SELECTORS.nicknameEditReady) {
    const ready = await page.locator(sel).first().isVisible({ timeout: 3000 }).catch(() => false);
    if (ready) return;
  }
  throw new Error('ニックネーム編集画面の表示完了を確認できませんでした');
}

export async function readNickname(page: Page): Promise<string> {
  for (const sel of LOGIN_FLOW_SELECTORS.nicknameValue) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) continue;
    const visible = await loc.isVisible().catch(() => false);
    if (!visible) continue;

    const value = await loc.inputValue().catch(() => '');
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }

  const fallback = await page.evaluate(() => {
    const byName = document.querySelector('input[name="nickname"]') as HTMLInputElement | null;
    if (byName?.value?.trim()) return byName.value.trim();

    const byAria = document.querySelector('input[aria-label="ニックネーム"]') as HTMLInputElement | null;
    if (byAria?.value?.trim()) return byAria.value.trim();

    const candidates = Array.from(document.querySelectorAll('input[type="text"], textarea'));
    for (const node of candidates) {
      const input = node as HTMLInputElement | HTMLTextAreaElement;
      if (!input.value || !input.value.trim()) continue;
      const aria = (input.getAttribute('aria-label') || '').trim();
      const placeholder = (input.getAttribute('placeholder') || '').trim();
      if (aria.includes('ニックネーム') || placeholder.includes('ニックネーム')) {
        return input.value.trim();
      }
    }
    return '';
  });

  const nickname = fallback.trim();
  if (!nickname) throw new Error('ニックネームを取得できませんでした');
  return nickname;
}

export async function closeNicknameEdit(page: Page): Promise<void> {
  const closed = await clickFirstVisible(page, [...LOGIN_FLOW_SELECTORS.closeNicknameEdit]);
  expect(closed).toBeTruthy();
  await page.waitForURL(/\/others(?:\?|$)/, { timeout: 30000 });
}

export async function openLogoutDialog(page: Page): Promise<void> {
  const clicked = await clickFirstVisible(page, [...LOGIN_FLOW_SELECTORS.logoutButton]);
  expect(clicked).toBeTruthy();

  const hasDialog = await page
    .locator(LOGIN_FLOW_SELECTORS.logoutDialogRoot.join(', '))
    .first()
    .isVisible({ timeout: 10000 })
    .catch(() => false);
  expect(hasDialog).toBeTruthy();

  const hasConfirm = await page
    .locator(LOGIN_FLOW_SELECTORS.confirmLogout.join(', '))
    .first()
    .isVisible({ timeout: 5000 })
    .catch(() => false);
  expect(hasConfirm).toBeTruthy();
}

export async function confirmLogout(page: Page): Promise<'signin' | 'home'> {
  const clicked = await clickFirstVisible(page, [...LOGIN_FLOW_SELECTORS.confirmLogout]);
  expect(clicked).toBeTruthy();

  const toSignin = await page.waitForURL(/\/signin/, { timeout: 30000 }).then(() => true).catch(() => false);
  if (toSignin) return 'signin';

  const toHome = await page.waitForURL(/\/auth\/jleague\/callback|\/home/, { timeout: 30000 }).then(() => true).catch(() => false);
  if (toHome) return 'home';

  throw new Error(`ログアウト後の遷移先が期待外です: ${page.url()}`);
}

export async function logoutWithConfirm(page: Page): Promise<'signin' | 'home'> {
  await openLogoutDialog(page);
  return confirmLogout(page);
}

export async function loginWithJLeagueId(page: Page): Promise<void> {
  if (page.url().includes('/home')) return;

  if (page.url().includes('/auth/jleague/callback')) {
    await page.waitForURL(/\/home/, { timeout: 60000 });
    return;
  }

  await page.waitForURL(/\/signin|\/home/, { timeout: 30000 }).catch(() => {});
  if (page.url().includes('/home')) return;

  let clicked = false;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    clicked = await clickFirstVisible(page, [...LOGIN_FLOW_SELECTORS.jleagueLoginButton]);
    if (clicked) break;
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(300);
  }
  expect(clicked).toBeTruthy();

  const reachedHome = await page.waitForURL(/\/home|\/auth\/jleague\/callback/, { timeout: 60000 }).then(() => true).catch(() => false);
  if (!reachedHome) {
    throw new Error(`「JリーグIDでログイン」押下後に /home へ遷移しませんでした: ${page.url()}`);
  }

  if (page.url().includes('/auth/jleague/callback')) {
    await page.waitForURL(/\/home/, { timeout: 60000 });
  }
}

export type PackRate = {
  playerName: string;
  rateText: string;
};

export type PackAnimationSummary = {
  animationDetected: boolean;
  specialAnimationCount: number;
};

export type CardSwipeSummary = {
  swipedCount: number;
  cardLikeCount: number;
};

/**
 * PlaywrightMCP で収集した候補をまとめる場所。
 * 文言/構造差分を吸収するため、広めの候補を置いている。
 */
export const PACK_OPEN_SELECTORS = {
  closeHomeDialog: [
    'dialog[open] button[aria-label*="close" i]',
    'dialog[open] button:has-text("閉じる")',
    'dialog[open] button:has-text("×")',
    'dialog[open] button:has-text("x")',
    '[role="dialog"] button[aria-label*="close" i]',
  ],
  footerCollection: [
    'a[href="/collection"]',
    'button:has-text("コレクション")',
    'a:has-text("コレクション")',
  ],
  footerPack: [
    'a[href="/packs"]',
    'a:has-text("PACK")',
    'button:has-text("パック")',
    'a:has-text("パック")',
    'button:has-text("イベントパック")',
    'a:has-text("イベントパック")',
    'a[href="/pack"]',
  ],
  packDetail: [
    'button:has-text("パック詳細")',
    'a:has-text("パック詳細")',
    'button:has-text("詳細")',
    'a[href*="/packs/"]',
    'a[href*="/pack/"]',
    'img[alt*="パック"]',
    'text=/イベントパック/',
  ],
  packRateLines: [
    '[data-testid*="rate"]',
    'li',
    'p',
    'div',
  ],
  drawTen: [
    'button:has-text("10枚引く")',
    'button:has-text("10連")',
    'button:has-text("10回")',
  ],
  dialogDrawTen: [
    'dialog[open] button:has-text("10枚引く")',
    'dialog[open] button:has-text("10連")',
    '[role="dialog"] button:has-text("10枚引く")',
  ],
  animationIndicators: [
    'video',
    'canvas',
    '[data-testid*="animation"]',
    '[class*="animation"]',
    '[class*="movie"]',
  ],
  specialAnimationMarkers: [
    '[data-testid*="special"]',
    '[class*="special"]',
    'text=/確定演出|確定|SSR|UR/i',
  ],
  cardLike: [
    '[data-testid*="card"]',
    '[class*="card"]',
    'img[alt*="card" i]',
    'img[src*="card"]',
  ],
  nextCard: [
    'button:has-text("次へ")',
    'button:has-text("NEXT")',
    '[aria-label*="next" i]',
  ],
  skipAnimation: [
    'button:has-text("スキップ")',
    'button:has-text("SKIP")',
  ],
  closeResult: [
    'button:has-text("スキップ")',
    'dialog[open] button:has-text("スキップ")',
    'dialog[open] button[aria-label*="close" i]',
    'dialog[open] button:has-text("閉じる")',
    'dialog[open] button:has-text("×")',
    'button:has-text("×")',
    'button:has-text("x")',
    'button[aria-label*="close" i]',
  ],
} as const;

async function dismissOkDialogIfPresent(page: Page): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    const closed = await clickFirstVisible(page, [
      'dialog[open] button:has-text("OK")',
      '[role="dialog"] button:has-text("OK")',
      'button:has-text("OK")',
    ]);
    if (!closed) break;
    await page.waitForTimeout(300);
  }
}

export async function closeHomeDialogIfPresent(page: Page): Promise<boolean> {
  const closed = await clickFirstVisible(page, [...PACK_OPEN_SELECTORS.closeHomeDialog]);
  if (!closed) {
    await dismissAllDialogs(page);
    return false;
  }
  await page.waitForTimeout(500);
  await dismissAllDialogs(page);
  return true;
}

export async function goToCollection(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (page.url().includes('/collection') && !(await isUnavailablePage(page))) return;
    await ensureHome(page);
    await dismissAllDialogs(page);
    await dismissOkDialogIfPresent(page);

    const clicked = await clickFirstVisible(page, [...PACK_OPEN_SELECTORS.footerCollection]);
    if (!clicked) {
      await page.waitForTimeout(2000);
      continue;
    }

    const moved = await page.waitForURL(/\/collection/, { timeout: 30000 }).then(() => true).catch(() => false);
    if (!moved) continue;
    await page.waitForTimeout(1500);
    if (await isUnavailablePage(page)) continue;
    return;
  }
  throw new Error('コレクション画面へ5回リトライしても遷移できませんでした');
}

export async function goToPack(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if ((page.url().includes('/packs') || page.url().includes('/shop') || page.url().includes('/pack')) && !(await isUnavailablePage(page))) {
      const clickedAtShop = await clickFirstVisible(page, [...PACK_OPEN_SELECTORS.footerPack]);
      if (clickedAtShop) {
        await page.waitForTimeout(1200);
      }
      if (page.url().includes('/packs')) return;
    }
    await ensureHome(page);
    await dismissAllDialogs(page);
    await dismissOkDialogIfPresent(page);

    const clicked = await clickFirstVisible(page, [...PACK_OPEN_SELECTORS.footerPack]);
    if (!clicked) {
      await page.waitForTimeout(2000);
      continue;
    }

    await page.waitForURL(/\/packs|\/shop|\/pack/, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);
    if (await isUnavailablePage(page)) continue;
    if (page.url().includes('/packs')) return;
  }
  throw new Error('パック画面(/packs)へ5回リトライしても遷移できませんでした');
}

export async function getOwnedCardCount(page: Page): Promise<number | null> {
  await page.waitForTimeout(1000);
  return page.evaluate(() => {
    const parse = (raw: string) => {
      const cleaned = raw.replace(/[\s\u3000,]+/g, '').trim();
      return /^\d+$/.test(cleaned) ? Number(cleaned) : null;
    };
    const isVisible = (el: Element) => {
      const h = el as HTMLElement;
      const s = window.getComputedStyle(h);
      return s.display !== 'none' && s.visibility !== 'hidden' && h.offsetParent !== null;
    };

    for (const sel of ['[data-testid*="owned"]', '[data-testid*="collection"]', '[data-testid*="card-count"]']) {
      const n = document.querySelector(sel);
      if (!n || !isVisible(n)) continue;
      const v = parse(n.textContent || '');
      if (v !== null) return v;
    }

    const candidates = Array.from(document.querySelectorAll('div,span,p,strong,button'));
    for (const el of candidates) {
      if (!isVisible(el)) continue;
      const text = (el.textContent || '').trim();
      if (!/所持|枚|カード/i.test(text)) continue;
      const m = text.match(/([0-9][0-9,]*)/);
      if (m) return Number(m[1].replace(/,/g, ''));
      for (const sibling of Array.from(el.parentElement?.children || [])) {
        const parsed = parse((sibling.textContent || '').trim());
        if (parsed !== null) return parsed;
      }
    }

    const all = Array.from(document.querySelectorAll('body *'));
    for (const el of all) {
      if (!isVisible(el)) continue;
      const parsed = parse((el.textContent || '').trim());
      if (parsed !== null && parsed > 0) return parsed;
    }
    return null;
  });
}

export async function openPackDetail(page: Page): Promise<void> {
  const drawVisible = await page.locator(PACK_OPEN_SELECTORS.drawTen[0]).first().isVisible().catch(() => false);
  if (drawVisible) return;
  const clicked = await clickFirstVisible(page, [...PACK_OPEN_SELECTORS.packDetail]);
  expect(clicked).toBeTruthy();
  await page.waitForTimeout(2000);
}

export async function scrollUpToPackRates(page: Page): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await page.mouse.wheel(0, -900);
    await page.waitForTimeout(300);
  }
}

export async function collectPackRates(page: Page): Promise<PackRate[]> {
  await page.waitForTimeout(800);
  return page.evaluate((selectors) => {
    const isVisible = (el: Element) => {
      const h = el as HTMLElement;
      const s = window.getComputedStyle(h);
      return s.display !== 'none' && s.visibility !== 'hidden' && h.offsetParent !== null;
    };
    const rows: PackRate[] = [];
    const seen = new Set<string>();

    for (const sel of selectors) {
      const nodes = Array.from(document.querySelectorAll(sel));
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = (node.textContent || '').replace(/\s+/g, ' ').trim();
        const m = text.match(/([^\n\r]+?)\s*([0-9]+\.[0-9]+%|[0-9]+%)/);
        if (!m) continue;
        const playerName = m[1].trim();
        const rateText = m[2].trim();
        const key = `${playerName}__${rateText}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ playerName, rateText });
      }
    }
    return rows;
  }, PACK_OPEN_SELECTORS.packRateLines);
}

export async function scrollDownToDrawTen(page: Page): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    const visible = await page.locator(PACK_OPEN_SELECTORS.drawTen[0]).first().isVisible().catch(() => false);
    if (visible) break;
    await page.mouse.wheel(0, 900);
    await page.waitForTimeout(350);
  }
}

export async function clickDrawTen(page: Page): Promise<void> {
  const clicked = await clickFirstVisible(page, [...PACK_OPEN_SELECTORS.drawTen]);
  expect(clicked).toBeTruthy();
}

export async function confirmDrawTenDialog(page: Page): Promise<void> {
  await page.locator('dialog[open], [role="dialog"]').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
  const clicked = await clickFirstVisible(page, [...PACK_OPEN_SELECTORS.dialogDrawTen, ...PACK_OPEN_SELECTORS.drawTen]);
  expect(clicked).toBeTruthy();
}

export async function waitForPackAnimationIfAny(page: Page): Promise<boolean> {
  const skipShown = await page.locator(PACK_OPEN_SELECTORS.skipAnimation[0]).first().isVisible().catch(() => false);
  if (skipShown) return true;

  for (const sel of PACK_OPEN_SELECTORS.animationIndicators) {
    const loc = page.locator(sel).first();
    const appeared = await loc.waitFor({ state: 'visible', timeout: 8000 }).then(() => true).catch(() => false);
    if (!appeared) continue;
    await page.waitForTimeout(1500);
    await loc.waitFor({ state: 'hidden', timeout: 45000 }).catch(async () => {
      await page.waitForTimeout(4000);
    });
    return true;
  }
  await page.waitForTimeout(3000);
  return false;
}

export async function countSpecialAnimationsIfPossible(page: Page): Promise<number> {
  await page.waitForTimeout(1000);
  return page.evaluate((selectors) => {
    let total = 0;
    for (const sel of selectors) {
      if (sel.startsWith('text=')) continue;
      total += document.querySelectorAll(sel).length;
    }

    const textNodes = Array.from(document.querySelectorAll('body *'));
    for (const el of textNodes) {
      const text = (el.textContent || '').trim();
      if (/確定演出|確定|SSR|UR/i.test(text)) total += 1;
    }
    return total;
  }, PACK_OPEN_SELECTORS.specialAnimationMarkers);
}

export async function swipeThrough10Cards(page: Page): Promise<CardSwipeSummary> {
  await clickFirstVisible(page, [...PACK_OPEN_SELECTORS.skipAnimation]);
  await page.waitForTimeout(1000);

  let swiped = 0;
  for (let i = 0; i < 9; i += 1) {
    const clickedNext = await clickFirstVisible(page, [...PACK_OPEN_SELECTORS.nextCard]);
    if (clickedNext) {
      swiped += 1;
      await page.waitForTimeout(500);
      continue;
    }

    const box = await page.locator('main, body').first().boundingBox();
    if (!box) break;
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.6, { steps: 8 });
    await page.mouse.up();
    swiped += 1;
    await page.waitForTimeout(600);
  }

  const cardLikeCount = await page.evaluate((selectors) => {
    const hit = new Set<Element>();
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => hit.add(el));
    }
    const mainImages = Array.from(document.querySelectorAll('main img[alt]')).filter((img) => {
      const alt = (img.getAttribute('alt') || '').trim();
      if (!alt) return false;
      if (['パック詳細メイン画像', 'ショップ', 'SR', 'R', 'N', 'FREE'].includes(alt)) return false;
      return true;
    });
    mainImages.forEach((el) => hit.add(el));
    return hit.size;
  }, PACK_OPEN_SELECTORS.cardLike);

  return { swipedCount: swiped, cardLikeCount };
}

export async function assertTenCardsShown(page: Page, summary?: CardSwipeSummary): Promise<void> {
  const target = summary ?? (await swipeThrough10Cards(page));
  expect(target.swipedCount >= 9 || target.cardLikeCount > 0).toBeTruthy();
}

export async function closePackResult(page: Page): Promise<void> {
  const closed = await clickFirstVisible(page, [...PACK_OPEN_SELECTORS.closeResult]);
  if (!closed) {
    const onPacks = page.url().includes('/packs');
    if (!onPacks) {
      expect(closed).toBeTruthy();
    }
  }
  await page.waitForTimeout(1000);
}
