// Legacy V1 / historical-v1 contract wrapper for the bake-off prompt suite.
// Re-exports the original suite so versioned consumers can import it explicitly.
export {
  PRIMARY_PROMPTS,
  DETERMINISTIC_PROMPTS,
  PRECONDITION_PROMPTS,
  SAFETY_PROMPTS,
  ALL_PROMPTS,
  getPromptById,
  tickers,
} from './bakeoff-suite';
