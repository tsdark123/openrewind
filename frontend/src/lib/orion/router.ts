// =============================================================================
// router — Chat vs Agent intent classification for the two-tier Orion runtime.
//
// Cheap keyword + regex pass. Fast enough to run on every user message with
// zero latency, and precise enough to route the obvious "TeamViewer" asks to
// the heavier tool-calling model while keeping small talk on the 3B chat
// model.
//
// If the classifier is uncertain we default to 'chat' — false negatives are
// cheaper than false positives here (loading the 8B model is expensive; a
// missed agent intent just means the user re-phrases).
// =============================================================================

export type OrionIntent = 'chat' | 'agent';

export interface IntentClassification {
  intent: OrionIntent;
  confidence: number;      // 0..1, coarse — used only for UI hinting.
  reasons: string[];       // matched signals for debug/telemetry.
}

// Verbs that strongly imply the user wants Orion to DO something in the app
// (not just chat about it). We match whole-word to avoid catching "played
// well" or "runoff" style false positives.
const AGENT_VERBS = [
  'go to', 'switch to', 'open', 'load', 'navigate',
  'run', 'execute', 'backtest', 'simulate', 'replay',
  'trade', 'buy', 'sell', 'short', 'long', 'enter', 'exit', 'close',
  'play', 'pause', 'rewind', 'seek', 'skip', 'advance',
  'drive', 'take over', 'take control', 'automate', 'take me back',
  'set speed', 'speed up', 'slow down', 'set me up', 'set up', 'park the',
  'place order', 'place a', 'submit',
];

// Chat-only verbs — even if they appear near a symbol/date they're clearly
// analytical questions, not action requests.
const CHAT_VERBS = [
  'what', 'why', 'how', 'explain', 'describe', 'summarize',
  'analyze', 'review', 'compare', 'show me', 'tell me',
  'was', 'were', 'did', 'is', 'are',
];

// Recognized date shapes: 2026-07-13, 7/13, July 13, 13 Jul, etc.
const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/,
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]* \d{1,2}\b/i,
];

// Symbol-like uppercase tokens (2-5 letters). Matches "AAPL" but not "A"
// (too generic) or "TESLA-STOCK" (has punctuation). We only use this as a
// weak signal because a lot of chat naturally uses capitals.
const SYMBOL_PATTERN = /\b[A-Z]{2,5}\b/;

const AGENT_HINT_PHRASES = [
  'strategy', 'support and resistance', 'ema cross', 'orb ',
  'opening range', 'mean reversion', 'breakout',
  'market open', 'market close',
  'let orion', 'have orion', 'orion, ',
  'set me up', 'set up',
  'take me back',
  'previous symbol',
  'park the',
  'quarter past',
  'half an hour',
  'fifteen-minute',
  'fifteen minute',
  'bar',
  'give me the',
];

export function classifyOrionIntent(rawMessage: string): IntentClassification {
  const reasons: string[] = [];
  const message = rawMessage.trim().toLowerCase();
  if (message.length === 0) {
    return { intent: 'chat', confidence: 0, reasons: ['empty'] };
  }

  let score = 0;

  for (const verb of AGENT_VERBS) {
    if (message.includes(verb)) {
      score += 2;
      reasons.push(`agent verb: "${verb}"`);
      break; // one hit is plenty; avoid double-counting compound phrases
    }
  }

  for (const phrase of AGENT_HINT_PHRASES) {
    if (message.includes(phrase)) {
      score += 1;
      reasons.push(`agent phrase: "${phrase}"`);
    }
  }

  // Symbol + date together is a very strong "navigate somewhere" signal.
  const hasDate = DATE_PATTERNS.some((re) => re.test(message));
  const hasSymbol = SYMBOL_PATTERN.test(rawMessage); // preserve case for this
  if (hasSymbol && hasDate) {
    score += 2;
    reasons.push('symbol + date co-occurrence');
  } else if (hasSymbol) {
    score += 0.5;
    reasons.push('symbol token');
  } else if (hasDate) {
    score += 0.5;
    reasons.push('date token');
  }

  // Analytical opener + no strong agent verb pulls back toward chat.
  const startsAnalytical = CHAT_VERBS.some((v) => message.startsWith(v + ' '));
  if (startsAnalytical && score < 3) {
    score -= 1.5;
    reasons.push('analytical opener');
  }

  // Explicit request patterns that override everything else.
  if (/\b(can you|please|would you) (go|switch|load|run|execute|trade|buy|sell|drive|take)/.test(message)) {
    score += 3;
    reasons.push('explicit action request');
  }

  const intent: OrionIntent = score >= 2 ? 'agent' : 'chat';
  const confidence = Math.max(0, Math.min(1, score / 5));
  return { intent, confidence, reasons };
}
