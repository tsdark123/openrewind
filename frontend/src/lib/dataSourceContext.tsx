import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export interface DataSource {
  mode: 'managed' | 'local';
  dataDir?: string;
  label: string;
}

export function getEngineDataDir(dataSource: DataSource | null | undefined): string | undefined {
  if (dataSource?.mode === 'local' && dataSource.dataDir) {
    return dataSource.dataDir;
  }
  return undefined;
}

export const MANAGED_DATA_SOURCE: DataSource = {
  mode: 'managed',
  label: 'OpenRewind Data',
};

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

function invokeTauri<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const tauri = (window as any).__TAURI_INTERNALS__;
  if (!tauri?.invoke) {
    return Promise.reject(new Error('Tauri is not available'));
  }
  return tauri.invoke(cmd, args) as Promise<T>;
}

interface DataSourceContextValue {
  dataSource: DataSource | null;
  isResolving: boolean;
  selectManaged: () => void;
  selectLocal: () => Promise<void>;
  clear: () => void;
}

const DataSourceContext = createContext<DataSourceContextValue | null>(null);

export function DataSourceProvider({ children }: { children: React.ReactNode }) {
  const [dataSource, setDataSource] = useState<DataSource | null>(null);
  const [isResolving, setIsResolving] = useState(false);

  const selectManaged = useCallback(() => {
    setDataSource(MANAGED_DATA_SOURCE);
  }, []);

  const selectLocal = useCallback(async () => {
    if (!isTauri()) {
      // Browser dev cannot resolve a real local directory. Consumers should
      // show a desktop-only message instead of calling this.
      setDataSource({ mode: 'local', label: 'Local Data' });
      return;
    }
    setIsResolving(true);
    try {
      const dataDir = await invokeTauri<string>('get_local_data_dir');
      setDataSource({ mode: 'local', dataDir, label: 'Local Data' });
    } finally {
      setIsResolving(false);
    }
  }, []);

  const clear = useCallback(() => {
    setDataSource(null);
  }, []);

  const value = useMemo<DataSourceContextValue>(
    () => ({
      dataSource,
      isResolving,
      selectManaged,
      selectLocal,
      clear,
    }),
    [dataSource, isResolving, selectManaged, selectLocal, clear]
  );

  return <DataSourceContext.Provider value={value}>{children}</DataSourceContext.Provider>;
}

export function useDataSource(): DataSourceContextValue {
  const ctx = useContext(DataSourceContext);
  if (!ctx) {
    throw new Error('useDataSource must be used inside a DataSourceProvider');
  }
  return ctx;
}
