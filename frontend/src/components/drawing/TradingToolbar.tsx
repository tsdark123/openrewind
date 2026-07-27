// =============================================================================
// TradingToolbar.tsx — TradingView-style drawing palette.
//
// Ported from a Vercel v0 prototype at
//   c:/Users/logja/Downloads/trading-view-toolbar-clone/components/trading-toolbar.tsx
//
// What was changed during port:
//   1. Stripped the Next.js "use client" directive.
//   2. Replaced the `@/lib/utils` alias with a relative import.
//   3. Added `supported`/`toolId` fields on every tool entry. Entries without
//      a backing IDrawing class in lightweight-charts-drawing are rendered
//      greyed-out with a "Coming soon" tooltip per the agreed plan.
//   4. Replaced the local `selectedTool` self-state with prop-driven state
//      so App.tsx is the single source of truth and Chart.tsx FSM can sync.
//   5. Added a `lightMode` prop to theme-bridge between the v0 light palette
//      (1:1) and our dark palette.
//   6. Wired the trash + lock utility buttons to live callbacks.
//
// Everything else — icon SVGs, layout, classnames, flyout structure — is
// kept as v0 produced it so future v0 updates can be re-pulled with minimal
// merge pain.
// =============================================================================

import * as React from 'react';
import { cn } from '../../lib/utils';
import {
  isSupportedTool,
  type ActiveTool,
  type ToolId,
} from './drawingTools';

// Icon components matching TradingView's exact style - thin line icons
const CrosshairIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M14 5v18M5 14h18" />
    <rect x="12" y="12" width="4" height="4" fill="none" strokeWidth="1" />
  </svg>
);

const TrendLineIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M6 20L22 8" />
    <circle cx="6" cy="20" r="2" fill="none" />
  </svg>
);

const GannFibIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M5 8h18M5 12h18M5 16h18M5 20h18" />
  </svg>
);

const PatternIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <circle cx="9" cy="10" r="2.5" />
    <circle cx="19" cy="10" r="2.5" />
    <circle cx="14" cy="19" r="2.5" />
    <path d="M11 11.5l3 5M17 11.5l-3 5M11.5 10h5" />
  </svg>
);

const ForecastIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="6" y="12" width="6" height="10" fill="none" />
    <path d="M6 22h6M6 17h6M12 22v-10" />
    <path d="M6 12l3-6 3 6" fill="none" />
    <path d="M16 9h2M20 9h2" />
  </svg>
);

const BrushIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M7 21l2-2M9 19c0-2 2-4 4-4l8-8 2 2-8 8c0 2-2 4-4 4l-2 2z" />
  </svg>
);

const TextIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.8">
    <path d="M8 9h12M14 9v12" />
  </svg>
);

const EmojiIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <circle cx="14" cy="14" r="9" />
    <circle cx="10.5" cy="12" r="1" fill="currentColor" stroke="none" />
    <circle cx="17.5" cy="12" r="1" fill="currentColor" stroke="none" />
    <path d="M10 17c1.5 1.5 6.5 1.5 8 0" />
  </svg>
);

const MeasureIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="5" y="11" width="18" height="6" rx="1" />
    <path d="M8 11v6M11 11v4M14 11v6M17 11v4M20 11v6" strokeWidth="0.8" />
  </svg>
);

const ZoomIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <circle cx="12" cy="12" r="7" />
    <path d="M17 17l6 6" strokeWidth="1.5" strokeLinecap="round" />
    <path d="M9 12h6M12 9v6" />
  </svg>
);

const MagnetIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M9 10v5a5 5 0 0010 0v-5" />
    <rect x="7" y="6" width="4" height="5" rx="0.5" />
    <rect x="17" y="6" width="4" height="5" rx="0.5" />
    <path d="M7 9h4M17 9h4" strokeWidth="1" />
  </svg>
);

const StayOnTopIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="6" y="11" width="10" height="10" rx="1.5" />
    <path d="M12 6h9a1.5 1.5 0 011.5 1.5V16" />
  </svg>
);

const LockIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <rect x="8" y="13" width="12" height="9" rx="1.5" />
    <path d="M11 13v-3a3 3 0 016 0v3" />
  </svg>
);

const EyeIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M14 8c-5 0-9 4-10 6 1 2 5 6 10 6s9-4 10-6c-1-2-5-6-10-6z" />
    <circle cx="14" cy="14" r="3" />
  </svg>
);

const TrashIcon = () => (
  <svg width="28" height="28" viewBox="0 0 28 28" fill="none" stroke="currentColor" strokeWidth="1.2">
    <path d="M8 10h12" />
    <path d="M11 10V8h6v2" />
    <path d="M9 10l1 12h8l1-12" />
    <path d="M12 13v6M16 13v6" />
  </svg>
);

// Sub-menu icons - 18x18 size
const TrendLineSmallIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M3 13L15 5" />
    <circle cx="3" cy="13" r="1.5" fill="none" />
  </svg>
);

const RayIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M3 13l12-8" />
    <circle cx="3" cy="13" r="1.5" fill="none" />
  </svg>
);

const ExtendedLineIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M1 14l16-10" />
    <circle cx="5" cy="11.5" r="1.5" fill="none" />
    <circle cx="13" cy="6.5" r="1.5" fill="none" />
  </svg>
);

const HorizontalLineIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M1 9h16" />
    <circle cx="9" cy="9" r="1.5" fill="none" />
  </svg>
);

const VerticalLineIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M9 1v16" />
    <circle cx="9" cy="9" r="1.5" fill="none" />
  </svg>
);

const CrossLineIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M9 1v16M1 9h16" />
  </svg>
);

const ParallelChannelIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M1 13l16-6M1 9l16-6" />
  </svg>
);

const FibRetracementIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 3h14M2 7h14M2 11h14M2 15h14" />
  </svg>
);

const FibExtensionIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 3h14M2 9h14M2 15h14" />
    <path d="M4 3l5 12 5-12" strokeDasharray="2 1" />
  </svg>
);

const FibChannelIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M1 15l16-10M1 11l16-10M1 7l14-6" />
  </svg>
);

const FibTimeZoneIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M3 1v16M6 1v16M10 1v16M15 1v16" />
  </svg>
);

const FibFanIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 15l14-3M2 15l14-7M2 15l14-11M2 15l10-13" />
  </svg>
);

const FibArcIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 15 A13 13 0 0 1 15 2" />
    <path d="M2 15 A9 9 0 0 1 11 6" />
    <path d="M2 15 A5 5 0 0 1 7 10" />
  </svg>
);

const FibCirclesIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <circle cx="9" cy="9" r="7" />
    <circle cx="9" cy="9" r="5" />
    <circle cx="9" cy="9" r="3" />
  </svg>
);

const FibSpiralIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M9 9 A1 1 0 0 1 10 10 A2 2 0 0 1 8 12 A4 4 0 0 1 4 8 A6 6 0 0 1 10 2 A8 8 0 0 1 17 10" />
  </svg>
);

const FibWedgeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 15l7-13M2 15l14-5" />
    <path d="M2 15l10-10M2 15l12-7" strokeDasharray="2 1" />
  </svg>
);

const PitchforkIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M3 15l6-12 6 12M9 3v12" />
  </svg>
);

const GannBoxIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <rect x="2" y="2" width="14" height="14" />
    <path d="M2 9h14M9 2v14M2 2l14 14M16 2L2 16" />
  </svg>
);

const GannSquareIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <rect x="2" y="2" width="14" height="14" />
    <path d="M2 5.5h14M2 9h14M2 12.5h14M5.5 2v14M9 2v14M12.5 2v14" strokeWidth="0.7" />
  </svg>
);

const GannFanIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 16h14M2 16l3-14M2 16l7-14M2 16l11-14M2 16l14-10M2 16l14-5" />
  </svg>
);

const LongPositionIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <rect x="3" y="3" width="12" height="12" />
    <path d="M6 12V9h2.5v3" />
    <path d="M9 3v5" />
    <path d="M7 5l2-2 2 2" />
  </svg>
);

const ShortPositionIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <rect x="3" y="3" width="12" height="12" />
    <path d="M6 6v3h2.5V6" />
    <path d="M9 15v-5" />
    <path d="M7 13l2 2 2-2" />
  </svg>
);

const PositionForecastIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M3 13V6M6 13V8M9 13V4M12 13V7M15 13V5" />
  </svg>
);

const BarPatternIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M4 3v12M4 5h2M4 13h-2" />
    <path d="M9 5v10M9 7h2M9 13h-2" />
    <path d="M14 2v13M14 4h2M14 13h-2" />
  </svg>
);

const GhostFeedIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1" opacity="0.6">
    <path d="M4 3v12M4 5h2M4 13h-2" strokeDasharray="2 1" />
    <path d="M9 5v10M9 7h2M9 13h-2" strokeDasharray="2 1" />
    <path d="M14 2v13M14 4h2M14 13h-2" strokeDasharray="2 1" />
    <circle cx="4" cy="3" r="1.5" fill="none" />
  </svg>
);

const SectorIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M9 9l6-6M9 9l6 3" />
    <path d="M15 3 A8 8 0 0 1 15 12" />
  </svg>
);

const AnchoredVWAPIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 14l4-7 4 3 6-6" />
    <circle cx="2" cy="14" r="1.5" fill="currentColor" stroke="none" />
    <path d="M2 14v-4" strokeDasharray="1 1" />
  </svg>
);

const VolumeProfileIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 2v14M2 3h7M2 5h11M2 7h5M2 9h9M2 11h3M2 13h6M2 15h4" />
  </svg>
);

const PriceRangeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M9 2v14" />
    <path d="M6 3h6M6 15h6" />
    <path d="M9 3l-2 2M9 3l2 2M9 15l-2-2M9 15l2-2" />
  </svg>
);

const DateRangeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 9h14" />
    <path d="M3 6v6M15 6v6" />
    <path d="M3 9l2-2M3 9l2 2M15 9l-2-2M15 9l-2 2" />
  </svg>
);

const DatePriceRangeIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <rect x="3" y="3" width="12" height="12" />
    <path d="M3 3l12 12" strokeDasharray="2 1" />
  </svg>
);

const RectangleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <rect x="3" y="5" width="12" height="8" />
  </svg>
);

const EllipseIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <ellipse cx="9" cy="9" rx="6" ry="4" />
  </svg>
);

const TriangleIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M9 3l7 12H2z" />
  </svg>
);

const PolylineIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 14l4-8 4 4 6-8" />
    <circle cx="2" cy="14" r="1" fill="currentColor" stroke="none" />
    <circle cx="6" cy="6" r="1" fill="currentColor" stroke="none" />
    <circle cx="10" cy="10" r="1" fill="currentColor" stroke="none" />
    <circle cx="16" cy="2" r="1" fill="currentColor" stroke="none" />
  </svg>
);

const ArcIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M3 14 Q9 2 15 14" />
  </svg>
);

const NoteIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <rect x="3" y="2" width="12" height="14" rx="1" />
    <path d="M6 6h6M6 9h6M6 12h4" />
  </svg>
);

const CalloutIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M3 3h12v9H8l-3 3v-3H3z" />
  </svg>
);

const PriceNoteIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <rect x="2" y="6" width="10" height="6" rx="1" />
    <path d="M12 9h4" />
  </svg>
);

const ArrowMarkIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M9 14V4" />
    <path d="M5 8l4-4 4 4" />
  </svg>
);

const FlagIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M4 2v14" />
    <path d="M4 2h10l-3 4 3 4H4" />
  </svg>
);

const HeadAndShouldersIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 12l3-4 2 2 2-6 2 6 2-2 3 4" />
  </svg>
);

const ElliottWaveIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 14l2-4 2 2 2-6 2 4 2-2 2 4 2-6" />
  </svg>
);

const CyclicLinesIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M4 2v14M9 2v14M14 2v14" />
  </svg>
);

const ABCDIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M2 14l4-10 4 6 4-6" />
  </svg>
);

const XABCDIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.1">
    <path d="M1 10l3-6 4 8 4-8 4 6" />
  </svg>
);

// Arrow indicator for expandable items
const ChevronIcon = ({ className }: { className?: string }) => (
  <svg width="5" height="8" viewBox="0 0 5 8" fill="currentColor" className={className}>
    <path d="M1 1l3 3-3 3" stroke="currentColor" strokeWidth="1.2" fill="none" />
  </svg>
);

// =============================================================================
// Tool catalog (data-only). Each entry has a stable v0 `id` for selection state
// and an optional `toolId` (typed against TOOL_REGISTRY) that wires it to the
// drawing engine. `supported: false` entries render greyed out with a
// "Coming soon" tooltip.
// =============================================================================

interface ToolEntry {
  id: string;
  icon: React.FC;
  label: string;
  shortcut: string;
  supported: boolean;
  toolId?: ToolId;
}

interface ToolCategory {
  id: string;
  icon: React.FC;
  label: string;
  tools?: ToolEntry[];
  sections?: { title: string; tools: ToolEntry[] }[];
}

interface UtilityTool {
  id: string;
  icon: React.FC;
  label: string;
  supported: boolean;
}

const T = (
  id: string,
  icon: React.FC,
  label: string,
  shortcut: string,
  toolId?: ToolId,
): ToolEntry => ({
  id,
  icon,
  label,
  shortcut,
  toolId,
  supported: toolId !== undefined && isSupportedTool(toolId),
});

const TooSoon = (id: string, icon: React.FC, label: string, shortcut = ''): ToolEntry => ({
  id,
  icon,
  label,
  shortcut,
  supported: false,
});

const toolCategories: ToolCategory[] = [
  {
    id: 'cursor',
    icon: CrosshairIcon,
    label: 'Cursor',
    tools: [
      // The cursor sub-menu is cosmetic — clicking any of these just deselects
      // the active drawing tool. We treat them all as "supported" with no
      // backing toolId so the click handler clears state.
      { id: 'cross', icon: CrosshairIcon, label: 'Cross', shortcut: '', supported: true },
      { id: 'dot', icon: CrosshairIcon, label: 'Dot', shortcut: '', supported: true },
      { id: 'arrow', icon: CrosshairIcon, label: 'Arrow', shortcut: '', supported: true },
      { id: 'eraser', icon: CrosshairIcon, label: 'Eraser', shortcut: '', supported: true },
    ],
  },
  {
    id: 'trendline',
    icon: TrendLineIcon,
    label: 'Trend Line Tools',
    tools: [
      T('trend-line', TrendLineSmallIcon, 'Trend Line', 'Alt + T', 'trend-line'),
      T('ray', RayIcon, 'Ray', '', 'ray'),
      T('info-line', ExtendedLineIcon, 'Info Line', '', 'info-line'),
      T('extended', ExtendedLineIcon, 'Extended Line', '', 'extended-line'),
      T('trend-angle', TrendLineSmallIcon, 'Trend Angle', '', 'trend-angle'),
      T('horizontal', HorizontalLineIcon, 'Horizontal Line', 'Alt + H', 'horizontal-line'),
      T('horizontal-ray', HorizontalLineIcon, 'Horizontal Ray', 'Alt + J', 'horizontal-ray'),
      T('vertical', VerticalLineIcon, 'Vertical Line', 'Alt + V', 'vertical-line'),
      T('cross-line', CrossLineIcon, 'Cross Line', '', 'cross-line'),
      T('parallel-channel', ParallelChannelIcon, 'Parallel Channel', '', 'parallel-channel'),
      T('regression-trend', ParallelChannelIcon, 'Regression Trend', '', 'regression-trend'),
      T('flat-top-bottom', ParallelChannelIcon, 'Flat Top/Bottom', '', 'flat-top-bottom'),
      T('disjoint-channel', ParallelChannelIcon, 'Disjoint Channel', '', 'disjoint-channel'),
    ],
  },
  {
    id: 'gann-fib',
    icon: GannFibIcon,
    label: 'Gann and Fibonacci Tools',
    sections: [
      {
        title: 'FIBONACCI',
        tools: [
          T('fib-retracement', FibRetracementIcon, 'Fib retracement', 'Alt + F', 'fib-retracement'),
          T('fib-extension', FibExtensionIcon, 'Trend-based fib extension', '', 'fib-extension'),
          T('fib-channel', FibChannelIcon, 'Fib channel', '', 'fib-channel'),
          T('fib-time', FibTimeZoneIcon, 'Fib time zone', '', 'fib-time-zone'),
          T('fib-fan', FibFanIcon, 'Fib speed resistance fan', '', 'fib-speed-fan'),
          T('fib-time-trend', PositionForecastIcon, 'Trend-based fib time', '', 'fib-time-extension'),
          T('fib-circles', FibCirclesIcon, 'Fib circles', '', 'fib-circles'),
          T('fib-spiral', FibSpiralIcon, 'Fib spiral', '', 'fib-spiral'),
          T('fib-arcs', FibArcIcon, 'Fib speed resistance arcs', '', 'fib-arcs'),
          T('fib-wedge', FibWedgeIcon, 'Fib wedge', '', 'fib-wedge'),
          T('pitchfork', PitchforkIcon, 'Pitchfan', '', 'pitchfan'),
        ],
      },
      {
        title: 'GANN',
        tools: [
          T('gann-box', GannBoxIcon, 'Gann box', '', 'gann-box'),
          T('gann-square-fixed', GannSquareIcon, 'Gann square fixed', '', 'gann-square-fixed'),
          T('gann-square', GannSquareIcon, 'Gann square', '', 'gann-square'),
          T('gann-fan', GannFanIcon, 'Gann fan', '', 'gann-fan'),
        ],
      },
    ],
  },
  {
    id: 'patterns',
    // No backing classes for any pattern tool — entire group is greyed out.
    icon: PatternIcon,
    label: 'Patterns',
    tools: [
      TooSoon('xabcd', XABCDIcon, 'XABCD Pattern'),
      TooSoon('cypher', ABCDIcon, 'Cypher Pattern'),
      TooSoon('abcd', ABCDIcon, 'ABCD Pattern'),
      TooSoon('three-drives', ABCDIcon, 'Three Drives Pattern'),
      TooSoon('head-shoulders', HeadAndShouldersIcon, 'Head and Shoulders'),
      TooSoon('elliott-impulse', ElliottWaveIcon, 'Elliott Impulse Wave (12345)'),
      TooSoon('elliott-triangle', ElliottWaveIcon, 'Elliott Triangle Wave (ABCDE)'),
      TooSoon('elliott-triple', ElliottWaveIcon, 'Elliott Triple Combo Wave (WXYXZ)'),
      TooSoon('elliott-correction', ElliottWaveIcon, 'Elliott Correction Wave (ABC)'),
      TooSoon('elliott-double', ElliottWaveIcon, 'Elliott Double Combo Wave (WXY)'),
      TooSoon('cyclic-lines', CyclicLinesIcon, 'Cyclic Lines'),
      TooSoon('time-cycles', CyclicLinesIcon, 'Time Cycles'),
      TooSoon('sine-line', CyclicLinesIcon, 'Sine Line'),
    ],
  },
  {
    id: 'forecast',
    icon: ForecastIcon,
    label: 'Forecasting & Measurement',
    sections: [
      {
        title: 'FORECASTING',
        tools: [
          T('long-position', LongPositionIcon, 'Long position', '', 'long-position'),
          T('short-position', ShortPositionIcon, 'Short position', '', 'short-position'),
          T('position-forecast', PositionForecastIcon, 'Position forecast', '', 'forecast'),
          T('bar-pattern', BarPatternIcon, 'Bar pattern', '', 'bars-pattern'),
          TooSoon('ghost-feed', GhostFeedIcon, 'Ghost feed'),
          TooSoon('sector', SectorIcon, 'Sector'),
        ],
      },
      {
        title: 'VOLUME-BASED',
        tools: [
          TooSoon('anchored-vwap', AnchoredVWAPIcon, 'Anchored VWAP'),
          TooSoon('fixed-volume', VolumeProfileIcon, 'Fixed range volume profile'),
          TooSoon('anchored-volume', VolumeProfileIcon, 'Anchored volume profile'),
        ],
      },
      {
        title: 'MEASURERS',
        tools: [
          T('price-range', PriceRangeIcon, 'Price range', '', 'price-range'),
          T('date-range', DateRangeIcon, 'Date range', '', 'date-range'),
          T('date-price-range', DatePriceRangeIcon, 'Date and price range', '', 'date-price-range'),
        ],
      },
    ],
  },
  {
    id: 'shapes',
    icon: BrushIcon,
    label: 'Geometric Shapes',
    tools: [
      T('brush', BrushIcon, 'Brush', '', 'brush'),
      T('highlighter', BrushIcon, 'Highlighter', '', 'highlighter'),
      T('rectangle', RectangleIcon, 'Rectangle', '', 'rectangle'),
      T('rotated-rectangle', RectangleIcon, 'Rotated Rectangle', '', 'rotated-rectangle'),
      T('ellipse', EllipseIcon, 'Ellipse', '', 'ellipse'),
      T('triangle', TriangleIcon, 'Triangle', '', 'triangle'),
      T('polyline', PolylineIcon, 'Polyline', '', 'polyline'),
      T('curve', ArcIcon, 'Curve', '', 'curve'),
      // No 'arc' class in the library — folded into curve. Mark separately.
      TooSoon('arc', ArcIcon, 'Arc'),
    ],
  },
  {
    id: 'text',
    icon: TextIcon,
    label: 'Annotation Tools',
    tools: [
      T('text', TextIcon, 'Text', '', 'text-annotation'),
      // The library only has one text class — anchored-text is a v0 distinction.
      TooSoon('anchored-text', TextIcon, 'Anchored Text'),
      T('note', NoteIcon, 'Note', '', 'note'),
      TooSoon('anchored-note', NoteIcon, 'Anchored Note'),
      T('callout', CalloutIcon, 'Callout', '', 'callout'),
      T('price-label', PriceNoteIcon, 'Price Label', '', 'price-label'),
      T('price-note', PriceNoteIcon, 'Price Note', '', 'price-note'),
      T('arrow-mark', ArrowMarkIcon, 'Arrow Mark', '', 'arrow-mark-up'),
      T('flag', FlagIcon, 'Flag Mark', '', 'flag-mark'),
    ],
  },
  {
    id: 'emoji',
    icon: EmojiIcon,
    label: 'Icons',
    tools: [
      TooSoon('emoji', EmojiIcon, 'Emoji'),
      TooSoon('sticker', EmojiIcon, 'Sticker'),
    ],
  },
];

// -----------------------------------------------------------------------------
// Utility row (bottom of toolbar). `supported: true` entries are wired below
// in the click handler; the rest stay greyed out.
// -----------------------------------------------------------------------------

// Map each selectable tool id (including cursor variants) back to its parent
// category so the main toolbar category button stays highlighted while a tool
// from that category is active.
const toolIdToCategory: Record<string, string> = {};
toolCategories.forEach((category) => {
  const entries = category.tools ?? [];
  category.sections?.forEach((section) => entries.push(...section.tools));
  entries.forEach((tool) => {
    toolIdToCategory[tool.id] = category.id;
  });
});

const utilityTools: UtilityTool[] = [
  { id: 'measure', icon: MeasureIcon, label: 'Measure', supported: false },
  { id: 'zoom', icon: ZoomIcon, label: 'Zoom In', supported: false },
  { id: 'magnet', icon: MagnetIcon, label: 'Magnet Mode', supported: false },
  { id: 'stay-on-top', icon: StayOnTopIcon, label: 'Stay on Top', supported: false },
  { id: 'lock', icon: LockIcon, label: 'Lock All Drawings', supported: true },
  { id: 'eye', icon: EyeIcon, label: 'Hide All Drawings', supported: false },
  { id: 'trash', icon: TrashIcon, label: 'Remove Objects', supported: true },
];

// =============================================================================
// Component
// =============================================================================

export interface TradingToolbarProps {
  /** Currently active drawing tool, or 'NONE' when in cursor mode. */
  activeTool: ActiveTool;
  /** Called when the user picks a tool. Pass 'NONE' to deselect. */
  onActiveToolChange: (tool: ActiveTool) => void;
  /** Whether the chart is locked (suppresses pan/zoom). */
  chartLocked: boolean;
  onChartLockedChange: (locked: boolean) => void;
  /** Callback to wipe every committed drawing from the chart. */
  onClearAll: () => void;
  /** Theme mode — true for the 1:1 v0 light palette, false for our dark palette. */
  lightMode?: boolean;
}

export function TradingToolbar({
  activeTool,
  onActiveToolChange,
  chartLocked,
  onChartLockedChange,
  onClearAll,
  lightMode = false,
}: TradingToolbarProps) {
  const [activeCategory, setActiveCategory] = React.useState<string | null>(null);
  const toolbarRef = React.useRef<HTMLDivElement>(null);
  const [submenuPosition, setSubmenuPosition] = React.useState(0);

  // Track the last cursor-style id picked from the cursor sub-menu so the
  // group icon reflects the user's choice. Doesn't affect the FSM.
  const [cursorVariant, setCursorVariant] = React.useState<string>('cross');

  // Derive the v0-style "selectedTool" string from the active drawing tool
  // for the highlight state. When no tool is active we fall back to the
  // current cursor variant.
  const selectedTool = activeTool === 'NONE' ? cursorVariant : activeTool;

  // Keep the parent category highlighted after the user picks a specific tool
  // and the flyout closes.
  const activeToolCategory = toolIdToCategory[selectedTool] ?? null;

  const handleCategoryClick = (categoryId: string, buttonRect: DOMRect) => {
    if (activeCategory === categoryId) {
      setActiveCategory(null);
    } else {
      const toolbarRect = toolbarRef.current?.getBoundingClientRect();
      if (toolbarRect) {
        setSubmenuPosition(buttonRect.top - toolbarRect.top);
      }
      setActiveCategory(categoryId);
    }
  };

  const handleToolSelect = (tool: ToolEntry, categoryId: string) => {
    if (!tool.supported) return;
    setActiveCategory(null);

    if (categoryId === 'cursor') {
      // Cursor sub-menu = cosmetic. Clear any active drawing tool.
      setCursorVariant(tool.id);
      onActiveToolChange('NONE');
      return;
    }

    if (tool.toolId) {
      onActiveToolChange(tool.toolId);
    }
  };

  const handleUtilityClick = (tool: UtilityTool) => {
    if (!tool.supported) return;
    if (tool.id === 'lock') {
      onChartLockedChange(!chartLocked);
    } else if (tool.id === 'trash') {
      onClearAll();
    }
  };

  // ---- Theme tokens ---------------------------------------------------------
  // Light = the v0 palette verbatim. Dark = our chrome palette.
  const t = lightMode
    ? {
        bg: 'bg-white',
        border: 'border-[#e0e3eb]',
        divider: 'border-[#e0e3eb]',
        groupBtnIdle: 'text-[#131722] hover:bg-[#f0f3fa]',
        groupBtnActive: 'bg-[#f0f3fa] text-[#2962ff]',
        flyoutBg: 'bg-white border-[#e0e3eb]',
        flyoutShadow: 'shadow-[0_2px_16px_rgba(0,0,0,0.1)]',
        flyoutSection: 'text-[#787b86]',
        flyoutItemIdle: 'text-[#131722] hover:bg-[#f0f3fa]',
        flyoutItemActive: 'bg-[#d3e3fd] text-[#131722]',
        flyoutItemIcon: 'text-[#131722]',
        flyoutShortcut: 'text-[#787b86]',
        flyoutDivider: 'border-[#e0e3eb]',
        chevron: 'text-[#787b86]',
      }
    : {
        bg: 'bg-[#121416]',
        border: 'border-[#2a2e39]',
        divider: 'border-[#2a2e39]',
        groupBtnIdle: 'text-[#d1d4dc] hover:bg-[#2a2e39]',
        groupBtnActive: 'bg-[#2a2e39] text-[#2962ff]',
        flyoutBg: 'bg-[#1e222d] border-[#363a45]',
        flyoutShadow: 'shadow-[0_2px_16px_rgba(0,0,0,0.6)]',
        flyoutSection: 'text-[#787b86]',
        flyoutItemIdle: 'text-[#d1d4dc] hover:bg-[#2a2e39]',
        flyoutItemActive: 'bg-[#2962ff]/15 text-[#2962ff]',
        flyoutItemIcon: 'text-[#d1d4dc]',
        flyoutShortcut: 'text-[#787b86]',
        flyoutDivider: 'border-[#363a45]',
        chevron: 'text-[#787b86]',
      };

  const renderToolButton = (tool: ToolEntry, categoryId: string) => {
    const isActive = selectedTool === tool.id;
    return (
      <button
        key={tool.id}
        type="button"
        disabled={!tool.supported}
        title={tool.supported ? tool.label : `${tool.label} — Coming soon`}
        onClick={() => handleToolSelect(tool, categoryId)}
        className={cn(
          'flex w-full items-center gap-3 px-4 py-[7px] text-left text-[13px] transition-colors',
          tool.supported
            ? isActive
              ? t.flyoutItemActive
              : t.flyoutItemIdle
            : 'opacity-40 cursor-not-allowed',
        )}
      >
        <span className={cn('flex h-[18px] w-[18px] items-center justify-center', t.flyoutItemIcon)}>
          <tool.icon />
        </span>
        <span className="flex-1">{tool.label}</span>
        {tool.shortcut && (
          <span className={cn('text-[11px]', t.flyoutShortcut)}>{tool.shortcut}</span>
        )}
      </button>
    );
  };

  const renderSubmenu = (category: ToolCategory) => {
    if (category.sections) {
      return (
        <div className="flex flex-col py-1">
          {category.sections.map((section, idx) => (
            <div key={section.title}>
              <div className={cn('px-4 py-2 text-[11px] font-medium tracking-wide', t.flyoutSection)}>
                {section.title}
              </div>
              {section.tools.map((tool) => renderToolButton(tool, category.id))}
              {idx < category.sections!.length - 1 && (
                <div className={cn('my-1 mx-2 border-t', t.flyoutDivider)} />
              )}
            </div>
          ))}
        </div>
      );
    }

    if (category.tools) {
      return (
        <div className="flex flex-col py-1">
          {category.tools.map((tool) => renderToolButton(tool, category.id))}
        </div>
      );
    }

    return null;
  };

  return (
    <div className="relative flex h-full" ref={toolbarRef}>
      {/* Main Toolbar */}
      <div className={cn('flex h-full w-[45px] flex-col border-r', t.bg, t.border)}>
        {/* Tool Categories */}
        <div className="flex flex-col items-center py-1">
          {toolCategories.map((category) => (
            <div key={category.id} className="relative">
              <button
                type="button"
                onClick={(e) =>
                  handleCategoryClick(category.id, e.currentTarget.getBoundingClientRect())
                }
                title={category.label}
                className={cn(
                  'group relative flex h-[36px] w-[36px] items-center justify-center rounded-[4px] transition-colors my-[2px]',
                  (activeCategory === category.id || activeToolCategory === category.id)
                    ? t.groupBtnActive
                    : t.groupBtnIdle,
                )}
              >
                <category.icon />
                {(category.tools || category.sections) && (
                  <ChevronIcon
                    className={cn('absolute bottom-[5px] right-[5px] opacity-60', t.chevron)}
                  />
                )}
              </button>
            </div>
          ))}
        </div>

        {/* Separator */}
        <div className={cn('mx-2 my-1 border-t', t.divider)} />

        {/* Utility Tools */}
        <div className="flex flex-col items-center">
          {utilityTools.map((tool) => {
            const isActive =
              (tool.id === 'lock' && chartLocked) || selectedTool === tool.id;
            return (
              <button
                key={tool.id}
                type="button"
                onClick={() => handleUtilityClick(tool)}
                disabled={!tool.supported}
                className={cn(
                  'group flex h-[36px] w-[36px] items-center justify-center rounded-[4px] transition-colors my-[2px]',
                  tool.supported
                    ? isActive
                      ? t.groupBtnActive
                      : t.groupBtnIdle
                    : cn('opacity-40 cursor-not-allowed', t.groupBtnIdle),
                )}
                title={tool.supported ? tool.label : `${tool.label} — Coming soon`}
              >
                <tool.icon />
              </button>
            );
          })}
        </div>

        {/* Spacer */}
        <div className="flex-1" />
      </div>

      {/* Flyout Submenu */}
      {activeCategory && (
        <>
          {/* Backdrop */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setActiveCategory(null)}
          />
          {/* Submenu */}
          <div
            className={cn(
              'absolute left-[44px] z-50 min-w-[260px] rounded-[4px] border',
              t.flyoutBg,
              t.flyoutShadow,
            )}
            style={{
              top: `${submenuPosition}px`,
              maxHeight: 'calc(100vh - 20px)',
              overflowY: 'auto',
            }}
          >
            {renderSubmenu(toolCategories.find((c) => c.id === activeCategory)!)}
          </div>
        </>
      )}
    </div>
  );
}
