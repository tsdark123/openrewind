"use client";

import {
  ArrowLeft,
  BookOpen,
  BarChart3,
  Camera,
  Calendar,
  Eye,
  ChevronUp,
  ChevronDown,
  Search,
  Plus,
  Settings,
  RotateCcw,
} from "lucide-react";

export function Toolbar() {
  return (
    <div className="flex flex-col border-b border-[#2a2e39] bg-[#121416]">
      {/* Top toolbar row */}
      <div className="flex h-10 items-center justify-between px-3">
        <div className="flex items-center gap-2">
          {/* Go back button */}
          <button className="flex items-center gap-1.5 rounded-full border border-[#363a45] px-3 py-1 text-[11px] text-[#787b86] transition-colors hover:border-[#50535e] hover:text-[#d1d4dc]">
            <ArrowLeft className="h-3 w-3" />
            Go back
          </button>

          {/* Journal button */}
          <button className="flex items-center gap-1.5 rounded-full border border-[#363a45] px-3 py-1 text-[11px] text-[#787b86] transition-colors hover:border-[#50535e] hover:text-[#d1d4dc]">
            <BookOpen className="h-3 w-3" />
            Journal
          </button>

          {/* Analytics button */}
          <button className="flex items-center gap-1.5 rounded-full border border-[#363a45] px-3 py-1 text-[11px] text-[#787b86] transition-colors hover:border-[#50535e] hover:text-[#d1d4dc]">
            <BarChart3 className="h-3 w-3" />
            Analytics
          </button>

          {/* Place order button */}
          <button className="flex items-center gap-1.5 rounded-full border border-[#363a45] px-3 py-1 text-[11px] text-[#787b86] transition-colors hover:border-[#50535e] hover:text-[#d1d4dc]">
            Place order
          </button>

          {/* Camera button */}
          <button className="flex h-6 w-6 items-center justify-center rounded-full bg-[#2962ff] text-white hover:bg-[#2962ff]/90">
            <Camera className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Go to button */}
          <button className="flex items-center gap-1.5 rounded-full border border-[#363a45] px-3 py-1 text-[11px] text-[#787b86] transition-colors hover:border-[#50535e] hover:text-[#d1d4dc]">
            <RotateCcw className="h-3 w-3" />
            Go to
          </button>

          {/* Economic Calendar */}
          <button className="flex items-center gap-1.5 rounded-full border border-[#363a45] px-3 py-1 text-[11px] text-[#787b86] transition-colors hover:border-[#50535e] hover:text-[#d1d4dc]">
            <Calendar className="h-3 w-3" />
            Economic Calendar
          </button>

          {/* Show events */}
          <button className="flex items-center gap-1.5 rounded-full border border-[#363a45] px-3 py-1 text-[11px] text-[#787b86] transition-colors hover:border-[#50535e] hover:text-[#d1d4dc]">
            <Eye className="h-3 w-3" />
            Show events
          </button>

          {/* Hide top bar */}
          <button className="flex items-center gap-1.5 rounded-full border border-[#363a45] px-3 py-1 text-[11px] text-[#787b86] transition-colors hover:border-[#50535e] hover:text-[#d1d4dc]">
            <ChevronUp className="h-3 w-3" />
            Hide top bar
          </button>
        </div>
      </div>

      {/* Second toolbar row */}
      <div className="flex h-9 items-center justify-between border-t border-[#2a2e39] px-3">
        <div className="flex items-center gap-3">
          {/* Symbol search */}
          <button className="flex items-center gap-1.5 text-[13px] text-[#787b86] hover:text-[#d1d4dc]">
            <Search className="h-4 w-4" />
            <span className="font-medium text-[#d1d4dc]">EURUSD</span>
            <span className="flex h-4 w-4 items-center justify-center rounded-full border border-[#363a45] text-[10px]">
              <Plus className="h-2.5 w-2.5" />
            </span>
          </button>

          {/* Timeframe */}
          <button className="flex items-center gap-1 rounded border border-[#363a45] px-2 py-0.5 text-[11px] text-[#787b86] hover:text-[#d1d4dc]">
            1h
          </button>

          {/* Chart type icon - candlestick */}
          <button className="text-[#787b86] hover:text-[#d1d4dc]">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
              <rect x="5" y="4" width="2" height="16" />
              <rect x="11" y="8" width="2" height="12" />
              <rect x="17" y="2" width="2" height="18" />
            </svg>
          </button>

          {/* Indicators */}
          <button className="flex items-center gap-1.5 text-[11px] text-[#787b86] hover:text-[#d1d4dc]">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M3 3v18h18" />
              <path d="M7 14l4-4 4 4 5-5" />
            </svg>
            Indicators
          </button>

          {/* Template */}
          <button className="flex items-center gap-1 text-[11px] text-[#787b86] hover:text-[#d1d4dc]">
            Tue
          </button>

          {/* Undo */}
          <button className="text-[#787b86] hover:text-[#d1d4dc]">
            <RotateCcw className="h-4 w-4" />
          </button>
        </div>

        <div className="flex items-center gap-3">
          {/* Save */}
          <button className="flex items-center gap-1.5 text-[11px] text-[#787b86] hover:text-[#d1d4dc]">
            <div className="h-3 w-3 rounded-sm border border-[#787b86]" />
            Save
            <ChevronDown className="h-3 w-3" />
          </button>

          {/* Settings gear */}
          <button className="text-[#787b86] hover:text-[#d1d4dc]">
            <Settings className="h-4 w-4" />
          </button>

          {/* Second settings icon */}
          <button className="text-[#787b86] hover:text-[#d1d4dc]">
            <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <circle cx="12" cy="12" r="3" />
              <path d="M12 1v4M12 19v4M4.22 4.22l2.83 2.83M16.95 16.95l2.83 2.83M1 12h4M19 12h4M4.22 19.78l2.83-2.83M16.95 7.05l2.83-2.83" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
