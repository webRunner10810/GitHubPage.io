/* Shared fixtures for the end-to-end suite. */

/** A transcript with a decision, a commitment with a deadline, and a question. */
export const SEGMENTS = [
  { id: 's1', start: 3000, end: 12000, speaker: 'S1', text: 'The main question today is whether the billing rewrite ships before the end of the quarter, because support is drowning in invoice tickets.' },
  { id: 's2', start: 13000, end: 24000, speaker: 'S2', text: 'We agreed last week that we are going with a staged rollout, five percent of accounts first, then twenty five.' },
  { id: 's3', start: 25000, end: 37000, speaker: 'S1', text: "I'll write up the rollout plan by Friday and share it with the team so everyone knows the sequencing." },
  { id: 's4', start: 38000, end: 47000, speaker: 'S2', text: 'Can you also check whether the invoicing migration is blocking anything urgent on the data side?' },
];

export const ANALYSIS = {
  title: 'Billing rewrite rollout',
  summary: 'The team confirmed a staged rollout of the billing rewrite starting at five percent of accounts.',
  key_points: ['Billing rewrite targeted before end of quarter', 'Staged rollout agreed at five percent first'],
  decisions: ['Go with a staged rollout, five percent of accounts first'],
  action_items: [
    { task: 'Write up the rollout plan and share it with the team', owner: 'Speaker 1', due: 'Friday', priority: 'high' },
    { task: 'Check whether the invoicing migration blocks anything urgent', owner: 'Speaker 2', due: '', priority: 'medium' },
  ],
  open_questions: ['Is the invoicing migration blocking anything urgent?'],
  topics: ['Billing', 'Rollout', 'Q3'],
  sentiment: { overall: 'positive', note: 'Aligned and decisive.' },
  follow_up_email: 'Hi team — we agreed to ship the billing rewrite behind a staged rollout.',
};

/** Build a Server-Sent Events body that streams `text` back in two deltas. */
export function sseBody(text, { stopReason = 'end_turn' } = {}) {
  const frame = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
  const half = Math.ceil(text.length / 2);
  return [
    frame({ type: 'message_start', message: { usage: { input_tokens: 900 } } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } }),
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: text.slice(half) } }),
    frame({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 320 } }),
    frame({ type: 'message_stop' }),
  ].join('');
}

/**
 * Intercept the Anthropic API. Returns a handle whose `requests` array
 * collects every intercepted call so tests can assert the wire format.
 */
export function mockAnthropic(context, { body = null, status = 200, errorBody = null } = {}) {
  const handle = { requests: [] };
  const payload = body ?? sseBody(JSON.stringify(ANALYSIS));
  context.route('https://api.anthropic.com/**', async (route) => {
    const request = route.request();
    handle.requests.push({
      headers: request.headers(),
      body: JSON.parse(request.postData() || '{}'),
    });
    if (status !== 200) {
      await route.fulfill({
        status,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
        body: JSON.stringify(errorBody ?? { error: { type: 'api_error', message: 'mock failure' } }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' },
      body: payload,
    });
  });
  return handle;
}

/** Write a meeting straight into IndexedDB and return its id. */
export function seedMeeting(page, overrides = {}) {
  return page.evaluate(async (data) => {
    const db = await import('/js/db.js');
    const meeting = db.newMeeting(data);
    await db.saveMeeting(meeting);
    return meeting.id;
  }, { segments: SEGMENTS, durationMs: 754_000, source: 'call', ...overrides });
}

export function setSettings(page, patch) {
  return page.evaluate(async (values) => {
    const settings = await import('/js/settings.js');
    settings.setSettings(values);
  }, patch);
}
