/**
 * Independent reference types for the Orion Scenario Lab.
 *
 * These types intentionally mirror the shapes produced by production analysis
 * receipts without importing production analysis.ts. They are the source of
 * numerical truth for lab oracles.
 */

export interface ReferenceCandle {
  timestamp: number;
  /** Market time in HH:MM format, e.g. "09:30". */
  marketTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type ReferenceWindowKind = 'whole_session' | 'up_to_cursor' | 'time_range';

export interface ReferenceWindow {
  kind: ReferenceWindowKind;
  /** Inclusive start time HH:MM for time_range. */
  fromTime?: string;
  /** Exclusive end time HH:MM for time_range. */
  toTime?: string;
  /** Timestamp cursor for up_to_cursor. */
  cursor?: number;
}

export type BodyDirection = 'up' | 'down' | 'flat';

export interface ReferenceOhlc {
  open: number;
  high: number;
  low: number;
  close: number;
  candleCount: number;
  firstMarketTime: string;
  lastMarketTime: string;
  highAt: string;
  lowAt: string;
}

export interface ReferenceChange extends ReferenceOhlc {
  absoluteChange: number;
  percentChange: number;
  direction: BodyDirection;
}

export interface ReferenceVolume {
  candleCount: number;
  firstMarketTime: string;
  lastMarketTime: string;
  totalVolume: number;
  averageVolume: number;
  largestVolume: number;
  largestVolumeAt: string;
}

export interface ReferenceCandleInfo {
  marketTime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ReferenceCandleBody {
  direction: BodyDirection;
  size: number;
  topPrice: number;
  bottomPrice: number;
}

export interface ReferenceCandleShape {
  candle: ReferenceCandleInfo;
  body: ReferenceCandleBody;
  upperWick: number;
  lowerWick: number;
  range: number;
}

export interface ReferenceCompare {
  priceDeltaAbs: number;
  priceDeltaPercent: number;
  volumeDeltaAbs: number;
  volumeDeltaPercent: number;
}

export interface ReferenceSummary
  extends ReferenceOhlc,
    ReferenceChange,
    ReferenceVolume {
  averageBody: number;
  averageUpperWick: number;
  averageLowerWick: number;
}
