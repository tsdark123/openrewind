import { useEffect, useState } from 'react';
import { ArrowLeft, HardDrive, Upload } from 'lucide-react';
import { useDataSource, isTauri, getEngineDataDir } from '../lib/dataSourceContext';
import { listLocalTickers, type LocalTicker } from '../lib/localData';
import { ImportCsvWizard } from './ImportCsvWizard';

interface LocalDataScreenProps {
  onBack: () => void;
  onEnterWorkspace: (symbol: string, date: string) => void;
  lightMode?: boolean;
}

export function LocalDataScreen({ onBack, onEnterWorkspace, lightMode = false }: LocalDataScreenProps) {
  const { dataSource, isResolving } = useDataSource();
  const dataDir = getEngineDataDir(dataSource);

  const [tickers, setTickers] = useState<LocalTicker[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [importOpen, setImportOpen] = useState(false);

  const loadTickers = () => {
    if (!dataDir || !isTauri()) return;
    setLoading(true);
    listLocalTickers()
      .then((res) => {
        setTickers(res);
        if (res.length) setSelected(res[0].symbol);
      })
      .catch((err: unknown) => {
        console.warn('[LocalData] Failed to list local tickers:', err);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    loadTickers();
  }, [dataDir]);

  const handleEnter = () => {
    const ticker = tickers.find((t) => t.symbol === selected);
    if (!ticker) return;
    const date = ticker.lastTimestamp ? ticker.lastTimestamp.slice(0, 10) : '';
    onEnterWorkspace(ticker.symbol, date);
  };

  const isDesktop = isTauri() && !!dataDir;

  return (
    <div
      className={`fixed inset-0 z-[80] flex flex-col ${lightMode ? 'bg-white' : 'bg-[#121416]'}`}
      aria-label="Local data"
    >
      <div className="flex items-center justify-between border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <HardDrive className={`h-5 w-5 ${lightMode ? 'text-[#3b6fff]' : 'text-[#3b6fff]'}`} />
          <h1 className={`text-lg font-semibold ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>
            Local Data
          </h1>
        </div>
        <button
          onClick={onBack}
          className={`flex items-center gap-2 text-sm ${
            lightMode ? 'text-gray-600 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]'
          }`}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-6">
        {!isDesktop ? (
          <div className="max-w-md text-center">
            <HardDrive className={`mx-auto mb-4 h-12 w-12 ${lightMode ? 'text-gray-300' : 'text-[#4a4d55]'}`} />
            <h2 className={`mb-2 text-lg font-medium ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>
              Local file importing is currently available in the OpenRewind desktop app.
            </h2>
            <p className={`text-sm ${lightMode ? 'text-gray-500' : 'text-[#787b86]'}`}>
              In the desktop build, you can import one-minute CSV files and replay them here.
            </p>
          </div>
        ) : (
          <div className="w-full max-w-2xl">
            <p className={`mb-4 text-xs ${lightMode ? 'text-gray-400' : 'text-[#787b86]'}`}>
              Local data directory: {dataDir}
            </p>

            {error && (
              <div className="mb-4 rounded border border-red-900/30 bg-red-900/10 px-4 py-2 text-sm text-red-400">
                {error}
              </div>
            )}

            {loading ? (
              <p className={lightMode ? 'text-gray-500' : 'text-[#787b86]'}>Loading local symbols…</p>
            ) : tickers.length === 0 ? (
              <p className={lightMode ? 'text-gray-500' : 'text-[#787b86]'}>
                No local symbols imported yet. Use Import CSV to add one.
              </p>
            ) : (
              <div className="space-y-2">
                {tickers.map((t) => (
                  <button
                    key={t.symbol}
                    onClick={() => setSelected(t.symbol)}
                    className={`w-full rounded border p-4 text-left transition-colors ${
                      selected === t.symbol
                        ? 'border-[#ff3700] bg-[#ff3700]/10'
                        : lightMode
                          ? 'border-gray-200 bg-white hover:bg-gray-50'
                          : 'border-[#2a2d35] bg-[#1a1c21] hover:bg-[#1f2127]'
                    }`}
                  >
                    <div className={`font-medium ${lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}`}>
                      {t.symbol}
                    </div>
                    <div className={`text-xs ${lightMode ? 'text-gray-500' : 'text-[#787b86]'}`}>
                      {t.firstTimestamp?.slice(0, 10)} → {t.lastTimestamp?.slice(0, 10)}
                      {t.rowCount !== undefined && ` • ${t.rowCount.toLocaleString()} rows`}
                    </div>
                  </button>
                ))}
              </div>
            )}

            <div className="mt-6 flex gap-3">
              <button
                onClick={onBack}
                className={`rounded px-4 py-2 text-sm font-medium ${
                  lightMode
                    ? 'border border-gray-200 bg-white text-gray-900 hover:bg-gray-50'
                    : 'border border-[#2a2d35] bg-[#1a1c21] text-[#d1d4dc] hover:bg-[#1f2127]'
                }`}
              >
                Back
              </button>
              <button
                onClick={() => setImportOpen(true)}
                className={`flex items-center gap-2 rounded px-4 py-2 text-sm font-medium ${
                  lightMode
                    ? 'border border-gray-200 bg-white text-gray-900 hover:bg-gray-50'
                    : 'border border-[#2a2d35] bg-[#1a1c21] text-[#d1d4dc] hover:bg-[#1f2127]'
                }`}
              >
                <Upload className="h-4 w-4" />
                Import CSV
              </button>
              <button
                onClick={handleEnter}
                disabled={!selected}
                className="rounded bg-[#ff3700] px-4 py-2 text-sm font-medium text-white hover:bg-[#ff5420] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Continue to Workspace
              </button>
            </div>
          </div>
        )}
      </div>

      {isResolving && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
          <p className="text-sm text-white">Resolving local data…</p>
        </div>
      )}

      <ImportCsvWizard
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={() => {
          setImportOpen(false);
          loadTickers();
        }}
        existingSymbols={tickers.map((t) => t.symbol)}
        lightMode={lightMode}
      />
    </div>
  );
}
