// =============================================================================
// OrionDrivingOverlay — Transparent "glass" lock layer + status pill.
//
// Mounts as `position: absolute; inset: 0` inside the chart container
// whenever the OrionController is driving. Purpose:
//
//   - Block accidental clicks and keyboard shortcuts on the workspace while
//     Orion is executing an autonomous task. Chart itself stays visible so
//     the user sees the automation happen in real time.
//   - Show a subtle pulsing `#ff3700` inset border and a top-center status
//     pill so the user always knows Orion is in control.
//   - Provide an explicit "Esc to stop" affordance. Esc is NOT swallowed
//     by the overlay; the App's global keydown handler picks it up.
// =============================================================================

import { useEffect } from 'react';
import { motion } from 'motion/react';
import { Sparkles, Square } from 'lucide-react';
import { orionController } from '../../lib/orion/controller';

export interface OrionDrivingOverlayProps {
  visible: boolean;
  activityLine?: string;
}

export function OrionDrivingOverlay({ visible, activityLine }: OrionDrivingOverlayProps) {
  // Global Escape to cancel — captures at window level so it works even
  // if a background element still holds keyboard focus.
  useEffect(() => {
    if (!visible) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        orionController.cancel();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [visible]);

  if (!visible) return null;

  return (
    <div
      // Chart-area glass layer. `pointer-events: none` keeps the visual
      // overlay over the canvas without intercepting clicks on the toolbar,
      // symbol input, sidebar, or any header menus.
      className="pointer-events-none absolute inset-0 z-20"
      // No click handler — swallowing pointer events is enough. We keep
      // the layer visually transparent so the chart & animations stay
      // fully readable.
      aria-hidden="true"
    >
      {/* Pulsing red-orange inset ring */}
      <motion.div
        initial={{ opacity: 0.35 }}
        animate={{ opacity: [0.35, 0.7, 0.35] }}
        transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
        className="pointer-events-none absolute inset-0"
        style={{ boxShadow: 'inset 0 0 0 2px #ff3700' }}
      />

      {/* Top-center status pill */}
      <motion.div
        initial={{ y: -12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        exit={{ y: -12, opacity: 0 }}
        transition={{ duration: 0.25 }}
        className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 select-none"
      >
        <div className="flex items-center gap-2 rounded-full border border-[#ff3700]/50 bg-[#121416]/95 px-3 py-1.5 text-[12px] font-medium text-[#d1d4dc] shadow-lg backdrop-blur">
          <Sparkles className="h-3.5 w-3.5 text-[#ff3700]" />
          <span>
            Orion is driving
            {activityLine ? ` — ${activityLine}` : ''}
          </span>
          <span className="mx-1 h-3 w-px bg-[#2a2e39]" />
          <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-[#787b86]">
            <Square className="h-2.5 w-2.5" /> Esc to stop
          </span>
        </div>
      </motion.div>
    </div>
  );
}
