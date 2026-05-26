"use client";

import { Menu, Sun, Maximize2, ChevronDown } from "lucide-react";

export function Header() {
  return (
    <header className="flex h-11 items-center justify-between border-b border-[#2a2e39] bg-[#121416] px-4">
      <div className="flex items-center gap-4">
        <button className="text-[#787b86] hover:text-[#d1d4dc]">
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center">
          <span className="text-base font-bold tracking-wide text-[#00c896]">FX</span>
          <span className="text-base font-bold tracking-wide text-white">REPLAY</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <button className="flex items-center gap-2 rounded-full border border-[#363a45] bg-transparent px-4 py-1.5 text-xs text-[#787b86] transition-colors hover:border-[#50535e] hover:text-[#d1d4dc]">
          Switch to Old Version
        </button>
        <button className="flex items-center gap-1.5 rounded-full border border-[#363a45] bg-transparent px-3 py-1.5 text-xs text-[#787b86] transition-colors hover:border-[#50535e] hover:text-[#d1d4dc]">
          EN
          <ChevronDown className="h-3 w-3" />
        </button>
        <button className="text-[#787b86] hover:text-[#d1d4dc]">
          <Sun className="h-5 w-5" />
        </button>
        <button className="text-[#787b86] hover:text-[#d1d4dc]">
          <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />
          </svg>
        </button>
      </div>
    </header>
  );
}
