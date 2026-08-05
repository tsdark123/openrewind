// Fixed 12-prompt qwen3:8b latency benchmark set.
// Kept stable so historical latency comparison remains meaningful.

export const QWEN3_BENCHMARK_PROMPTS = [
  'Switch to NVDA.',
  'What kind of candle am I on right now?',
  'How did AAPL do today?',
  'Range first hour.',
  'Was morning volume higher than near close?',
  'Give me the move, volume and candle anatomy from 10 to noon.',
  'Same thing but first hour.',
  'What about volume?',
  'Compare that with the last hour.',
  'Do that analysis on NVDA.',
  'Pause.',
  'Move the replay half an hour earlier.',
] as const;
