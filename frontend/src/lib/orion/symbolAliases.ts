// =============================================================================
// Symbol aliases — single canonical source of truth for Orion.
//
// Maps lowercase company names / nicknames to uppercase tickers. Used by both
// the deterministic offline planner (`planner.ts`) and the agent resolver.
//
// Keep this file dependency-free and deterministic; it is referenced in pure
// unit tests and in the UI build.
// =============================================================================

/**
 * Legacy planner alias set. Preserved as a named export for anything that
 * intentionally needs the smaller original set (e.g. a strict regression
 * comparison).
 */
export const BASE_ALIASES: Record<string, string> = {
  apple: 'AAPL',
  tesla: 'TSLA',
  netflix: 'NFLX',
  amazon: 'AMZN',
  microsoft: 'MSFT',
  google: 'GOOGL',
  alphabet: 'GOOGL',
  meta: 'META',
  facebook: 'META',
  nvidia: 'NVDA',
  amd: 'AMD',
  intel: 'INTC',
  broadcom: 'AVGO',
  oracle: 'ORCL',
  salesforce: 'CRM',
  paypal: 'PYPL',
};

/**
 * Additional company-name aliases used by the agent layer but safe to expose
 * to the deterministic planner as a superset (no existing alias is overridden).
 */
export const EXTENDED_ALIASES: Record<string, string> = {
  adobe: 'ADBE',
  costco: 'COST',
  home: 'HD',            // "home depot"
  homedepot: 'HD',
  cisco: 'CSCO',
  qualcomm: 'QCOM',
  starbucks: 'SBUX',
  disney: 'DIS',
  mcdonalds: 'MCD',
  walmart: 'WMT',
  visa: 'V',
  mastercard: 'MA',
  johnson: 'JNJ',
  merck: 'MRK',
  pfizer: 'PFE',
  chevron: 'CVX',
  exxon: 'XOM',
  boeing: 'BA',
  ford: 'F',
  gm: 'GM',
  uber: 'UBER',
  ibm: 'IBM',
  shopify: 'SHOP',
  eli: 'LLY',            // "eli lilly"
  lilly: 'LLY',
  berkshire: 'BRK-B',
  jpm: 'JPM',
  bofa: 'BAC',
  bankofamerica: 'BAC',
  costcowholesale: 'COST',
  procter: 'PG',
  gamble: 'PG',
  txn: 'TXN',
  texasinstruments: 'TXN',
  ge: 'GE',
  verizon: 'VZ',
  att: 'T',
  coke: 'KO',
  cocacola: 'KO',
  pepsi: 'PEP',
  nike: 'NKE',
};

/**
 * Canonical combined alias table. This is the default both the offline planner
 * and the agent resolver use.
 */
export const SYMBOL_ALIASES: Record<string, string> = {
  ...BASE_ALIASES,
  ...EXTENDED_ALIASES,
};
