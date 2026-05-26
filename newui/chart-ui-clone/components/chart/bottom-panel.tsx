"use client";

import { ChevronUp, Maximize2 } from "lucide-react";

export function BottomPanel() {
  return (
    <div className="flex h-9 items-center justify-between border-t border-[#2a2e39] bg-[#121416] px-3">
      <div className="flex items-center gap-2">
        {/* Buy button */}
        <button className="rounded bg-[#26a69a] px-4 py-1 text-xs font-medium text-white hover:bg-[#26a69a]/90">
          Buy
        </button>

        {/* Sell button */}
        <button className="rounded bg-[#ef5350] px-4 py-1 text-xs font-medium text-white hover:bg-[#ef5350]/90">
          Sell
        </button>

        {/* Lots input */}
        <div className="flex items-center gap-2 rounded border border-[#363a45] bg-[#1e222d] px-3 py-1">
          <span className="text-xs text-[#787b86]">Lots (100000 units)</span>
        </div>
      </div>

      <div className="flex items-center gap-5 text-xs">
        {/* Account Balance */}
        <div className="flex items-center gap-1.5">
          <span className="text-[#787b86]">Account Balance:</span>
          <span className="text-[#d1d4dc]">$50,000.00</span>
        </div>

        {/* Realized PnL */}
        <div className="flex items-center gap-1.5">
          <span className="text-[#787b86]">Realized PnL:</span>
          <span className="text-[#d1d4dc]">$0.00</span>
        </div>

        {/* Unrealized PnL */}
        <div className="flex items-center gap-1.5">
          <span className="text-[#787b86]">Unrealized PnL:</span>
          <span className="text-[#d1d4dc]">$0.00</span>
        </div>

        {/* Expand/Collapse buttons */}
        <div className="flex items-center gap-1">
          <button className="text-[#787b86] hover:text-[#d1d4dc]">
            <ChevronUp className="h-4 w-4" />
          </button>
          <button className="text-[#787b86] hover:text-[#d1d4dc]">
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
