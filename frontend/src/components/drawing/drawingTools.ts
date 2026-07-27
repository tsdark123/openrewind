// =============================================================================
// drawingTools.ts — central tool registry for the drawing layer.
//
// This module is the single source of truth for "which drawings does the
// frontend know how to create?" It maps a stable, library-aligned tool id
// (e.g. "trend-line", "fib-retracement") to:
//   - how many anchor points the user must click to place it
//   - a factory that returns a fresh IDrawing instance
//
// The toolbar UI (TradingToolbar.tsx) and the placement state machine
// (drawingFsm.ts) both consume this map. Adding a new drawing type later
// only requires registering it here — no other file needs to change.
//
// We deliberately use the same string ids the underlying
// lightweight-charts-drawing package uses for its own `readonly type` field.
// That way our registry id IS the library id, and we never need a translation
// table.
// =============================================================================

import {
  type Anchor,
  type IDrawing,
  TrendLine,
  Ray,
  ExtendedLine,
  HorizontalLine,
  HorizontalRay,
  VerticalLine,
  CrossLine,
  InfoLine,
  TrendAngle,
  ParallelChannel,
  DisjointChannel,
  RegressionTrend,
  FlatTopBottom,
  FibRetracement,
  FibExtension,
  FibChannel,
  FibTimeZone,
  FibTimeExtension,
  FibSpeedFan,
  FibArcs,
  FibCircles,
  FibSpiral,
  FibWedge,
  Pitchfan,
  GannBox,
  GannFan,
  GannSquare,
  GannSquareFixed,
  Rectangle,
  RotatedRectangle,
  Triangle,
  Ellipse,
  Polyline,
  Curve,
  Brush,
  Highlighter,
  TextAnnotation,
  Note,
  Callout,
  PriceLabel,
  PriceNote,
  ArrowMarkUp,
  FlagMark,
  LongPosition,
  ShortPosition,
  Forecast,
  Projection,
  PriceRange,
  DateRange,
  DatePriceRange,
  BarsPattern,
} from 'lightweight-charts-drawing';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

/**
 * String id for a registered tool. Matches `IDrawing.type` from the underlying
 * library 1:1 so we never need a translation table when serializing.
 *
 * `'NONE'` is the sentinel meaning "no drawing tool is currently active";
 * the chart is in pan/zoom mode.
 */
export type ToolId =
  | 'trend-line'
  | 'ray'
  | 'extended-line'
  | 'horizontal-line'
  | 'horizontal-ray'
  | 'vertical-line'
  | 'cross-line'
  | 'info-line'
  | 'trend-angle'
  | 'parallel-channel'
  | 'disjoint-channel'
  | 'regression-trend'
  | 'flat-top-bottom'
  | 'fib-retracement'
  | 'fib-extension'
  | 'fib-channel'
  | 'fib-time-zone'
  | 'fib-time-extension'
  | 'fib-speed-fan'
  | 'fib-arcs'
  | 'fib-circles'
  | 'fib-spiral'
  | 'fib-wedge'
  | 'pitchfan'
  | 'gann-box'
  | 'gann-fan'
  | 'gann-square'
  | 'gann-square-fixed'
  | 'rectangle'
  | 'rotated-rectangle'
  | 'triangle'
  | 'ellipse'
  | 'polyline'
  | 'curve'
  | 'brush'
  | 'highlighter'
  | 'text-annotation'
  | 'note'
  | 'callout'
  | 'price-label'
  | 'price-note'
  | 'arrow-mark-up'
  | 'flag-mark'
  | 'long-position'
  | 'short-position'
  | 'forecast'
  | 'projection'
  | 'price-range'
  | 'date-range'
  | 'date-price-range'
  | 'bars-pattern';

export type ActiveTool = ToolId | 'NONE';

/**
 * Placement strategy for the FSM:
 *   - 'click': user clicks N discrete points to place the drawing.
 *              Each click commits one anchor. The mousemove updates the
 *              preview between clicks. Finalize on the Nth click.
 *   - 'drag':  user holds mouse and drags. Each mousemove appends an anchor.
 *              Finalize on mouseup. Used by free-form tools (brush, highlighter).
 */
export type PlacementMode = 'click' | 'drag';

export interface ToolDef {
  id: ToolId;
  requiredAnchors: 1 | 2 | 3 | 4;
  placement: PlacementMode;
  factory: (id: string, anchors: Anchor[]) => IDrawing;
}

// -----------------------------------------------------------------------------
// Registry
//
// One entry per drawing the UI exposes. `requiredAnchors` mirrors the
// REQUIRED_ANCHORS constant on each underlying class — keep these in sync
// if you change drawings. The FSM uses this to know when to finalize.
// -----------------------------------------------------------------------------

const reg = <Cls extends new (id: string, anchors?: Anchor[]) => IDrawing>(
  id: ToolId,
  Cls: Cls,
  requiredAnchors: ToolDef['requiredAnchors'],
  placement: PlacementMode = 'click',
): [ToolId, ToolDef] => [
  id,
  {
    id,
    requiredAnchors,
    placement,
    factory: (drawingId, anchors) => new Cls(drawingId, anchors),
  },
];

export const TOOL_REGISTRY: Record<ToolId, ToolDef> = Object.fromEntries([
  // -- Lines -----------------------------------------------------------------
  reg('trend-line', TrendLine, 2),
  reg('ray', Ray, 2),
  reg('extended-line', ExtendedLine, 2),
  reg('horizontal-line', HorizontalLine, 1),
  reg('horizontal-ray', HorizontalRay, 1),
  reg('vertical-line', VerticalLine, 1),
  reg('cross-line', CrossLine, 1),
  reg('info-line', InfoLine, 2),
  reg('trend-angle', TrendAngle, 2),

  // -- Channels --------------------------------------------------------------
  reg('parallel-channel', ParallelChannel, 3),
  reg('disjoint-channel', DisjointChannel, 4),
  reg('regression-trend', RegressionTrend, 2),
  reg('flat-top-bottom', FlatTopBottom, 3),

  // -- Fibonacci -------------------------------------------------------------
  reg('fib-retracement', FibRetracement, 2),
  reg('fib-extension', FibExtension, 3),
  reg('fib-channel', FibChannel, 3),
  reg('fib-time-zone', FibTimeZone, 2),
  reg('fib-time-extension', FibTimeExtension, 3),
  reg('fib-speed-fan', FibSpeedFan, 2),
  reg('fib-arcs', FibArcs, 2),
  reg('fib-circles', FibCircles, 2),
  reg('fib-spiral', FibSpiral, 2),
  reg('fib-wedge', FibWedge, 3),
  reg('pitchfan', Pitchfan, 3),

  // -- Gann ------------------------------------------------------------------
  reg('gann-box', GannBox, 2),
  reg('gann-fan', GannFan, 2),
  reg('gann-square', GannSquare, 2),
  reg('gann-square-fixed', GannSquareFixed, 1),

  // -- Shapes ----------------------------------------------------------------
  reg('rectangle', Rectangle, 2),
  reg('rotated-rectangle', RotatedRectangle, 3),
  reg('triangle', Triangle, 3),
  reg('ellipse', Ellipse, 2),
  reg('polyline', Polyline, 2),
  reg('curve', Curve, 2),
  reg('brush', Brush, 2, 'drag'),
  reg('highlighter', Highlighter, 2, 'drag'),

  // -- Annotations -----------------------------------------------------------
  reg('text-annotation', TextAnnotation, 1),
  reg('note', Note, 1),
  reg('callout', Callout, 2),
  reg('price-label', PriceLabel, 1),
  reg('price-note', PriceNote, 1),
  reg('arrow-mark-up', ArrowMarkUp, 1),
  reg('flag-mark', FlagMark, 1),

  // -- Trading / Forecasting / Measurement ----------------------------------
  reg('long-position', LongPosition, 3),
  reg('short-position', ShortPosition, 3),
  reg('forecast', Forecast, 2),
  reg('projection', Projection, 3),
  reg('price-range', PriceRange, 2),
  reg('date-range', DateRange, 2),
  reg('date-price-range', DatePriceRange, 2),
  reg('bars-pattern', BarsPattern, 2),
]) as Record<ToolId, ToolDef>;

/**
 * Type guard: does this string identify a tool we actually know how to build?
 * The toolbar uses this to decide whether a button should be live or
 * rendered greyed-out with a "Coming soon" tooltip.
 */
export function isSupportedTool(id: string): id is ToolId {
  return id !== 'NONE' && Object.prototype.hasOwnProperty.call(TOOL_REGISTRY, id);
}
