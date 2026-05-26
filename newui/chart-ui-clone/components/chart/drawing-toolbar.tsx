"use client";

import { Type, Magnet, ZoomIn, Lock, Paintbrush, Ruler, Eye, Trash2 } from "lucide-react";

export function DrawingToolbar() {
  return (
    <div className="flex w-10 flex-col items-center gap-0.5 border-r border-[#2a2e39] bg-[#121416] py-2">
      {/* Crosshair tool */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <line x1="12" y1="3" x2="12" y2="21" />
          <line x1="3" y1="12" x2="21" y2="12" />
        </svg>
      </button>

      {/* Trend line tool */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <line x1="5" y1="19" x2="19" y2="5" />
        </svg>
      </button>

      {/* Horizontal lines tool */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <line x1="4" y1="8" x2="20" y2="8" />
          <line x1="4" y1="12" x2="20" y2="12" />
          <line x1="4" y1="16" x2="20" y2="16" />
        </svg>
      </button>

      {/* Fibonacci tool */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M5 5v14h14" />
          <path d="M9 15l3-4 3 2 4-6" />
        </svg>
      </button>

      {/* Text tool */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <Type className="h-4 w-4" />
      </button>

      {/* Shapes tool */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <rect x="5" y="5" width="14" height="14" rx="1" />
        </svg>
      </button>

      {/* Eraser / Pattern tool */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M4 18L14 8l6 6-10 10H4v-6z" />
        </svg>
      </button>

      {/* Magnet mode */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <Magnet className="h-4 w-4" />
      </button>

      {/* Zoom in */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <ZoomIn className="h-4 w-4" />
      </button>

      {/* Lock */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <Lock className="h-4 w-4" />
      </button>

      {/* Brush */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <Paintbrush className="h-4 w-4" />
      </button>

      {/* Ruler/measure */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <Ruler className="h-4 w-4" />
      </button>

      {/* Eye/visibility */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <Eye className="h-4 w-4" />
      </button>

      {/* Trash */}
      <button className="mt-auto flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
