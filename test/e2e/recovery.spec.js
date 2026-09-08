/* Crash recovery.
 *
 * Android kills backgrounded tabs without warning, so the app writes audio
 * chunks and finalised transcript lines to IndexedDB as they are captured.
 * These tests kill the page mid-recording — no stop, no save — and assert the
 * meeting comes back.
 */

import { expect, test } from '@playwright/test';

/** Read the in-progress session row, or null. */
function readLiveSession(page) {
  return page.evaluate(async () => {
    const db = await import('/js/db.js');
    return (await db.getLiveSession()) ?? null;
  });
}

/**
 * Start a recording and wait until chunks have actually reached storage.
 * Polled from the test process — `waitForFunction` treats the promise an async
 * predicate returns as truthy, so it would not wait at all here.
 */
async function recordUntilPersisted(page, { minChunks = 2 } = {}) {
  await page.click('.rec-btn');
  await expect(page.locator('.rec-btn')).toHaveAttribute('data-state', 'recording');

  await expect
    .poll(async () => (await readLiveSession(page))?.chunkCount ?? 0, { timeout: 20_000 })
    .toBeGreaterThanOrEqual(minChunks);
}

/** Append transcript lines the way the recogniser would, and persist them. */
async function injectTranscript(page, lines) {
  await page.evaluate(async (texts) => {
    const db = await import('/js/db.js');
    // Spaced well beyond the merge and speaker-split thresholds so each line
    // stays its own segment through finalisation.
    const segments = texts.map((text, i) => ({
      id: `inj${i}`,
      start: i * 12_000,
      end: i * 12_000 + 4000,
      text,
      confidence: 0.9,
      speaker: null,
    }));
    await db.updateLiveSession({ segments, durationMs: texts.length * 12_000 });
  }, lines);
}

test('an interrupted recording is offered back and recovers with its audio and transcript', async ({ page }) => {
  await page.goto('/');
  await recordUntilPersisted(page);
  await injectTranscript(page, [
    'We should ship the rollout plan this week.',
    'I will send the summary to the team on Friday.',
  ]);

  const live = await readLiveSession(page);
  expect(live.chunkCount).toBeGreaterThan(0);
  expect(live.meetingId).toBeTruthy();

  // Kill the tab mid-recording: no stop, no save, no beforeunload handling.
  await page.goto('about:blank');
  await page.goto('/');

  const sheet = page.locator('.sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText('Unsaved recording found');

  await page.click('.sheet button:has-text("Recover it")');

  // Recovery lands on the meeting it rebuilt.
  await expect(page).toHaveURL(/#\/meeting\//);
  await page.click('.tabs button:has-text("Transcript")');
  await expect(page.locator('.seg')).toHaveCount(2);
  await expect(page.locator('.seg').first()).toContainText('ship the rollout plan');
  await expect(page.locator('.seg').last()).toContainText('summary to the team on Friday');

  // The audio survived as a playable blob, not just the words.
  const saved = await page.evaluate(async () => {
    const db = await import('/js/db.js');
    const [meeting] = await db.listMeetings();
    const blob = await db.getAudio(meeting.id);
    return { hasAudio: meeting.hasAudio, recovered: meeting.recovered, size: blob ? blob.size : 0 };
  });
  expect(saved.recovered).toBe(true);
  expect(saved.hasAudio).toBe(true);
  expect(saved.size).toBeGreaterThan(0);

  // The live session is cleared, so the prompt does not come back.
  await page.goto('/');
  await expect(page.locator('.sheet')).toBeHidden();
});

test('discarding an interrupted recording clears it for good', async ({ page }) => {
  await page.goto('/');
  await recordUntilPersisted(page);
  await injectTranscript(page, ['Something not worth keeping.']);

  await page.goto('about:blank');
  await page.goto('/');

  await expect(page.locator('.sheet')).toContainText('Unsaved recording found');
  await page.click('.sheet button:has-text("Discard it")');

  await expect.poll(() => readLiveSession(page)).toBeNull();
  const count = await page.evaluate(async () => {
    const db = await import('/js/db.js');
    return (await db.listMeetings()).length;
  });
  expect(count).toBe(0);

  await page.goto('/');
  await expect(page.locator('.sheet')).toBeHidden();
});

test('starting a new recording will not silently destroy an unrecovered one', async ({ page }) => {
  await page.goto('/');
  await recordUntilPersisted(page);
  await injectTranscript(page, ['The earlier meeting that must not be lost.']);
  const firstId = (await readLiveSession(page)).meetingId;

  await page.goto('about:blank');
  await page.goto('/');

  // Defer the decision, then try to record over it.
  await page.click('.sheet button:has-text("Decide later")');
  await expect(page.locator('.sheet')).toBeHidden();

  await page.click('.rec-btn');

  // The app must ask again rather than overwrite, and must not have started.
  await expect(page.locator('.sheet')).toContainText('Unsaved recording found');
  await expect(page.locator('.sheet button:has-text("Decide later")')).toHaveCount(0);
  await expect(page.locator('.rec-btn')).toHaveAttribute('data-state', 'idle');

  expect((await readLiveSession(page)).meetingId).toBe(firstId);
});

test('a session with nothing captured is cleaned up without prompting', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const db = await import('/js/db.js');
    await db.beginLiveSession({
      meetingId: 'empty-one', source: 'mic', language: 'en-US', mimeType: 'audio/webm', keepAudio: true,
    });
  });

  await page.goto('/');
  await expect(page.locator('.rec-btn')).toBeVisible();
  await expect(page.locator('.sheet')).toBeHidden();

  expect(await readLiveSession(page)).toBeNull();
});
