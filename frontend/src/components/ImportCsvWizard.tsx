import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowLeft, FileSpreadsheet, Loader2, Upload, X } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { inspectLocalCsv, importLocalCsv, type CsvInspection, type LocalTicker } from '../lib/localData';

interface ImportCsvWizardProps {
  isOpen: boolean;
  onClose: () => void;
  onImported: (ticker: LocalTicker) => void;
  existingSymbols: string[];
  lightMode?: boolean;
}

type WizardStep = 'select' | 'preview' | 'done' | 'error';

export function ImportCsvWizard({
  isOpen,
  onClose,
  onImported,
  existingSymbols,
  lightMode = false,
}: ImportCsvWizardProps) {
  const [step, setStep] = useState<WizardStep>('select');
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [inspection, setInspection] = useState<CsvInspection | null>(null);
  const [symbol, setSymbol] = useState('');
  const [replace, setReplace] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadyExists = useMemo(
    () => existingSymbols.includes(symbol.toUpperCase()),
    [existingSymbols, symbol]
  );

  useEffect(() => {
    if (!isOpen) {
      setStep('select');
      setSourcePath(null);
      setInspection(null);
      setSymbol('');
      setReplace(false);
      setConfirmed(false);
      setImporting(false);
      setError(null);
    }
  }, [isOpen]);

  const handleSelectFile = async () => {
    setError(null);
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'CSV', extensions: ['csv'] }],
        title: 'Import one-minute candles CSV',
      });
      if (!selected || Array.isArray(selected)) return;
      setSourcePath(selected);

      const result = await inspectLocalCsv(selected);
      setInspection(result);
      setSymbol(result.symbolCandidate);
      setStep('preview');
    } catch (e) {
      setStep('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleImport = async () => {
    if (!sourcePath || !inspection) return;
    if (!symbol.trim()) return;
    setImporting(true);
    setError(null);
    try {
      const ticker = await importLocalCsv({
        sourcePath,
        symbol: symbol.trim().toUpperCase(),
        mapping: inspection.mapping,
        replace,
        confirmed,
      });
      setStep('done');
      onImported(ticker);
    } catch (e) {
      setStep('error');
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  const canImport =
    !!inspection &&
    !!symbol.trim() &&
    inspection.canImport &&
    (!inspection.ambiguous || confirmed) &&
    (!alreadyExists || replace);

  const textDark = 'text-[#d1d4dc]';
  const textLight = 'text-gray-900';
  const mutedDark = 'text-[#787b86]';
  const mutedLight = 'text-gray-500';

  if (!isOpen) return null;

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center ${
        lightMode ? 'bg-black/30' : 'bg-black/60'
      }`}
      onClick={onClose}
    >
      <div
        className={`w-full max-w-2xl rounded-lg border p-6 shadow-2xl ${
          lightMode
            ? 'border-gray-200 bg-white'
            : 'border-[#2a2d35] bg-[#1a1c21]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className={`text-lg font-semibold ${lightMode ? textLight : textDark}`}>
            Import Local CSV
          </h2>
          <button
            onClick={onClose}
            className={lightMode ? 'text-gray-500 hover:text-gray-900' : 'text-[#787b86] hover:text-[#d1d4dc]'}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {step === 'select' && (
          <div className="space-y-4">
            <p className={lightMode ? mutedLight : mutedDark}>
              Choose a CSV file with one-minute candles. OpenRewind expects:
              <code className={`mx-1 rounded px-1 ${lightMode ? 'bg-gray-100' : 'bg-[#2a2d35]'}`}>
                timestamp,open,high,low,close,volume
              </code>
              with timestamps in{' '}
              <code className={`rounded px-1 ${lightMode ? 'bg-gray-100' : 'bg-[#2a2d35]'}`}>
                YYYY-MM-DD HH:MM:SS
              </code>
              .
            </p>
            {error && (
              <div className="rounded border border-red-900/30 bg-red-900/10 px-3 py-2 text-sm text-red-400">
                {error}
              </div>
            )}
            <button
              onClick={handleSelectFile}
              className="flex w-full items-center justify-center gap-2 rounded border border-dashed p-6 transition-colors hover:border-[#ff3700] hover:text-[#ff3700]"
            >
              <FileSpreadsheet className="h-5 w-5" />
              <span>Select CSV file</span>
            </button>
          </div>
        )}

        {step === 'preview' && inspection && (
          <div className="space-y-4">
            <div className={`grid grid-cols-2 gap-4 text-sm ${lightMode ? mutedLight : mutedDark}`}>
              <div>
                <span className="font-medium">Detected interval:</span>{' '}
                {inspection.intervalSeconds}s (confidence {Math.round(inspection.confidence * 100)}%)
              </div>
              <div>
                <span className="font-medium">Rows:</span> {inspection.rowCount.toLocaleString()}
              </div>
              {inspection.firstTimestamp && (
                <div>
                  <span className="font-medium">First:</span> {inspection.firstTimestamp}
                </div>
              )}
              {inspection.lastTimestamp && (
                <div>
                  <span className="font-medium">Last:</span> {inspection.lastTimestamp}
                </div>
              )}
            </div>

            {inspection.ambiguous && (
              <div className="rounded border border-amber-900/30 bg-amber-900/10 px-3 py-2 text-sm text-amber-400">
                <AlertCircle className="mr-1 inline h-4 w-4" />
                The interval is ambiguous. Confirm that this is truly one-minute data before importing.
                <label className="mt-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    onChange={(e) => setConfirmed(e.target.checked)}
                    className="h-4 w-4 rounded"
                  />
                  <span>This is one-minute data</span>
                </label>
              </div>
            )}

            {!inspection.canImport && (
              <div className="rounded border border-red-900/30 bg-red-900/10 px-3 py-2 text-sm text-red-400">
                This CSV does not appear to be one-minute data. V1 only supports 1-minute candles.
              </div>
            )}

            <div>
              <label className={`mb-1 block text-sm ${lightMode ? mutedLight : mutedDark}`}>
                Symbol
              </label>
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                className={`w-full rounded border px-3 py-2 text-sm ${
                  lightMode
                    ? 'border-gray-200 bg-white text-gray-900'
                    : 'border-[#2a2d35] bg-[#121416] text-[#d1d4dc]'
                }`}
                placeholder="AAPL"
              />
              {alreadyExists && (
                <label className="mt-2 flex items-center gap-2 text-sm text-amber-400">
                  <input
                    type="checkbox"
                    checked={replace}
                    onChange={(e) => setReplace(e.target.checked)}
                    className="h-4 w-4 rounded"
                  />
                  Replace existing {symbol} local data
                </label>
              )}
            </div>

            <div className={`max-h-48 overflow-auto rounded border text-xs ${lightMode ? 'border-gray-200' : 'border-[#2a2d35]'}`}>
              <table className="w-full">
                <thead className={lightMode ? 'bg-gray-50' : 'bg-[#2a2d35]'}>
                  <tr>
                    {inspection.headers.slice(0, 6).map((h) => (
                      <th key={h} className="px-2 py-1 text-left">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {inspection.preview.slice(0, 5).map((row, i) => (
                    <tr key={i}>
                      {row.slice(0, 6).map((cell, j) => (
                        <td key={j} className="px-2 py-1">
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep('select')}
                disabled={importing}
                className={`flex items-center gap-2 rounded px-4 py-2 text-sm font-medium ${
                  lightMode
                    ? 'border border-gray-200 bg-white text-gray-900 hover:bg-gray-50'
                    : 'border border-[#2a2d35] bg-[#1a1c21] text-[#d1d4dc] hover:bg-[#1f2127]'
                }`}
              >
                <ArrowLeft className="h-4 w-4" />
                Back
              </button>
              <button
                onClick={handleImport}
                disabled={!canImport || importing}
                className="flex flex-1 items-center justify-center gap-2 rounded bg-[#ff3700] px-4 py-2 text-sm font-medium text-white hover:bg-[#ff5420] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                Import {symbol}
              </button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-4 text-center">
            <p className={lightMode ? textLight : textDark}>
              <strong>{symbol}</strong> was imported successfully.
            </p>
            <button
              onClick={onClose}
              className="rounded bg-[#ff3700] px-4 py-2 text-sm font-medium text-white hover:bg-[#ff5420]"
            >
              Done
            </button>
          </div>
        )}

        {step === 'error' && (
          <div className="space-y-4">
            <div className="rounded border border-red-900/30 bg-red-900/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
            <button
              onClick={() => setStep('select')}
              className="rounded border border-[#2a2d35] bg-[#1a1c21] px-4 py-2 text-sm text-[#d1d4dc]"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
