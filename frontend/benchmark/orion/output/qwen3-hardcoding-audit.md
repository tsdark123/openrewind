# qwen3:8b benchmark hardcoding audit

## Scope

This audit checks the 12 fixed qwen3:8b benchmark prompts against the
EXAMPLE_LIBRARY few-shot examples used by the LLM intent extractor.
Only benchmark prompts that route through the LLM are checked; deterministic
parser prompts are listed for completeness but excluded from the contamination
count.

## Benchmark prompts

| Prompt | Route |
|--------|-------|
| "Switch to NVDA." | deterministic |
| "What kind of candle am I on right now?" | LLM |
| "How did AAPL do today?" | LLM |
| "Range first hour." | LLM |
| "Was morning volume higher than near close?" | LLM |
| "Give me the move, volume and candle anatomy from 10 to noon." | LLM |
| "Same thing but first hour." | LLM |
| "What about volume?" | LLM |
| "Compare that with the last hour." | LLM |
| "Do that analysis on NVDA." | LLM |
| "Pause." | deterministic |
| "Move the replay half an hour earlier." | deterministic |

## Detection rules

1. Normalized exact match (punctuation and casing removed, whitespace collapsed).
2. One string substantially contains the other (contiguous token run; shorter is
   at least half the length of the longer).
3. Near-verbatim wording: token bigram Sørensen-Dice coefficient ≥ 0.8 after
   normalization.

## Overlap findings

No blocking overlap detected between LLM-routed benchmark prompts and EXAMPLE_LIBRARY.
## Conclusion

PASS — no LLM-routed benchmark prompt overlaps with an EXAMPLE_LIBRARY entry.