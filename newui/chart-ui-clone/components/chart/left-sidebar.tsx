"use client";

import { Home, User, Type, Trash2, Settings } from "lucide-react";

export function LeftSidebar() {
  return (
    <div className="flex h-full w-12 flex-col items-center border-r border-[#2a2e39] bg-[#121416] py-3">
      {/* User avatar */}
      <div className="mb-3 flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-orange-400 to-orange-600">
        <span className="text-xs font-medium text-white">U</span>
      </div>

      {/* Navigation icons */}
      <div className="flex flex-col items-center gap-0.5">
        <button className="flex h-9 w-9 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
          <Home className="h-[18px] w-[18px]" />
        </button>

        <button className="flex h-9 w-9 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
          <User className="h-[18px] w-[18px]" />
        </button>

        <button className="flex h-9 w-9 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
          <User className="h-[18px] w-[18px]" />
        </button>

        <button className="flex h-9 w-9 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
          <User className="h-[18px] w-[18px]" />
        </button>

        <button className="flex h-9 w-9 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
          <User className="h-[18px] w-[18px]" />
        </button>

        <button className="flex h-9 w-9 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
          <Type className="h-[18px] w-[18px]" />
        </button>

        <button className="flex h-9 w-9 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
          <User className="h-[18px] w-[18px]" />
        </button>
      </div>

      {/* Bottom icons */}
      <div className="mt-auto flex flex-col items-center gap-0.5">
        <button className="flex h-9 w-9 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
          <Trash2 className="h-[18px] w-[18px]" />
        </button>
        <button className="flex h-9 w-9 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
          <User className="h-[18px] w-[18px]" />
        </button>
      </div>
    </div>
  );
}
