import { Menu } from 'lucide-react';

interface HeaderProps {
  connected: boolean;
  reconnecting: boolean;
  symbol: string;
  sessionActive: boolean;
  lightMode: boolean;
  onEndSession?: () => void;
}

export function Header({ connected, reconnecting, symbol, sessionActive, lightMode, onEndSession }: HeaderProps) {
  const dotColor = connected
    ? 'bg-[#2e9461]'
    : reconnecting
    ? 'bg-yellow-500'
    : 'bg-[#ef5350]';

  return (
    <header className={`flex h-11 items-center justify-between border-b px-4 ${lightMode ? 'bg-white border-gray-200' : 'bg-[#121416] border-[#2a2e39]'}`}>
      <div className="flex items-center gap-4">
        <button className={`${lightMode ? 'text-gray-500 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]'}`}>
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center">
          <span className="text-base font-bold tracking-wide text-[#3b6fff]">Open</span>
          <span className={`text-base font-bold tracking-wide ${lightMode ? 'text-gray-900' : 'text-white'}`}>Rewind</span>
        </div>
        {sessionActive && symbol && (
          <>
            <div className={`w-px h-5 ${lightMode ? 'bg-gray-200' : 'bg-[#2a2e39]'}`} />
            <span className={`text-sm font-medium ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>{symbol}</span>
          </>
        )}
      </div>

      {/* Subtle connection status dot — top-right */}
      <div className="flex items-center gap-3">
        {sessionActive && onEndSession && (
          <button
            type="button"
            onClick={onEndSession}
            className={`text-[11px] font-semibold transition-colors ${
              lightMode ? 'text-red-600 hover:text-red-700' : 'text-[#ef5350] hover:text-red-400'
            }`}
          >
            End Session
          </button>
        )}
        <div
          title={connected ? 'Connected' : reconnecting ? 'Reconnecting' : 'Disconnected'}
          className={`h-2.5 w-2.5 rounded-full ${dotColor} ${connected || reconnecting ? 'animate-pulse' : ''} ${
            lightMode ? 'ring-2 ring-white' : 'ring-2 ring-[#121416]'
          }`}
        />
      </div>
    </header>
  );
}
