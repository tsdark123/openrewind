import { Database, HardDrive } from 'lucide-react';

interface DataSourceMenuProps {
  onManaged: () => void;
  onLocal: () => void;
  isResolving?: boolean;
  lightMode?: boolean;
}

export function DataSourceMenu({ onManaged, onLocal, isResolving, lightMode = false }: DataSourceMenuProps) {
  const cardBase = `flex-1 cursor-pointer rounded-lg border p-8 transition-all duration-200`;
  const cardDark = `border-[#2a2d35] bg-[#1a1c21] hover:border-[#ff3700] hover:bg-[#1f2127]`;
  const cardLight = `border-gray-200 bg-white hover:border-[#ff3700] hover:bg-gray-50`;
  const textDark = `text-[#d1d4dc]`;
  const textLight = `text-gray-900`;

  return (
    <div
      className={`fixed inset-0 z-[90] flex flex-col items-center justify-center ${
        lightMode ? 'bg-white' : 'bg-[#0a0a0a]'
      }`}
      aria-label="Choose data source"
    >
      <h1 className={`mb-2 text-2xl font-semibold ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>
        Choose your data source
      </h1>
      <p className={`mb-10 text-sm ${lightMode ? 'text-gray-500' : 'text-[#787b86]'}`}>
        You can switch this later by restarting the app.
      </p>

      <div className="flex w-full max-w-2xl gap-6 px-6">
        <button
          onClick={onManaged}
          disabled={isResolving}
          className={`${cardBase} ${lightMode ? cardLight : cardDark} text-left`}
        >
          <Database className={`mb-4 h-8 w-8 ${lightMode ? 'text-[#ff3700]' : 'text-[#ff3700]'}`} />
          <h2 className={`mb-2 text-lg font-medium ${lightMode ? textLight : textDark}`}>
            OpenRewind Data
          </h2>
          <p className={`text-sm ${lightMode ? 'text-gray-500' : 'text-[#787b86]'}`}>
            Use the managed yfinance market data library. Syncs automatically on startup.
          </p>
        </button>

        <button
          onClick={onLocal}
          disabled={isResolving}
          className={`${cardBase} ${lightMode ? cardLight : cardDark} text-left`}
        >
          <HardDrive className={`mb-4 h-8 w-8 ${lightMode ? 'text-[#3b6fff]' : 'text-[#3b6fff]'}`} />
          <h2 className={`mb-2 text-lg font-medium ${lightMode ? textLight : textDark}`}>Local Data</h2>
          <p className={`text-sm ${lightMode ? 'text-gray-500' : 'text-[#787b86]'}`}>
            Import your own one-minute CSV files and replay them in the desktop app.
          </p>
        </button>
      </div>

      {isResolving && (
        <p className={`mt-8 text-sm ${lightMode ? 'text-gray-500' : 'text-[#787b86]'}`}>
          Resolving local data directory…
        </p>
      )}
    </div>
  );
}
