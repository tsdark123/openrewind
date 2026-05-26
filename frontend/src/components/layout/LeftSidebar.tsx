import { Home, User, Settings, Lock, Trash2, Unlock } from 'lucide-react';

type ActiveTool = 'NONE' | 'FIB' | 'RECTANGLE' | 'TEXT' | 'BRUSH' | 'LINE';

interface LeftSidebarProps {
  drawingManager: any;
  activeTool: ActiveTool;
  onActiveToolChange: (tool: ActiveTool) => void;
  chartLocked: boolean;
  onChartLockedChange: (locked: boolean) => void;
  lightMode: boolean;
}

export function LeftSidebar({ drawingManager, activeTool, onActiveToolChange, chartLocked, onChartLockedChange, lightMode }: LeftSidebarProps) {
  const handleToolClick = (tool: ActiveTool) => {
    if (activeTool === tool) {
      onActiveToolChange('NONE'); // Toggle off
      // Auto-unlock chart when deselecting tool
      if (chartLocked) {
        onChartLockedChange(false);
      }
    } else {
      onActiveToolChange(tool);
      // Auto-lock chart when selecting a tool
      if (!chartLocked) {
        onChartLockedChange(true);
      }
    }
  };

  const handleClearAll = () => {
    if (drawingManager) {
      // Clear all drawings by removing them from the manager
      // Note: The library doesn't expose a clearAll method, so we'd need to track IDs
      console.log('Clear all drawings - not implemented yet');
    }
  };

  return (
    <div className={`flex h-full w-10 flex-col items-center border-r py-2 ${lightMode ? 'bg-white border-gray-200' : 'bg-[#121416] border-[#2a2e39]'}`}>
      {/* User avatar */}
      <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-blue-400 to-blue-600">
        <span className="text-xs font-medium text-white">U</span>
      </div>

      {/* Navigation icons */}
      <div className="flex flex-col items-center gap-0.5 mb-2">
        <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
          <Home className="h-4 w-4" />
        </button>
        <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
          <User className="h-4 w-4" />
        </button>
      </div>

      {/* Divider */}
      <div className="w-6 h-px bg-[#2a2e39] my-1" />

      {/* Drawing tools */}
      <div className="flex flex-col items-center gap-0.5">
        {/* Trend line tool */}
        <button
          className={`flex h-7 w-7 items-center justify-center rounded ${
            activeTool === 'LINE'
              ? 'bg-[#2962ff] text-white'
              : 'text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]'
          }`}
          onClick={() => handleToolClick('LINE')}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <line x1="5" y1="19" x2="19" y2="5" />
          </svg>
        </button>

        {/* Fibonacci tool */}
        <button
          className={`flex h-7 w-7 items-center justify-center rounded ${
            activeTool === 'FIB'
              ? 'bg-[#2962ff] text-white'
              : 'text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]'
          }`}
          onClick={() => handleToolClick('FIB')}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M5 5v14h14" />
            <path d="M9 15l3-4 3 2 4-6" />
          </svg>
        </button>

        {/* Rectangle tool */}
        <button
          className={`flex h-7 w-7 items-center justify-center rounded ${
            activeTool === 'RECTANGLE'
              ? 'bg-[#2962ff] text-white'
              : 'text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]'
          }`}
          onClick={() => handleToolClick('RECTANGLE')}
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="5" y="5" width="14" height="14" rx="1" />
          </svg>
        </button>

        {/* Lock */}
        <button
          className={`flex h-7 w-7 items-center justify-center rounded ${
            chartLocked
              ? 'bg-[#2962ff] text-white'
              : 'text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]'
          }`}
          onClick={() => onChartLockedChange(!chartLocked)}
        >
          {chartLocked ? <Unlock className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
        </button>
      </div>

      {/* Bottom icons */}
      <div className="mt-auto flex flex-col items-center gap-0.5">
        <button
          className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]"
          onClick={handleClearAll}
        >
          <Trash2 className="h-4 w-4" />
        </button>
        <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
