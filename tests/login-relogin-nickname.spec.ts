import { test, expect } from '@playwright/test';
import {
  closeNicknameEdit,
  closePwaPromptIfVisible,
  confirmLogout,
  ensureHome,
  loginWithJLeagueId,
  openLogoutDialog,
  openNicknameEdit,
  openOthersTab,
  readNickname,
} from './flow-helpers';

test('ログアウト〜ログイン再実行（login-relogin-nickname）', async ({ page }) => {
  test.setTimeout(300000);

  let nicknameBefore = '';
  let nicknameAfter = '';
  let logoutResult: 'signin' | 'home' = 'signin';

  await test.step('1 前準備: 認証突破してログイン（/home）', async () => {
    await ensureHome(page);
    await expect(page).toHaveURL(/\/home/, { timeout: 30000 });
    console.log(`[step1:url] ${page.url()}`);
  });

  await test.step('2 PWA訴求を閉じる（ホームで×）', async () => {
    const closed = await closePwaPromptIfVisible(page);
    console.log(`[step2:pwaClosed] ${closed}`);
  });

  await test.step('3 「その他」を開く（/others）', async () => {
    await openOthersTab(page);
    await expect(page).toHaveURL(/\/others(?:\?|$)/, { timeout: 30000 });
    console.log(`[step3:url] ${page.url()}`);
  });

  await test.step('4 ニックネームの確認（/others/nickname_edit で取得）', async () => {
    await openNicknameEdit(page);
    nicknameBefore = await readNickname(page);
    console.log(`[step4:nicknameBefore] ${nicknameBefore}`);
    expect(nicknameBefore.length).toBeGreaterThan(0);
  });

  await test.step('5 「その他」に戻る（×で閉じる）', async () => {
    await closeNicknameEdit(page);
    await expect(page).toHaveURL(/\/others(?:\?|$)/, { timeout: 30000 });
    console.log(`[step5:url] ${page.url()}`);
  });

  await test.step('6 ログアウト（/others でログアウト→確認ダイアログ）', async () => {
    await openLogoutDialog(page);
    console.log('[step6:logoutDialog] opened');
  });

  await test.step('7 ログアウト確定（/signinへ）', async () => {
    logoutResult = await confirmLogout(page);
    console.log(`[step7:logoutResult] ${logoutResult}`);
    expect(['signin', 'home']).toContain(logoutResult);
  });

  await test.step('8 ログイン（サインイン画面で「JリーグIDでログイン」→ホーム）', async () => {
    await loginWithJLeagueId(page);
    await expect(page).toHaveURL(/\/home/, { timeout: 60000 });
    console.log(`[step8:url] ${page.url()}`);
  });

  await test.step('9 PWA訴求を閉じる（ホームで×）', async () => {
    const closed = await closePwaPromptIfVisible(page);
    console.log(`[step9:pwaClosed] ${closed}`);
  });

  await test.step('10 「その他」を開く（/others）', async () => {
    await openOthersTab(page);
    await expect(page).toHaveURL(/\/others(?:\?|$)/, { timeout: 30000 });
    console.log(`[step10:url] ${page.url()}`);
  });

  await test.step('11 ニックネームの確認（/others/nickname_edit で取得）', async () => {
    await openNicknameEdit(page);
    nicknameAfter = await readNickname(page);
    console.log(`[step11:nicknameAfter] ${nicknameAfter}`);
    expect(nicknameAfter.length).toBeGreaterThan(0);
  });

  await test.step('12 ログインできたか確認（手順4と11のニックネーム一致）', async () => {
    console.log(`[step12:compare] before=${nicknameBefore}, after=${nicknameAfter}`);
    expect(nicknameBefore).toBe(nicknameAfter);
  });
});
