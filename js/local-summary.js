/* On-device fallback analysis.
 *
 * Runs with no API key and no network. It is extractive and rule-based, so it
 * cannot paraphrase the way Claude does — it picks the sentences that carry
 * the most weight and pattern-matches commitments, decisions and questions.
 * The UI always labels output from here as "On-device" so nobody mistakes it
 * for the AI pass.
 */

import { normalizeAnalysis } from './ai.js';
import { sentencesOf } from './util.js';

const STOPWORDS = new Set(`a about above after again against all am an and any are aren't as at be because been before being below
between both but by can cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had
hadn't has hasn't have haven't having he her here hers herself him himself his how i i'd i'll i'm i've if in into is isn't it
it's its itself just let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out
over own same shan't she should shouldn't so some such than that that's the their theirs them themselves then there there's
these they they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've
were weren't what what's when where which while who whom why with won't would wouldn't you you'd you'll you're you've your
yours yourself yourselves yeah yes okay ok right like know think going really just kind sort actually basically mean gonna
whether maybe probably something anything everything nothing someone anyone everyone thing things stuff lot bit way ways said
say says saying get gets got getting make makes made making take takes took taking come comes came want wants need needs
one two three four five six seven eight nine ten hundred percent main today tomorrow question questions week weeks month
good great sure sounds fine well also still even back around already always never quite pretty much many few little big`
  .split(/\s+/).filter(Boolean));

const COMMITMENT = /\b(i'?ll|we'?ll|i will|we will|i'?m going to|we'?re going to|let me|i can take|i'll take|action item|to-?do|todo|follow up|follow-up|next step|assign(ed)? to|owns? this|by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next week|end of (day|week|month)|eod|eow)|due)\b/i;
const DECISION = /\b(we (decided|agreed|settled|concluded)|decision is|the plan is|we'?re going with|let'?s go with|approved|signed off|final(ised|ized)|agreed to)\b/i;
const DUE = /\b(by (monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week|next month|end of (the )?(day|week|month|quarter)|eod|eow|eom)|before (monday|tuesday|wednesday|thursday|friday|the \w+)|on the \d+(st|nd|rd|th)|due \w+)\b/i;
const URGENT = /\b(urgent|asap|critical|blocker|blocking|immediately|today|right away|high priority)\b/i;

function tokens(text) {
  return String(text).toLowerCase().match(/[a-z][a-z'-]{1,}/g) || [];
}

function termFrequencies(text) {
  const freq = new Map();
  for (const word of tokens(text)) {
    if (STOPWORDS.has(word) || word.length < 3) continue;
    freq.set(word, (freq.get(word) || 0) + 1);
  }
  return freq;
}

/** Guess an owner from a first-person or named commitment. */
function guessOwner(sentence, speakerName) {
  const named = sentence.match(/\b([A-Z][a-z]{2,})\s+(will|can|is going to|should)\b/);
  if (named) return named[1];
  const addressed = sentence.match(/\b(can|could|would)\s+you\b/i);
  if (addressed) return 'Unassigned';
  if (/\b(i'?ll|i will|i'?m going to|let me|i can)\b/i.test(sentence)) return speakerName || 'Unassigned';
  if (/\b(we'?ll|we will|we'?re going to)\b/i.test(sentence)) return 'Team';
  return 'Unassigned';
}

function titleCaseTopic(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * @param {object} meeting  A record from js/db.js
 * @returns {object} analysis in the same shape js/ai.js produces
 */
export function analyzeLocally(meeting) {
  const names = meeting.speakers || {};
  const segments = meeting.segments || [];
  const fullText = segments.map((s) => s.text).join(' ').trim();

  if (!fullText) {
    return normalizeAnalysis({
      title: meeting.title || 'Untitled recording',
      summary: 'No speech was transcribed for this recording.',
      sentiment: { overall: 'neutral', note: '' },
    }, { provider: 'local' });
  }

  const freq = termFrequencies(fullText);
  const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]);
  const maxFreq = ranked.length ? ranked[0][1] : 1;

  // Score every sentence by the normalised weight of the content words in it,
  // with a small bonus for length so one-word interjections do not win.
  const scored = [];
  for (const seg of segments) {
    const speakerName = seg.speaker ? (names[seg.speaker] || seg.speaker) : '';
    for (const sentence of sentencesOf(seg.text)) {
      const words = tokens(sentence).filter((w) => !STOPWORDS.has(w) && w.length >= 3);
      if (words.length < 4) continue;
      const weight = words.reduce((sum, w) => sum + (freq.get(w) || 0) / maxFreq, 0);
      scored.push({
        sentence,
        speakerName,
        start: seg.start,
        score: weight / Math.sqrt(words.length) + Math.min(words.length, 18) / 40,
      });
    }
  }

  const byScore = [...scored].sort((a, b) => b.score - a.score);
  const keep = Math.max(3, Math.min(7, Math.round(scored.length * 0.12)));
  const keyPoints = byScore.slice(0, keep)
    .sort((a, b) => a.start - b.start)
    .map((s) => s.sentence.replace(/\s+/g, ' ').trim());

  const decisions = [];
  const actionItems = [];
  const openQuestions = [];
  const seen = new Set();

  for (const { sentence, speakerName } of scored) {
    const key = sentence.toLowerCase().slice(0, 60);
    if (seen.has(key)) continue;
    if (DECISION.test(sentence) && decisions.length < 8) {
      decisions.push(sentence);
      seen.add(key);
    } else if (COMMITMENT.test(sentence) && actionItems.length < 12) {
      const dueMatch = sentence.match(DUE);
      actionItems.push({
        task: sentence,
        owner: guessOwner(sentence, speakerName),
        due: dueMatch ? dueMatch[0] : '',
        priority: URGENT.test(sentence) ? 'high' : (dueMatch ? 'medium' : 'low'),
      });
      seen.add(key);
    } else if (/\?\s*$/.test(sentence) && sentence.split(' ').length > 4 && openQuestions.length < 8) {
      openQuestions.push(sentence);
      seen.add(key);
    }
  }

  // A word said once is noise, not a topic. Only fall back to single mentions
  // when nothing repeats at all, and skip the generated title in that case so
  // the recording keeps its date-based name instead of a nonsense one.
  const repeated = ranked.filter(([, n]) => n >= 2);
  const topics = (repeated.length ? repeated : ranked).slice(0, 6).map(([word]) => titleCaseTopic(word));
  const generatedTitle = repeated.length >= 2 ? repeated.slice(0, 3).map(([w]) => titleCaseTopic(w)).join(', ') : '';
  const minutes = Math.max(1, Math.round((meeting.durationMs || 0) / 60000));
  const speakerCount = new Set(segments.map((s) => s.speaker).filter(Boolean)).size || 1;

  const summary = [
    `${minutes} minute recording with ${speakerCount === 1 ? 'one detected speaker' : `${speakerCount} detected speakers`}, covering ${topics.slice(0, 3).map((t) => t.toLowerCase()).join(', ') || 'general discussion'}.`,
    keyPoints[0] ? `It opens with: “${keyPoints[0]}”` : '',
    decisions.length ? `${decisions.length} decision${decisions.length === 1 ? '' : 's'} and ${actionItems.length} possible action item${actionItems.length === 1 ? '' : 's'} were detected.` : (actionItems.length ? `${actionItems.length} possible action item${actionItems.length === 1 ? '' : 's'} were detected.` : ''),
    'This is an on-device extractive summary — add an API key in Settings for a written analysis.',
  ].filter(Boolean).join(' ');

  return normalizeAnalysis({
    title: meeting.title || generatedTitle,
    summary,
    key_points: keyPoints,
    decisions,
    action_items: actionItems,
    open_questions: openQuestions,
    topics,
    sentiment: { overall: 'neutral', note: 'Tone is not assessed on-device.' },
    follow_up_email: '',
  }, { provider: 'local', model: 'on-device' });
}
