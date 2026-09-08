/* End-to-end flows against the built app: capture, analysis, review, export. */

import { expect, test } from '@playwright/test';

import { ANALYSIS, SEGMENTS, mockAnthropic, seedMeeting, setSettings, sseBody } from './helpers.js';

test.describe('capture', () => {
  test('records and saves a meeting from the microphone', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#topbar-title')).toHaveText('Summary');

    // Nothing destructive is reachable before a recording starts.
    await expect(page.locator('.rec-controls .icon-btn:visible')).toHaveCount(0);
    await expect(page.locator('#back-btn')).toBeHidden();

    await page.click('.rec-btn');
    await expect(page.locator('.rec-btn')).toHaveAttribute('data-state', 'recording');
    await expect(page.locator('.pill-live')).toHaveText('Recording');
    await expect.poll(() => page.textContent('.timer')).not.toBe('00:00');

    await page.click('.rec-btn');
    await expect(page).toHaveURL(/#\/meeting\//);

    const saved = await page.evaluate(async () => {
      const db = await import('/js/db.js');
      const [meeting] = await db.listMeetings();
      const blob = await db.getAudio(meeting.id);
      return { hasAudio: meeting.hasAudio, size: blob?.size ?? 0, duration: meeting.durationMs };
    });
    expect(saved.hasAudio).toBe(true);
    expect(saved.size).toBeGreaterThan(0);
    expect(saved.duration).toBeGreaterThan(0);
  });

  test('the phone-call mode states the speakerphone limitation up front', async ({ page }) => {
    await page.goto('/');
    await page.click('.mode-chip:has-text("Phone call")');
    const note = page.locator('.banner');
    await expect(note).toContainText('does not let a web app tap the call audio stream');
    await expect(note).toContainText('speakerphone');
  });
});

test.describe('analysis', () => {
  test('sends a correctly shaped request and renders the streamed result', async ({ page, context }) => {
    const api = mockAnthropic(context);
    await page.goto('/');
    await setSettings(page, { apiKey: 'sk-ant-test-key', model: 'claude-opus-5', effort: 'high' });
    const id = await seedMeeting(page);

    await page.goto(`/#/meeting/${id}`);
    await page.click('button[aria-label="More"]');
    await page.click('button:has-text("Analyse now"), button:has-text("Re-run analysis")');
    await expect(page.locator('#view')).toContainText('staged rollout', { timeout: 15_000 });

    expect(api.requests).toHaveLength(1);
    const { headers, body } = api.requests[0];
    expect(headers['x-api-key']).toBe('sk-ant-test-key');
    expect(headers['anthropic-version']).toBe('2023-06-01');
    expect(headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(body.model).toBe('claude-opus-5');
    expect(body.stream).toBe(true);
    expect(body.output_config.effort).toBe('high');
    expect(body.output_config.format.type).toBe('json_schema');
    // Adaptive thinking is the default on Opus 5, and budget_tokens is removed.
    expect(body).not.toHaveProperty('thinking');
    expect(JSON.stringify(body)).not.toContain('budget_tokens');
    // The transcript reaches the prompt with its timestamps intact.
    expect(body.messages[0].content).toContain('billing rewrite');
    expect(body.messages[0].content).toContain('00:03');
    // A generated title must never be fed back in as if the user wrote it.
    expect(body.messages[0].content).not.toContain('User-supplied title');

    await expect(page.locator('#topbar-title')).toContainText('Billing rewrite');
  });

  test('falls back to an on-device summary with no key, and labels it', async ({ page }) => {
    await page.goto('/');
    const id = await seedMeeting(page);
    await page.goto(`/#/meeting/${id}`);

    await page.click('button:has-text("Summarise on-device")');
    await expect(page.locator('.banner')).toContainText('on-device');

    await page.click('.tabs button:has-text("Actions")');
    await expect(page.locator('.action-item')).not.toHaveCount(0);
  });

  test('retries a transient failure and reports a permanent one', async ({ page, context }) => {
    let attempts = 0;
    await context.route('https://api.anthropic.com/**', async (route) => {
      attempts += 1;
      if (attempts === 1) {
        await route.fulfill({
          status: 529,
          headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'retry-after': '1' },
          body: JSON.stringify({ error: { type: 'overloaded_error', message: 'Overloaded' } }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' },
        body: sseBody(JSON.stringify(ANALYSIS)),
      });
    });

    await page.goto('/');
    await setSettings(page, { apiKey: 'sk-ant-test-key' });
    const id = await seedMeeting(page);
    await page.goto(`/#/meeting/${id}`);
    await page.click('button[aria-label="More"]');
    await page.click('button:has-text("Analyse now"), button:has-text("Re-run analysis")');

    // It recovers on its own rather than surfacing the blip to the user.
    await expect(page.locator('#view')).toContainText('staged rollout', { timeout: 20_000 });
    expect(attempts).toBe(2);
  });

  test('a rejected key is reported in words the user can act on', async ({ page, context }) => {
    mockAnthropic(context, {
      status: 401,
      errorBody: { error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    });
    await page.goto('/');
    await setSettings(page, { apiKey: 'sk-ant-bad' });
    const id = await seedMeeting(page);
    await page.goto(`/#/meeting/${id}`);
    await page.click('button[aria-label="More"]');
    await page.click('button:has-text("Analyse now"), button:has-text("Re-run analysis")');

    await expect(page.locator('.toast')).toContainText('rejected', { timeout: 15_000 });
    await expect(page.locator('.toast')).toContainText('Settings');
  });

  test('a configured proxy takes over and no key is sent', async ({ page, context }) => {
    const proxied = { requests: [] };
    await context.route('https://proxy.example.test/**', async (route) => {
      proxied.requests.push({
        url: route.request().url(),
        headers: route.request().headers(),
      });
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' },
        body: sseBody(JSON.stringify(ANALYSIS)),
      });
    });
    // Any call to the API direct would be a bug — fail loudly if one happens.
    await context.route('https://api.anthropic.com/**', (route) => route.abort());

    await page.goto('/');
    await setSettings(page, { apiKey: '', apiBaseUrl: 'https://proxy.example.test' });
    const id = await seedMeeting(page);
    await page.goto(`/#/meeting/${id}`);
    await page.click('button[aria-label="More"]');
    await page.click('button:has-text("Analyse now"), button:has-text("Re-run analysis")');
    await expect(page.locator('#view')).toContainText('staged rollout', { timeout: 15_000 });

    expect(proxied.requests).toHaveLength(1);
    expect(proxied.requests[0].url).toBe('https://proxy.example.test/v1/messages');
    expect(proxied.requests[0].headers).not.toHaveProperty('x-api-key');
  });
});

test.describe('review', () => {
  test('renders the transcript with speakers and timestamps', async ({ page }) => {
    await page.goto('/');
    const id = await seedMeeting(page);
    await page.goto(`/#/meeting/${id}`);
    await page.click('.tabs button:has-text("Transcript")');

    await expect(page.locator('.seg')).toHaveCount(SEGMENTS.length);
    await expect(page.locator('.seg').first()).toContainText('Speaker 1');
    await expect(page.locator('.seg .at').first()).toHaveText('00:03');
  });

  test('ticking an action item survives a reload', async ({ page, context }) => {
    mockAnthropic(context);
    await page.goto('/');
    await setSettings(page, { apiKey: 'sk-ant-test-key' });
    const id = await seedMeeting(page);
    await page.goto(`/#/meeting/${id}`);
    await page.click('button[aria-label="More"]');
    await page.click('button:has-text("Analyse now"), button:has-text("Re-run analysis")');
    await expect(page.locator('#view')).toContainText('staged rollout', { timeout: 15_000 });

    await page.click('.tabs button:has-text("Actions")');
    await expect(page.locator('.action-item')).toHaveCount(2);
    await page.locator('.action-item input[type=checkbox]').first().check();

    await page.reload();
    await page.click('.tabs button:has-text("Actions")');
    await expect(page.locator('.action-item.done')).toHaveCount(1);
  });

  test('renaming a speaker updates the transcript and the export', async ({ page }) => {
    await page.goto('/');
    const id = await seedMeeting(page);
    await page.goto(`/#/meeting/${id}`);
    await page.click('.tabs button:has-text("Transcript")');
    await page.click('button:has-text("Speakers")');

    await page.locator('.sheet input').first().fill('Alex');
    await page.click('.sheet button:has-text("Save")');

    await expect(page.locator('.seg .who').first()).toHaveText('Alex');
    const md = await page.evaluate(async (mid) => {
      const db = await import('/js/db.js');
      const ex = await import('/js/export.js');
      return ex.toMarkdown(await db.getMeeting(mid));
    }, id);
    expect(md).toContain('Alex:');
  });

  test('correcting a transcript line persists', async ({ page }) => {
    await page.goto('/');
    const id = await seedMeeting(page);
    await page.goto(`/#/meeting/${id}`);
    await page.click('.tabs button:has-text("Transcript")');
    await page.click('button:has-text("Fix text")');
    await page.locator('.seg').first().click();

    await page.locator('.sheet textarea').fill('Corrected opening line.');
    await page.click('.sheet button:has-text("Save")');
    await expect(page.locator('.seg').first()).toContainText('Corrected opening line.');

    await page.reload();
    await page.click('.tabs button:has-text("Transcript")');
    await expect(page.locator('.seg').first()).toContainText('Corrected opening line.');
  });
});

test.describe('library', () => {
  test('searches across transcripts and reports a miss honestly', async ({ page }) => {
    await page.goto('/');
    await seedMeeting(page);
    await seedMeeting(page, {
      segments: [{ id: 'x', start: 0, end: 5000, speaker: 'S1', text: 'Unrelated standup chatter.' }],
      durationMs: 60_000,
    });

    await page.goto('/#/library');
    await expect(page.locator('.meeting-card')).toHaveCount(2);

    await page.fill('input[type="search"]', 'invoicing');
    await expect(page.locator('.meeting-card')).toHaveCount(1);

    await page.fill('input[type="search"]', 'zzz-nothing-matches');
    await expect(page.locator('.meeting-card')).toHaveCount(0);
    await expect(page.locator('.empty')).toContainText('Nothing matched');
  });

  test('deleting a recording removes it and its audio', async ({ page }) => {
    await page.goto('/');
    const id = await seedMeeting(page);
    await page.goto(`/#/meeting/${id}`);
    await page.click('button[aria-label="More"]');
    await page.click('.sheet button:has-text("Delete")');
    await page.click('.sheet button:has-text("Delete")');

    await expect(page).toHaveURL(/#\/library/);
    const remaining = await page.evaluate(async () => {
      const db = await import('/js/db.js');
      return (await db.listMeetings()).length;
    });
    expect(remaining).toBe(0);
  });
});

test.describe('settings', () => {
  test('reports what this browser can actually do', async ({ page }) => {
    await page.goto('/#/settings');
    await expect(page.locator('.card').first()).toBeVisible();
    await expect(page.getByText('Microphone recording')).toBeVisible();
    await expect(page.getByText('Live transcription')).toBeVisible();
  });

  test('hides the API key field once a proxy is configured', async ({ page }) => {
    await page.goto('/#/settings');
    await expect(page.locator('input[aria-label="Anthropic API key"]')).toBeVisible();

    await page.fill('input[aria-label="Proxy URL"]', 'https://proxy.example.test');
    await page.locator('input[aria-label="Proxy URL"]').blur();

    await expect(page.locator('input[aria-label="Anthropic API key"]')).toHaveCount(0);
    await expect(page.locator('.banner')).toContainText('proxy, which supplies the key');
  });
});
