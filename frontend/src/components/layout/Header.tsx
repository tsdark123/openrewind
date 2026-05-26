import { Wifi, WifiOff, Loader2, Menu } from 'lucide-react';

interface HeaderProps {
  connected: boolean;
  reconnecting: boolean;
  symbol: string;
  sessionActive: boolean;
  lightMode: boolean;
}

export function Header({ connected, reconnecting, symbol, sessionActive, lightMode }: HeaderProps) {
  return (
    <header className={`flex h-11 items-center justify-between border-b px-4 ${lightMode ? 'bg-white border-gray-200' : 'bg-[#121416] border-[#2a2e39]'}`}>
      <div className="flex items-center gap-4">
        <button className="text-[#787b86] hover:text-[#d1d4dc]">
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center">
          <span className="text-base font-bold tracking-wide text-[#2962ff]">Open</span>
          <span className={`text-base font-bold tracking-wide ${lightMode ? 'text-gray-900' : 'text-white'}`}>Replay</span>
        </div>
        {sessionActive && symbol && (
          <>
            <div className={`w-px h-5 ${lightMode ? 'bg-gray-200' : 'bg-[#2a2e39]'}`} />
            <span className={`text-sm font-medium ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>{symbol}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-3">
        {/* Connection status */}
        {connected ? (
          <div className="flex items-center gap-1.5 rounded-full border border-[#363a45] px-3 py-1 text-[11px] text-[#2e9461]">
            <Wifi className="h-3 w-3" />
            <span>Connected</span>
          </div>
        ) : reconnecting ? (
          <div className="flex items-center gap-1.5 rounded-full border border-[#363a45] px-3 py-1 text-[11px] text-yellow-500">
            <Loader2 className="h-3 w-3 animate-spin" />
            <span>Reconnecting...</span>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 rounded-full border border-[#363a45] px-3 py-1 text-[11px] text-[#ef5350]">
            <WifiOff className="h-3 w-3" />
            <span>Disconnected</span>
          </div>
        )}
      </div>
    </header>
  );
}
