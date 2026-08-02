const GREETINGS = ['hi', 'hello', 'hey', 'yo', 'howdy', 'sup', "what's up", 'whats up', 'good morning', 'good afternoon', 'good evening', 'greetings', 'hi there'];
const THANKS = ['thanks', 'thank you', 'ty', 'tyvm'];
const BYES = ['bye', 'goodbye', 'see ya', 'see you', 'cya', 'later'];
const CAPABILITIES = ['who are you', 'what are you', 'what can you do', 'what do you do', 'how do i use this', 'help me'];

function matchesOneOf(input: string, phrases: string[]): boolean {
  const t = input.trim().toLowerCase().replace(/[.!?]+$/g, '');
  for (const p of phrases) {
    if (t === p || t.startsWith(p + ' ')) return true;
  }
  return false;
}
const QUESTION_RE = /^(what|where|when|why|how|is|are|does|do|can|could|will|would|should|who|which|tell me|show me)\b/i;

const HELP_BLURB = `[AVAILABLE COMMANDS]

- Ask me anything: "What did I do wrong on that trade?" or "Analyze my session"
- Chart control: "switch to <SYMBOL>" / "go to <DATE>" / "play" / "pause" / "reset"
- Timeframe: "switch to 5m" / "15m" / "1h" / "4h" / "daily" (1m, 5m, 15m, 60m, 240m, daily)
- Type 'help' to see this message
- Type 'clear' to reset the terminal`;

export function commonSenseReply(input: string, isOnline: boolean): string | null {
  const lower = input.trim().toLowerCase();
  if (!lower) return null;

  if (matchesOneOf(input, GREETINGS)) return 'Hey. What can I run for you?';
  if (matchesOneOf(input, THANKS)) return 'You’re welcome.';
  if (matchesOneOf(input, BYES)) return 'See you later.';
  if (matchesOneOf(input, CAPABILITIES)) {
    return "I’m Orion, your private risk supervisor. Here’s what I can do:\n\n" + HELP_BLURB;
  }
  if (!isOnline && QUESTION_RE.test(lower)) {
    return "I can answer that once Ollama is running. Right now I can switch symbols and run chart commands like 'play', 'pause', and 'reset'.";
  }

  return null;
}

const KNOWN_COMMANDS = ['help', 'clear', 'switch to', 'go to', 'play', 'pause', 'reset', 'analyze', 'hello', 'hi', 'thanks'];

export function suggestCommand(input: string): string | null {
  const lower = input.trim().toLowerCase();
  if (!lower || lower.length > 20) return null;

  let best = '';
  let bestDist = Infinity;
  for (const cmd of KNOWN_COMMANDS) {
    const dist = levenshtein(lower, cmd);
    if (dist < bestDist) {
      bestDist = dist;
      best = cmd;
    }
  }

  const threshold = lower.length <= 3 ? 1 : 2;
  if (bestDist <= threshold) return best;
  return null;
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }

  return dp[m][n];
}
