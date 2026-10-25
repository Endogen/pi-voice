import { test, expect, fail } from './fixture.mjs';
import { fileURLToPath } from 'node:url';

async function chooseLocal(page) {
  await page.locator('#open-settings').click();
  await expect(page.locator('#model-choice')).toBeEnabled();
  await page.locator('#model-filter').fill('qwen/model');
  await page.locator('#model-choice').selectOption(JSON.stringify(['local', 'qwen/model:Q5']));
}

test('real dialogs, select filtering, image decoding and Enter preserve the draft across a model change', async ({ page, app }) => {
  await page.locator('#draft').fill('Keep this draft');
  await page.locator('#draft').press('Enter');
  await expect(page.locator('#draft')).toHaveValue('Keep this draft\n');
  expect(app.requests.filter((r) => r.path === '/api/prompt')).toHaveLength(0);
  await page.locator('#image-input').setInputFiles(fileURLToPath(new URL('../../public/icon-192.png', import.meta.url)));
  await expect(page.locator('#attachments img')).toBeVisible();
  await chooseLocal(page);
  await expect(page.locator('#model-details')).toContainText('Text only');
  await page.locator('#model-apply').click();
  await expect(page.locator('#model-status')).toContainText('Using local/');
  await page.locator('#close-settings').click();
  await expect(page.locator('#draft')).toHaveValue('Keep this draft\n');
  await expect(page.locator('#attachments img')).toBeVisible();
  await expect(page.locator('#send')).toBeDisabled();
  expect(app.requests.filter((r) => r.path === '/api/model')).toHaveLength(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('a delayed state response cannot undo a session switch or lose a draft', async ({ page, app }) => {
  await page.locator('#draft').fill('Unsent across sessions');
  const held = app.holdNextState(app.state.handle);
  await held.started;
  await page.locator('#open-sessions').click();
  await page.locator('#session-list .session-row').filter({ hasText: 'Second session' }).click();
  held.release();
  await expect(page.locator('#session-title')).toHaveText('Second session');
  await expect(page.locator('#draft')).toHaveValue('Unsent across sessions');
  await expect.poll(() => app.selected).toBe('session-second');
  expect(app.requests.filter((r) => r.path === '/api/prompt')).toHaveLength(0);
});

test('a lost model acknowledgement waits for a fresh poll and never repeats the mutation', async ({ page, app }) => {
  await page.locator('#draft').fill('Wait for the model');
  await chooseLocal(page);
  const held = app.holdNextState(app.state.handle);
  await held.started;
  app.onModel = async (_body, state) => { state.modelSwitching = true; throw fail(502, 'Acknowledgement lost'); };
  await page.locator('#model-apply').click();
  await expect.poll(() => app.requests.filter((r) => r.path === '/api/model').length).toBe(1);
  await expect(page.locator('#send')).toBeDisabled();
  held.release();
  await expect(page.locator('#model-status')).toContainText('model change is in progress');
  await expect(page.locator('#send')).toBeDisabled();
  app.choose(app.state, app.models[1]);
  await expect(page.locator('#model-status')).toContainText('Pi confirms');
  await page.locator('#close-settings').click();
  await expect(page.locator('#send')).toBeEnabled();
  expect(app.requests.filter((r) => r.path === '/api/model')).toHaveLength(1);
});

test('a failed model turn is visible instead of silently dropping back to an idle screen', async ({ page, app }) => {
  app.state.messages = [
    { id: 'user-one', role: 'user', text: 'Continue the task' },
    { id: 'error-one', role: 'assistant', text: '', stopReason: 'error', error: 'Connection reset while the screen was off' },
  ];
  await expect(page.locator('#latest-answer')).toContainText('Pi could not finish this reply');
  await expect(page.locator('#latest-answer')).toContainText('Connection reset');
  await expect(page.locator('#thinking')).toBeHidden();
  await page.locator('#open-history').click();
  await expect(page.locator('#messages')).toContainText('Connection reset');
  expect(app.requests.filter((r) => r.path === '/api/prompt')).toHaveLength(0);
});

test('a notification switches to its exact conversation using the native callback without sending the draft', async ({ page, app }) => {
  await page.locator('#draft').fill('Do not send while opening notification');
  await page.locator('#open-settings').click();
  const target = app.states[1];
  const accepted = await page.evaluate(({ handle, sessionId }) => window.__piVoiceOpenSession(handle, sessionId), target);
  expect(accepted).toBe(true);
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  await expect(page.locator('#session-title')).toHaveText('Second session');
  await expect(page.locator('#draft')).toHaveValue('Do not send while opening notification');
  await expect.poll(() => app.selected).toBe(target.handle);
  expect(app.requests.filter((r) => r.path === '/api/prompt')).toHaveLength(0);
});
