import { describe, it, expect } from 'vitest';
import {
  extractConsumerNumbers,
  allowedNumbersFromObject,
  checkConsumerNumericEquivalence,
} from '../runner/numeric-equivalence.ts';

describe('consumer numeric parsing', () => {
  it('parses plain integers with commas', () => {
    const nums = extractConsumerNumbers('Volume was 29,989,052 today.');
    expect(nums).toHaveLength(1);
    expect(nums[0].value).toBe(29_989_052);
  });

  it('parses compact suffixes', () => {
    const nums = extractConsumerNumbers('About 29.99M shares traded.');
    expect(nums).toHaveLength(1);
    expect(nums[0].value).toBeCloseTo(29_990_000, 2);
  });

  it('parses million word', () => {
    const nums = extractConsumerNumbers('approximately 30 million');
    expect(nums).toHaveLength(1);
    expect(nums[0].value).toBeCloseTo(30_000_000, 2);
    expect(nums[0].isApprox).toBe(true);
  });

  it('parses percentages', () => {
    const nums = extractConsumerNumbers('Up 1.71%, or approximately 1.7 percent.');
    expect(nums).toHaveLength(2);
    expect(nums[0].isPercent).toBe(true);
    expect(nums[1].isApprox && nums[1].isPercent).toBe(true);
  });
});

describe('consumer numeric equivalence', () => {
  const allowed = allowedNumbersFromObject(
    {
      open: 100,
      close: 103.89,
      percentChange: 3.89,
      totalVolume: 29_989_052,
    },
    'summary',
  );

  it('accepts exact price', () => {
    const check = checkConsumerNumericEquivalence('The close was 103.89.', allowed, {
      priceAbsolute: 0.005,
      priceRelative: 0.001,
      volumeAbsolute: 1,
      volumeRelative: 0.001,
      percentAbsolute: 0.05,
      percentRelative: 0.001,
      approximateRelative: 0.02,
    } as any);
    expect(check.ok).toBe(true);
  });

  it('accepts compact volume format', () => {
    const check = checkConsumerNumericEquivalence('Volume was 29.99M.', allowed, {
      priceAbsolute: 0.005,
      priceRelative: 0.001,
      volumeAbsolute: 1,
      volumeRelative: 0.001,
      percentAbsolute: 0.05,
      percentRelative: 0.001,
      approximateRelative: 0.02,
    } as any);
    expect(check.ok).toBe(true);
  });

  it('rejects hallucinated number', () => {
    const check = checkConsumerNumericEquivalence('Profit was 42 million.', allowed, {
      priceAbsolute: 0.005,
      priceRelative: 0.001,
      volumeAbsolute: 1,
      volumeRelative: 0.001,
      percentAbsolute: 0.05,
      percentRelative: 0.001,
      approximateRelative: 0.02,
    } as any);
    expect(check.ok).toBe(false);
    expect(check.unsupported).toContain('42 million');
  });
});
