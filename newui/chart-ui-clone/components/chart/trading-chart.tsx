"use client";

import { Header } from "./header";
import { LeftSidebar } from "./left-sidebar";
import { Toolbar } from "./toolbar";
import { DrawingToolbar } from "./drawing-toolbar";
import { ChartArea } from "./chart-area";
import { BottomPanel } from "./bottom-panel";

export function TradingChart() {
  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#121416]">
      {/* Top header */}
      <Header />

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar with icons */}
        <LeftSidebar />

        {/* Main chart section */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Toolbar */}
          <Toolbar />

          {/* Chart area with drawing tools */}
          <div className="flex flex-1 overflow-hidden">
            {/* Drawing tools sidebar */}
            <DrawingToolbar />

            {/* Main chart canvas */}
            <ChartArea />
          </div>

          {/* Bottom trading panel */}
          <BottomPanel />
        </div>
      </div>
    </div>
  );
}
