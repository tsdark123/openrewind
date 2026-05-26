import { Type, ZoomIn, Lock, Paintbrush, Ruler, Eye, Trash2, Unlock } from 'lucide-react';

type ActiveTool = 'NONE' | 'FIB' | 'RECTANGLE' | 'TEXT' | 'BRUSH' | 'LINE';

interface DrawingToolbarProps {
  drawingManager: any;
  activeTool: ActiveTool;
  onActiveToolChange: (tool: ActiveTool) => void;
  chartLocked: boolean;
  onChartLockedChange: (locked: boolean) => void;
}

export function DrawingToolbar({ drawingManager, activeTool, onActiveToolChange, chartLocked, onChartLockedChange }: DrawingToolbarProps) {
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
    <div className="flex w-10 flex-col items-center gap-0.5 border-r border-[#2a2e39] bg-[#121416] py-2">
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

      {/* Text tool */}
      <button
        className={`flex h-7 w-7 items-center justify-center rounded ${
          activeTool === 'TEXT'
            ? 'bg-[#2962ff] text-white'
            : 'text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]'
        }`}
        onClick={() => handleToolClick('TEXT')}
      >
        <Type className="h-4 w-4" />
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

      {/* Brush tool */}
      <button
        className={`flex h-7 w-7 items-center justify-center rounded ${
          activeTool === 'BRUSH'
            ? 'bg-[#2962ff] text-white'
            : 'text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]'
        }`}
        onClick={() => handleToolClick('BRUSH')}
      >
        <Paintbrush className="h-4 w-4" />
      </button>

      {/* Divider */}
      <div className="w-6 h-px bg-[#2a2e39] my-1" />

      {/* Zoom in */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <ZoomIn className="h-4 w-4" />
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

      {/* Ruler/measure */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <Ruler className="h-4 w-4" />
      </button>

      {/* Eye/visibility */}
      <button className="flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]">
        <Eye className="h-4 w-4" />
      </button>

      {/* Trash */}
      <button
        className="mt-auto flex h-7 w-7 items-center justify-center rounded text-[#787b86] hover:bg-[#2a2e39] hover:text-[#d1d4dc]"
        onClick={handleClearAll}
      >
        <Trash2 className="h-4 w-4" />
      </button>
    </div>
  );
}
