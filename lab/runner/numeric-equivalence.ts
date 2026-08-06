import type { NumericEquivalenceConfig } from './scenario-types.ts';

export interface AllowedNumber {
  value: number;
  category: 'price' | 'volume' | 'percent' | 'count';
  source: string;
}

export interface ConsumerNumber {
  raw: string;
  value: number;
  isPercent: boolean;
  isApprox: boolean;
}

const APPROXIMATE_WORDS = [
  'about',
  'around',
  'approximately',
  'roughly',
  'nearly',
  'almost',
  'close to',
];

const MULTIPLIER_WORDS: Record<string, number> = {
  thousand: 1e3,
  million: 1e6,
  billion: 1e9,
};

const SUFFIX_MULTIPLIERS: Record<string, number> = {
  K: 1e3,
  M: 1e6,
  B: 1e9,
  k: 1e3,
  m: 1e6,
  b: 1e9,
};

/**
 * Extract human-formatted numbers from a consumer response.
 *
 * Handles:
 *   29,989,052
 *   29.99M
 *   about 30 million
 *   1.71%
 *   approximately 1.7 percent
 */
export function extractConsumerNumbers(text: string): ConsumerNumber[] {
  const results: ConsumerNumber[] = [];
  const approxPrefix = `(?:\\b(?:${APPROXIMATE_WORDS.join('|').replace(/\s+/g, '\\s+')})\\s+)?`;
  const numberGroup = `([+-]?\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)`;
  // A compact suffix (e.g. 29.99M) is only matched when not part of a longer word
  // like "million". Percent and word multipliers are matched as whole words.
  const suffixOrWord = `(?:\\s*((?:K|M|B|k|m|b)(?!\\w)|%(?!\\w)|(?:thousand|million|billion|percent)(?!\\w)))?`;
  const re = new RegExp(`${approxPrefix}${numberGroup}${suffixOrWord}`, 'gi');

  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const rawNumber = match[1];
    const token = match[2];
    const fullRaw = match[0].trim();
    const isApprox = APPROXIMATE_WORDS.some((w) => {
      const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(fullRaw);
    });

    const base = Number.parseFloat(rawNumber.replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;

    let value = base;
    let isPercent = false;

    if (token) {
      const lowerToken = token.toLowerCase();
      if (lowerToken === '%' || lowerToken === 'percent') {
        isPercent = true;
      } else if (lowerToken in SUFFIX_MULTIPLIERS) {
        value *= SUFFIX_MULTIPLIERS[lowerToken];
      } else if (lowerToken in MULTIPLIER_WORDS) {
        value *= MULTIPLIER_WORDS[lowerToken];
      }
    }

    results.push({ raw: fullRaw, value, isPercent, isApprox });
  }

  return results;
}

function inferCategory(key: string): AllowedNumber['category'] {
  const k = key.toLowerCase();
  if (k.includes('percent') || k.includes('delta') && k.includes('percent')) return 'percent';
  if (k.includes('volume')) return 'volume';
  if (k.includes('count')) return 'count';
  return 'price';
}

export function allowedNumbersFromObject(
  data: unknown,
  source = 'receipt',
  found: AllowedNumber[] = [],
  key = '',
): AllowedNumber[] {
  if (data === null || data === undefined) return found;

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      allowedNumbersFromObject(data[i], source, found, `${key}[${i}]`);
    }
    return found;
  }

  if (typeof data === 'object') {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      allowedNumbersFromObject(v, source, found, k);
    }
    return found;
  }

  if (typeof data === 'number' && Number.isFinite(data)) {
    found.push({ value: data, category: inferCategory(key), source });
  }

  return found;
}

function toleranceFor(
  allowed: AllowedNumber,
  consumer: ConsumerNumber,
  config: NumericEquivalenceConfig,
): number {
  if (consumer.isApprox) {
    return Math.max(config.approximateRelative, 0.02) * Math.max(1, Math.abs(allowed.value));
  }

  let abs = 1e-9;
  let rel = 1e-9;

  if (allowed.category === 'price' || consumer.isPercent === false && allowed.category === 'percent') {
    abs = config.priceAbsolute;
    rel = config.priceRelative;
  } else if (allowed.category === 'volume') {
    abs = config.volumeAbsolute;
    rel = config.volumeRelative;
  } else if (allowed.category === 'percent' || consumer.isPercent) {
    abs = config.percentAbsolute;
    rel = config.percentRelative;
  } else if (allowed.category === 'count') {
    abs = config.volumeAbsolute;
    rel = config.volumeRelative;
  }

  return Math.max(abs, rel * Math.max(1, Math.abs(allowed.value)));
}

export function checkConsumerNumericEquivalence(
  text: string,
  allowedNumbers: AllowedNumber[],
  config: NumericEquivalenceConfig,
): { ok: boolean; unsupported: string[] } {
  const consumerNumbers = extractConsumerNumbers(text);
  const unsupported: string[] = [];

  for (const consumer of consumerNumbers) {
    const candidates = allowedNumbers.filter((a) => {
      // Percent tokens must match percent or non-percent? To be safe, match
      // only percent values for percent tokens, and non-percent values for
      // non-percent tokens.
      if (consumer.isPercent) return a.category === 'percent';
      return a.category !== 'percent';
    });

    const matched = candidates.some((allowed) => {
      const tol = toleranceFor(allowed, consumer, config);
      return Math.abs(consumer.value - allowed.value) <= tol;
    });

    if (!matched) {
      unsupported.push(consumer.raw);
    }
  }

  return { ok: unsupported.length === 0, unsupported };
}
