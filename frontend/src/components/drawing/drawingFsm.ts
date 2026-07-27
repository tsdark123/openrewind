// =============================================================================
// drawingFsm.ts — placement state machine for the drawing layer.
//
// Replaces the old ad-hoc mouse handling in Chart.tsx that had two bugs:
//   1) "Vanishing tap-to-place": the old handler required `hasDragged === true`
//      to finalize, so a click-A → click-B sequence never committed.
//   2) "Lag while placing": the old handler called manager.removeDrawing +
//      new TrendLine(...) + manager.addDrawing on every pixel of mousemove,
//      churning a fresh drawing per frame.
//
// This FSM fixes both:
//   - It accepts discrete clicks and accumulates anchors until the active
//     tool's `requiredAnchors` is reached, then finalizes once.
//   - It creates ONE preview drawing on first click and mutates its anchors
//     in place via `IDrawing.setAnchors(...)` on each mousemove. No churn.
//
// The FSM is UI-framework-agnostic by design — it owns no React state, only
// imperative refs. Chart.tsx wires DOM events to its `onMouseDown` /
// `onMouseMove` / `onCancel` / `onDestroy` methods.
// =============================================================================

import type { Anchor, IDrawing, DrawingManager } from 'lightweight-charts-drawing';
import { TOOL_REGISTRY, type ActiveTool, type ToolId, type ToolDef } from './drawingTools';

const PREVIEW_ID_PREFIX = 'preview-drawing-';

/**
 * Outcome of a click on the chart canvas.
 * Chart.tsx uses this to decide whether to swallow the event (so the chart
 * doesn't pan) and whether to clear the active tool back to 'NONE'.
 */
export interface ClickOutcome {
  /** True if the FSM consumed the click (tool was active). */
  consumed: boolean;
  /** True if the drawing was just finalized (tool should reset to NONE). */
  finalized: boolean;
}

export interface FsmCallbacks {
  /**
   * Called when a drawing is committed to the manager so the parent can
   * track its id (e.g. for "clear all" / undo).
   */
  onCommitted: (drawingId: string) => void;
  /**
   * Called when the FSM finishes a placement so the UI can clear the active
   * tool back to 'NONE' (matches TradingView behavior).
   */
  onFinalize: () => void;
}

export class DrawingFsm {
  private manager: DrawingManager;
  private callbacks: FsmCallbacks;

  // Active tool (mirrors React state but read synchronously by mouse handlers).
  private tool: ActiveTool = 'NONE';

  // Anchors the user has committed via discrete clicks so far.
  private collected: Anchor[] = [];

  // The preview drawing currently displayed (last anchor tracks the cursor).
  // Created lazily on first click. Reused for every mousemove via setAnchors.
  private previewId: string | null = null;
  private preview: IDrawing | null = null;

  // Drag-mode bookkeeping for free-form tools (brush / highlighter).
  private dragging = false;

  constructor(manager: DrawingManager, callbacks: FsmCallbacks) {
    this.manager = manager;
    this.callbacks = callbacks;
  }

  // ---------------------------------------------------------------------------
  // External setters
  // ---------------------------------------------------------------------------

  /**
   * Switch the active tool. Cancels any in-flight placement so we never
   * leak a half-placed preview when the user changes their mind.
   */
  setTool(tool: ActiveTool) {
    if (this.tool === tool) return;
    this.cancel();
    this.tool = tool;
  }

  getTool(): ActiveTool {
    return this.tool;
  }

  isActive(): boolean {
    return this.tool !== 'NONE';
  }

  isPlacing(): boolean {
    return this.collected.length > 0 || this.dragging;
  }

  // ---------------------------------------------------------------------------
  // Mouse pipeline (called by Chart.tsx DOM listeners)
  // ---------------------------------------------------------------------------

  onMouseDown(anchor: Anchor): ClickOutcome {
    if (this.tool === 'NONE') return { consumed: false, finalized: false };
    const def = TOOL_REGISTRY[this.tool as ToolId];
    if (!def) return { consumed: false, finalized: false };

    if (def.placement === 'drag') {
      // Drag mode: start a fresh preview on mousedown, append anchors on move.
      this.dragging = true;
      this.collected = [anchor, anchor]; // brush requires >= 2
      this.beginPreview(def, this.collected);
      return { consumed: true, finalized: false };
    }

    // Click mode: append anchor, advance state.
    this.collected.push(anchor);

    if (this.collected.length >= def.requiredAnchors) {
      // Final click: commit the real drawing and tear down the preview.
      this.finalizeClickPlacement(def);
      return { consumed: true, finalized: true };
    }

    // Intermediate click: ensure the preview exists. Use the freshly clicked
    // anchor twice so the preview has 2 valid anchors (libraries that need
    // requiredAnchors to render still get something).
    const previewAnchors = [...this.collected, anchor];
    if (!this.preview) {
      this.beginPreview(def, previewAnchors);
    } else {
      this.updatePreviewAnchors(previewAnchors);
    }
    return { consumed: true, finalized: false };
  }

  /**
   * Move the preview's trailing anchor to the cursor position.
   * Called from a passive mousemove listener — no allocations per pixel.
   */
  onMouseMove(anchor: Anchor) {
    if (this.tool === 'NONE') return;
    if (!this.collected.length) return;

    const def = TOOL_REGISTRY[this.tool as ToolId];
    if (!def) return;

    if (def.placement === 'drag' && this.dragging) {
      // Free-form: append the cursor as a new anchor each move.
      this.collected.push(anchor);
      this.updatePreviewAnchors(this.collected);
      return;
    }

    // Click mode: trailing-anchor preview. We feed `[...collected, cursor]` so
    // the preview always has the right number of anchors for the lib to
    // render meaningfully.
    const previewAnchors = [...this.collected, anchor];
    if (!this.preview) {
      this.beginPreview(def, previewAnchors);
    } else {
      this.updatePreviewAnchors(previewAnchors);
    }
  }

  /**
   * Mouseup is only meaningful for drag-mode tools (brush / highlighter).
   * Click-mode placements complete on the Nth onMouseDown, not on release.
   */
  onMouseUp(): ClickOutcome {
    if (this.tool === 'NONE') return { consumed: false, finalized: false };
    const def = TOOL_REGISTRY[this.tool as ToolId];
    if (!def) return { consumed: false, finalized: false };

    if (def.placement === 'drag' && this.dragging) {
      this.finalizeDragPlacement(def);
      return { consumed: true, finalized: true };
    }
    return { consumed: this.isPlacing(), finalized: false };
  }

  /**
   * Cancel any in-flight placement. Idempotent.
   */
  cancel() {
    this.discardPreview();
    this.collected = [];
    this.dragging = false;
  }

  /**
   * Tear down all FSM state and any preview. Call on unmount.
   */
  destroy() {
    this.cancel();
    this.tool = 'NONE';
  }

  // ---------------------------------------------------------------------------
  // Preview management
  // ---------------------------------------------------------------------------

  private beginPreview(def: ToolDef, anchors: Anchor[]) {
    const id = `${PREVIEW_ID_PREFIX}${Date.now()}`;
    try {
      const drawing = def.factory(id, anchors);
      this.manager.addDrawing(drawing);
      this.previewId = id;
      this.preview = drawing;
    } catch (err) {
      // If the library refuses to construct with the given anchors (some
      // require strictly distinct points), bail silently — we'll retry on
      // the next move.
      console.warn('[DrawingFsm] preview create failed:', err);
    }
  }

  private updatePreviewAnchors(anchors: Anchor[]) {
    if (!this.preview) return;
    try {
      this.preview.setAnchors(anchors);
    } catch (err) {
      console.warn('[DrawingFsm] setAnchors failed:', err);
    }
  }

  private discardPreview() {
    if (this.previewId !== null) {
      try {
        this.manager.removeDrawing(this.previewId);
      } catch {
        /* already gone */
      }
    }
    this.previewId = null;
    this.preview = null;
  }

  // ---------------------------------------------------------------------------
  // Finalization
  // ---------------------------------------------------------------------------

  private finalizeClickPlacement(def: ToolDef) {
    const finalAnchors = [...this.collected];
    this.discardPreview();
    this.collected = [];
    this.commitFinal(def, finalAnchors);
  }

  private finalizeDragPlacement(def: ToolDef) {
    // Drag tools need at least 2 anchors; if the user merely clicked without
    // moving we silently drop the placement.
    const finalAnchors = [...this.collected];
    this.discardPreview();
    this.collected = [];
    this.dragging = false;
    if (finalAnchors.length < 2) {
      this.callbacks.onFinalize();
      return;
    }
    this.commitFinal(def, finalAnchors);
  }

  private commitFinal(def: ToolDef, anchors: Anchor[]) {
    const id = `drawing-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    try {
      const drawing = def.factory(id, anchors);
      this.manager.addDrawing(drawing);
      this.callbacks.onCommitted(id);
    } catch (err) {
      console.warn('[DrawingFsm] final create failed:', err);
    }
    this.callbacks.onFinalize();
  }
}
