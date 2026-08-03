import { useReducer, useCallback, useEffect, useState, useRef } from 'react';
import { Chart, type ChartHandle } from './components/Chart';
import { IntroSplash } from './components/IntroSplash';
import { Header } from './components/layout/Header';
import { TradingToolbar } from './components/drawing/TradingToolbar';
import { Toolbar } from './components/layout/Toolbar';
import { BottomPanel } from './components/layout/BottomPanel';
import { PlaybackControls } from './components/layout/PlaybackControls';
import { OrderPanel } from './components/layout/OrderPanel';
import { TradeHistoryDrawer } from './components/layout/TradeHistoryDrawer';
import { TradingCalendar } from './components/calendar/TradingCalendar';
import { OrionTerminal } from './components/ui/orion-terminal';
import { OrionDrivingOverlay } from './components/ui/OrionDrivingOverlay';
import { useWebSocket } from './hooks/useWebSocket';
import { endSession, loadPerformanceLog } from './lib/journal';
import { orionController } from './lib/orion/controller';
import { fetchCandles } from './lib/orion/tools';
import { warmOrionAgent } from './lib/orion/client';
import { useDataSource, getEngineDataDir } from './lib/dataSourceContext';
import { engineUrl, sessionStartBody } from './lib/engine';
import { threadKeyForContext, appendMessage, loadOrionThreads, writeOrionThreads } from './lib/orionThreads';
import type {
  AppState,
  AppAction,
  CandleData,
  CandleUpdatePayload,
  Side,
  OrdType,
} from './types';
import type { ActiveTool } from './components/drawing/drawingTools';

// =============================================================================
// Constants
// =============================================================================

// In Tauri's webview the Vite proxy is not running, so REST calls must go
// directly to the engine. In browser dev mode an empty base lets Vite proxy
// /api/* → http://localhost:9000.
const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
const API_BASE = isTauri ? 'http://127.0.0.1:9000' : '';


import { DataSourceMenu } from './components/DataSourceMenu';
import { LocalDataScreen } from './components/LocalDataScreen';

// Return the most recent past trading weekday (YYYY-MM-DD). If today is a
// weekday we still step back one calendar day because the local market data
// is only fully available after the previous close.
function getLastTradingDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  while (d.getDay() === 0 || d.getDay() === 6) {
    d.setDate(d.getDate() - 1);
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// =============================================================================
// App State Reducer
// =============================================================================

const initialState: AppState = {
  connected: false,
  sessionActive: false,
  symbol: '',
  replayDate: getLastTradingDate(),

  cursor: 0,
  totalCandles: 0,
  timeframe: 1,
  currentPrice: 0,

  isPlaying: false,
  speed: 1,
  playbackDirection: 'forward',
  orderQuantity: 10,

  indicators: {
    ema20: false,
    sma50: false,
    bollinger: false,
    rsi: false,
    macd: false,
    atr: false,
    stochastic: false,
  },

  balance: 0,
  equity: 0,
  openPositions: [],
  pendingOrders: [],
  tradeHistory: [],

  activeSessionTrades: [],
  performanceLog: {},
};

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_CONNECTED':
      return { ...state, connected: action.connected };

    case 'SESSION_STARTED':
      return {
        ...state,
        sessionActive: true,
        symbol: action.payload.symbol,
        replayDate: action.payload.start_date || state.replayDate,
        totalCandles: action.payload.total_candles,
        cursor: action.payload.start_cursor ?? 0,
        currentPrice: 0,
        isPlaying: false,
        indicators: {
          ema20: false,
          sma50: false,
          bollinger: false,
          rsi: false,
          macd: false,
          atr: false,
          stochastic: false,
        },
        openPositions: [],
        pendingOrders: [],
        tradeHistory: [],
        activeSessionTrades: [],
      };

    case 'SESSION_STOPPED':
      return {
        ...state,
        sessionActive: false,
        isPlaying: false,
      };

    case 'SESSION_STATE': {
      const p = action.payload;
      // Candle history is applied directly to the chart via onSessionHistory.
      return {
        ...state,
        sessionActive: true,
        symbol: p.symbol,
        currentPrice: p.candle ? p.candle.close : state.currentPrice,
        cursor: p.cursor,
        totalCandles: p.total_candles,
        isPlaying: p.is_playing,
        speed: p.speed,
        timeframe: p.timeframe,
        balance: p.account.balance,
        equity: p.account.equity,
        openPositions: p.open_positions,
        pendingOrders: p.pending_orders,
        tradeHistory: p.trade_history,
      };
    }

    case 'CANDLE_UPDATE': {
      const c = action.payload;
      // Candle data is managed imperatively by Chart via onCandleUpdate callback.
      // Only update cursor/total here for the playback counter display.
      return {
        ...state,
        cursor: c.cursor,
        totalCandles: c.total,
        currentPrice: c.close,
      };
    }

    case 'ACCOUNT_SNAPSHOT':
      return {
        ...state,
        balance: action.payload.balance,
        equity: action.payload.equity,
      };

    case 'ORDER_FILLED':
      // Positions will be refreshed via account_snapshot or session_state.
      // For now, just note the event occurred.
      return state;

    case 'POSITION_CLOSED': {
      const closedId = action.payload.position_id;
      const trade = {
        id: action.payload.position_id,
        side: action.payload.side,
        entry_price: action.payload.entry_price,
        exit_price: action.payload.exit_price,
        quantity: action.payload.quantity,
        realized_pnl: action.payload.realized_pnl,
        stop_loss: action.payload.stop_loss,
        take_profit: action.payload.take_profit,
        reason: action.payload.reason,
        opened_at: action.payload.opened_at ?? action.payload.timestamp,
        closed_at: action.payload.timestamp,
        // Preserve the automation flag end-to-end so downstream filters
        // (journal write, calendar aggregation, chart marker style) can
        // distinguish agent-driven fills from user-driven ones.
        is_automated: action.payload.is_automated === true,
      };
      const activeTrade = { ...trade, symbol: state.symbol, date: state.replayDate };
      return {
        ...state,
        openPositions: state.openPositions.filter((p) => p.id !== closedId),
        tradeHistory: [...state.tradeHistory, trade],
        activeSessionTrades: [...state.activeSessionTrades, activeTrade],
      };
    }

    case 'SET_PLAYING':
      return { ...state, isPlaying: action.isPlaying };

    case 'SET_SPEED':
      return { ...state, speed: action.speed };

    case 'SET_DIRECTION':
      return { ...state, playbackDirection: action.playbackDirection };

    case 'SET_QUANTITY':
      return { ...state, orderQuantity: action.orderQuantity };

    case 'SET_TIMEFRAME':
      return { ...state, timeframe: action.timeframe };

    case 'SET_POSITIONS':
      return { ...state, openPositions: action.positions };

    case 'SET_PENDING_ORDERS':
      return { ...state, pendingOrders: action.orders };

    case 'ADD_TRADE':
      return {
        ...state,
        tradeHistory: [...state.tradeHistory, action.trade],
      };

    case 'CLEAR_TRADE_HISTORY':
      return { ...state, tradeHistory: [] };

    case 'TOGGLE_INDICATOR':
      return {
        ...state,
        indicators: {
          ...state.indicators,
          [action.indicator]: !state.indicators[action.indicator],
        },
      };

    case 'SET_REPLAY_DATE':
      return { ...state, replayDate: action.date };

    case 'ADD_ACTIVE_SESSION_TRADE':
      return {
        ...state,
        activeSessionTrades: [...state.activeSessionTrades, action.trade],
      };

    case 'CLEAR_ACTIVE_SESSION_TRADES_FOR_DATE':
      return {
        ...state,
        activeSessionTrades: state.activeSessionTrades.filter(
          (t) => !(t.symbol === action.symbol && t.date === action.date)
        ),
      };

    case 'CLEAR_ACTIVE_SESSION_TRADES':
      return { ...state, activeSessionTrades: [] };

    case 'SET_PERFORMANCE_LOG':
      return { ...state, performanceLog: action.log };

    case 'END_SESSION':
      return {
        ...state,
        sessionActive: false,
        isPlaying: false,
        symbol: '',
        replayDate: '',
        currentPrice: 0,
        cursor: 0,
        totalCandles: 0,
        openPositions: [],
        pendingOrders: [],
        tradeHistory: [],
        activeSessionTrades: [],
      };

    default:
      return state;
  }
}

// =============================================================================
// Helpers
// =============================================================================

// =============================================================================
// Reusable alert banner for date-selection / data-sync errors.
// =============================================================================
function ErrorAlert({ message, onClose, lightMode }: { message: string; onClose: () => void; lightMode: boolean }) {
  return (
    <div className={`px-4 py-2 flex items-center justify-between text-sm border-b ${lightMode ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-[#f59e0b]/10 border-[#f59e0b]/20 text-[#f59e0b]'}`}>
      <span>{message}</span>
      <button
        onClick={onClose}
        className={`ml-4 px-2 py-0.5 rounded text-xs font-medium ${lightMode ? 'hover:bg-amber-100' : 'hover:bg-[#f59e0b]/20'}`}
        aria-label="Dismiss alert"
      >
        Dismiss
      </button>
    </div>
  );
}

// =============================================================================
// App — Main Application Shell
// =============================================================================

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const chartRef = useRef<ChartHandle>(null);

  // Active data source and its engine-facing directory.
  const { dataSource, isResolving: dataSourceResolving, selectManaged, selectLocal } = useDataSource();
  const dataDir = getEngineDataDir(dataSource);

  // dateConfirmed is kept as internal bookkeeping for session lifecycle;
  // playback locking is now driven by isOrionDriving.
  const [, setDateConfirmed] = useState(false);
  const [dateError, setDateError] = useState<string | null>(null);

  // Inline symbol/data error shown under the Toolbar search input instead of the
  // full-width amber banner.
  const [symbolError, setSymbolError] = useState<string | null>(null);
  const clearSymbolError = useCallback(() => setSymbolError(null), []);

  // Calendar / session flow state.
  const [showCalendar, setShowCalendar] = useState(false);
  const [isEndingSession, setIsEndingSession] = useState(false);

  // Orion AI coach side-panel visibility.
  const [isOrionOpen, setIsOrionOpen] = useState(false);

  // Intro / data-source / workspace view controller.
  const [showIntro, setShowIntro] = useState(true);
  const [view, setView] = useState<'intro' | 'menu' | 'local' | 'workspace'>('intro');
  const [dataSynced, setDataSynced] = useState(false);

  const replayDate = state.replayDate;

  const clearDateError = useCallback(() => setDateError(null), []);

  const onCandleUpdate = useCallback((payload: CandleUpdatePayload) => {
    chartRef.current?.updateCandle(payload);
  }, []);

  const onSessionReset = useCallback(() => {
    chartRef.current?.resetChart();
    setSessionHistory([]);
  }, []);

  const onSessionHistory = useCallback((candles: CandleData[]) => {
    const current = sessionHistoryRef.current;
    const sameHistory =
      candles.length === current.length &&
      (candles.length === 0 ||
        candles[candles.length - 1].timestamp === current[current.length - 1].timestamp);
    if (sameHistory) return;

    setSessionHistory(candles);
    chartRef.current?.setHistory(candles);
  }, []);

  const [availableTickers, setAvailableTickers] = useState<string[]>([]);
  const availableTickersRef = useRef<string[]>([]);
  availableTickersRef.current = availableTickers;

  const fetchTickers = useCallback(() => {
    fetch(engineUrl(API_BASE, '/api/tickers', undefined, dataDir))
      .then((r) => r.json())
      .then((d: { tickers?: string[] }) => {
        if (Array.isArray(d.tickers)) setAvailableTickers(d.tickers);
      })
      .catch((err) => {
        console.warn('[OpenRewind] Failed to fetch ticker list:', err);
      });
  }, [dataDir]);

  const onDataSynced = useCallback(() => {
    fetchTickers();
  }, [fetchTickers]);

  const { send, connected, reconnecting } = useWebSocket({
    dispatch,
    onCandleUpdate,
    onSessionReset,
    onSessionHistory,
    onDataSynced,
  });

  // --- Orion Automation Driver wiring ---------------------------------------
  // Keep the current app state accessible to the controller without turning
  // it into a React re-render dependency (the controller runs outside the
  // render tree). A ref that we keep pointed at the latest `state` on every
  // render is the simplest correct pattern.
  const stateRef = useRef<AppState>(state);
  stateRef.current = state;

  // Local mirror of the controller's status/activity so we can re-render
  // when it transitions between idle → planning → driving → finalizing.
  const [orionStatus, setOrionStatus] = useState(orionController.status);
  const [orionActivity, setOrionActivity] = useState(orionController.activity);

  // Bridge binding. Runs once — `orionController.bind` overwrites the
  // previous bridge on every call so if any dependency changes we just
  // re-bind idempotently.
  useEffect(() => {
    orionController.bind({
      getState: () => stateRef.current,
      getChartHandle: () => chartRef.current,
      getAvailableTickers: () => availableTickersRef.current,
      send,
      dispatch,
      apiBase: API_BASE,
      dataDir,
      postChatMessage: async (text: string) => {
        // Append into whichever Orion thread is currently active for the
        // user's context. Loading here keeps the ai-chat sidepanel a
        // pure view — the controller can post messages even when the
        // panel is closed.
        try {
          const threads = await loadOrionThreads();
          const key = threadKeyForContext(
            stateRef.current.symbol,
            stateRef.current.replayDate,
            stateRef.current.sessionActive
          );
          await writeOrionThreads(appendMessage(threads, key, { sender: 'ai', text }));
        } catch (e) {
          console.warn('[Orion] postChatMessage failed:', e);
        }
      },
    });
    const unsub = orionController.subscribe(() => {
      setOrionStatus(orionController.status);
      setOrionActivity(orionController.activity);
    });
    return () => {
      unsub();
    };
    // API_BASE is a module constant; send/dispatch are stable identity.
    // dataDir is recomputed when the active source changes and is safe to rebind.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [send, dataDir]);

  const isOrionDriving = orionStatus === 'driving' || orionStatus === 'finalizing';
  const lastActivityLine = orionActivity[orionActivity.length - 1]?.message;

  // --- Load the performance log on mount. Tickers are fetched once the
  // user enters the workspace so they reflect the active data source.
  useEffect(() => {
    loadPerformanceLog().then((log) => dispatch({ type: 'SET_PERFORMANCE_LOG', log }));

    const bootOllamaAndWarm = async () => {
      // Boot the local Ollama service automatically when running as a Tauri app.
      if (isTauri) {
        const tauri = (window as any).__TAURI_INTERNALS__;
        await tauri?.invoke?.('ensure_ollama_running').catch((err: unknown) => {
          console.warn('[Orion] Could not auto-start Ollama:', err);
        });
      }

      // One-shot planner warm-up. Non-blocking for the UI; agent calls may
      // await it so the first semantic request after launch is snappy. The
      // client deduplicates React StrictMode double mounts and ignores failure.
      warmOrionAgent().catch(() => {});
    };

    bootOllamaAndWarm();
    return () => {}; // no cleanup needed — warmOrionAgent deduplicates by module state
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // run once on mount; onDataSynced and the connected effect handle subsequent refreshes

  // --- Re-fetch tickers whenever we enter the workspace or the data source changes ---
  useEffect(() => {
    if (view === 'workspace') fetchTickers();
  }, [connected, view, fetchTickers]);

  // --- End Session: once all open positions are closed, persist the active
  // session trades to the journal, reset the workspace, and clear the sandbox.
  useEffect(() => {
    if (!isEndingSession) return;
    if (state.openPositions.length > 0) return;

    (async () => {
      try {
        const log = await endSession(state.activeSessionTrades);
        dispatch({ type: 'SET_PERFORMANCE_LOG', log });
        dispatch({ type: 'CLEAR_ACTIVE_SESSION_TRADES' });
      } catch (err) {
        console.error('[OpenRewind] Failed to end session:', err);
      } finally {
        send({ cmd: 'pause' });
        chartRef.current?.resetChart();
        dispatch({ type: 'END_SESSION' });
        dispatch({ type: 'SET_REPLAY_DATE', date: getLastTradingDate() });
        setDateConfirmed(false);
        setSessionHistory([]);
        setIsEndingSession(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEndingSession, state.openPositions.length]);

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!state.sessionActive) return;
      // Freeze user hotkeys while Orion is autonomously driving the
      // workspace so a stray Alt+1 doesn't pause the automation mid-run.
      if (isOrionDriving) return;

      // Ctrl+Space → Next Candle
      if (e.ctrlKey && e.code === 'Space') {
        e.preventDefault();
        send({ cmd: 'next_candle' });
      }
      // Alt+1 → Play/Pause
      if (e.altKey && e.key === '1') {
        e.preventDefault();
        send({ cmd: state.isPlaying ? 'pause' : 'play' });
        dispatch({ type: 'SET_PLAYING', isPlaying: !state.isPlaying });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state.sessionActive, state.isPlaying, send, isOrionDriving]);

  // --- Auto-pull fresh market data once the workspace is entered with managed data ---
  useEffect(() => {
    if (view !== 'workspace' || dataSource?.mode !== 'managed' || dataSynced) return;

    const syncData = async () => {
      try {
        const tauri = (window as any).__TAURI_INTERNALS__;
        if (tauri?.invoke) {
          await tauri.invoke('fetch_market_data');
          console.log('[OpenRewind] Market data refreshed');
        }
      } catch (err) {
        console.warn('[OpenRewind] Auto-fetch failed or not in Tauri:', err);
      }
      setDataSynced(true);
      // Tell the engine to rescan the data directory and refresh the ticker list.
      // The script itself also POSTs /api/data_refreshed; this is a fallback.
      try {
        await fetch(`${API_BASE}/api/data_refreshed`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        fetchTickers();
      } catch (e) {
        console.warn('[OpenRewind] Engine refresh failed:', e);
      }
    };

    syncData();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, dataSource, dataSynced]);

  // --- Change replay date from the Toolbar date picker ---
  // Probe the requested date; if the local cache has no bars for it, fall
  // back to the nearest previous weekday. This mirrors setSession's fallback
  // and prevents the engine from rejecting a manual date pick.
  const handleDateChange = useCallback(
    async (newDate: string) => {
      if (!newDate) return;
      if (newDate.length !== 10) {
        console.log('[Orion Diagnostic] handleDateError triggered', { reason: 'bad-length', newDate, length: newDate.length });
        setSymbolError('No local market data found for this date.');
        return;
      }
      if (!state.symbol) {
        dispatch({ type: 'SET_REPLAY_DATE', date: newDate });
        clearDateError();
        clearSymbolError();
        setDateConfirmed(false);
        return;
      }

      let sessionDate = newDate;
      try {
        const probe = await fetchCandles(
          { symbol: state.symbol, date: newDate, timeframe: 1, limit: 1, dataDir },
          API_BASE
        );
        if (probe.missing) {
          console.log('[Orion Diagnostic] handleDateError triggered', { reason: 'no-data', newDate });
          setSymbolError('No local market data found for this date.');
          setDateConfirmed(false);
          return;
        }
        sessionDate = probe.fallbackDate ?? newDate;
      } catch (e) {
        console.error('[OpenRewind] Failed to probe date:', e);
        // proceed with the requested date; the engine will surface a real error if it is truly missing
      }

      dispatch({ type: 'SET_REPLAY_DATE', date: sessionDate });
      clearDateError();
      clearSymbolError();
      setDateConfirmed(false);

      if (!state.sessionActive) {
        // No active session yet — the date will be used when the user picks a ticker.
        return;
      }

      try {
        const balance = state.balance > 0 ? state.balance : 100000;
        const requestBody = sessionStartBody(
          { symbol: state.symbol, starting_balance: balance, start_date: sessionDate },
          dataDir
        );
        console.log('[session-trace] handleDateChange request:', requestBody);
        const res = await fetch(`${API_BASE}/api/session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
        const data = await res.json();
        console.log('[session-trace] handleDateChange response:', data);
        if (data.error) {
          console.error('[OpenRewind] Date change failed:', data.error);
          console.log('[Orion Diagnostic] handleDateError triggered', { reason: 'engine-error', error: data.error });
          setDateConfirmed(false);
          setSymbolError('No local market data found for this date.');
          return;
        }
        clearDateError();
        clearSymbolError();
        dispatch({
          type: 'SESSION_STARTED',
          payload: {
            session_id: data.session_id ?? '1',
            symbol: state.symbol,
            total_candles: data.total_candles ?? 0,
            start_ts: data.start_ts ?? 0,
            end_ts: data.end_ts ?? 0,
            start_date: data.start_date ?? sessionDate,
            start_cursor: data.start_cursor ?? 0,
          },
        });
        dispatch({ type: 'SET_REPLAY_DATE', date: data.start_date ?? sessionDate });
        setDateConfirmed(true);
      } catch (err) {
        console.error('[OpenRewind] Failed to change date:', err);
        console.log('[Orion Diagnostic] handleDateError triggered', { reason: 'exception', err });
        setSymbolError('No local market data found for this date.');
      }
    },
    [state.sessionActive, state.symbol, state.balance, clearDateError, setSymbolError, clearSymbolError, dataDir]
  );

  // --- WS command helpers ---
  const handlePlay = useCallback(() => {
    // Set direction before starting playback
    send({ cmd: 'set_direction', direction: state.playbackDirection });
    send({ cmd: 'play' });
    dispatch({ type: 'SET_PLAYING', isPlaying: true });
  }, [send, state.playbackDirection]);

  const handlePause = useCallback(() => {
    send({ cmd: 'pause' });
    dispatch({ type: 'SET_PLAYING', isPlaying: false });
  }, [send]);

  const handleNextCandle = useCallback(() => {
    // Set direction to forward, pause if currently playing
    if (state.isPlaying) {
      send({ cmd: 'pause' });
      dispatch({ type: 'SET_PLAYING', isPlaying: false });
    }
    dispatch({ type: 'SET_DIRECTION', playbackDirection: 'forward' });
    send({ cmd: 'set_direction', direction: 'forward' });
    send({ cmd: 'next_candle' });
  }, [send, state.isPlaying]);

  const handleRewind = useCallback(() => {
    // Guard: already at the first bar — rewind would underflow.
    if (state.cursor === 0) return;

    if (state.isPlaying) {
      send({ cmd: 'pause' });
      dispatch({ type: 'SET_PLAYING', isPlaying: false });
    }
    dispatch({ type: 'SET_DIRECTION', playbackDirection: 'backward' });
    send({ cmd: 'set_direction', direction: 'backward' });
    send({ cmd: 'rewind' });
  }, [send, state.isPlaying, state.cursor]);

  const handleSetSpeed = useCallback(
    (speed: number) => {
      send({ cmd: 'set_speed', speed });
      dispatch({ type: 'SET_SPEED', speed });
    },
    [send]
  );

  const handleSetTimeframe = useCallback(
    (minutes: number) => {
      send({ cmd: 'set_timeframe', minutes });
      dispatch({ type: 'SET_TIMEFRAME', timeframe: minutes });
    },
    [send]
  );

  const handlePlaceOrder = useCallback(
    (order: {
      side: Side;
      type: OrdType;
      quantity: number;
      entry_price: number;
      stop_loss: number;
      take_profit: number;
    }) => {
      send({
        cmd: 'place_order',
        side: order.side,
        type: order.type,
        quantity: order.quantity,
        entry_price: order.entry_price,
        stop_loss: order.stop_loss,
        take_profit: order.take_profit,
      });
      // Clear pending SL/TP lines to avoid duplicates with position lines
      setPendingOrderSL(0);
      setPendingOrderTP(0);
      // Lock position SL/TP after placing order
      setPositionSLUnlocked(false);
      setPositionTPUnlocked(false);
    },
    [send]
  );

  const handleCancelOrder = useCallback(
    (orderId: number) => {
      send({ cmd: 'cancel_order', order_id: orderId });
    },
    [send]
  );

  const handleClosePosition = useCallback(
    (positionId: number) => {
      send({ cmd: 'close_position', position_id: positionId });
    },
    [send]
  );

  const handlePositionSLTPChange = useCallback(
    (positionId: number, sl: number, tp: number) => {
      console.log('Updating position SL/TP:', positionId, sl, tp);
      send({ cmd: 'update_position_sltp', position_id: positionId, stop_loss: sl, take_profit: tp });
    },
    [send]
  );

  const handlePositionSLTPDrag = useCallback(
    (sl: number, tp: number, type: 'sl' | 'tp') => {
      // Only update the specific line being dragged
      if (type === 'sl') {
        setDraggedPositionSL(sl);
      } else if (type === 'tp') {
        setDraggedPositionTP(tp);
      }
    },
    []
  );

  const handleOrderPanelSLTPUpdate = useCallback(
    (sl: number, tp: number) => {
      if (state.openPositions.length > 0) {
        const pos = state.openPositions[0];
        handlePositionSLTPChange(pos.id, sl, tp);
        // Don't set pending order state - this creates duplicate lines
        // The position lines will update via the backend response
      }
    },
    [state.openPositions, handlePositionSLTPChange]
  );

  const handleUnlockPositionSL = useCallback(() => {
    setPositionSLUnlocked(true);
  }, []);

  const handleLockPositionSL = useCallback(() => {
    setPositionSLUnlocked(false);
  }, []);

  const handleUnlockPositionTP = useCallback(() => {
    setPositionTPUnlocked(true);
  }, []);

  const handleLockPositionTP = useCallback(() => {
    setPositionTPUnlocked(false);
  }, []);

  const [lockToEdge, setLockToEdge] = useState(false);
  const [showMarkers, setShowMarkers] = useState(true);
  const [chartKey] = useState(0);
  const [sessionHistory, setSessionHistory] = useState<CandleData[]>([]);
  const sessionHistoryRef = useRef<CandleData[]>([]);
  sessionHistoryRef.current = sessionHistory;
  const [showOrderPanel, setShowOrderPanel] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [pendingOrderSL, setPendingOrderSL] = useState(0);
  const [pendingOrderTP, setPendingOrderTP] = useState(0);
  const [positionSLUnlocked, setPositionSLUnlocked] = useState(false);
  const [positionTPUnlocked, setPositionTPUnlocked] = useState(false);
  const [draggedPositionSL, setDraggedPositionSL] = useState(0);
  const [draggedPositionTP, setDraggedPositionTP] = useState(0);
  const [activeTool, setActiveTool] = useState<ActiveTool>('NONE');
  const [chartLocked, setChartLocked] = useState(false);
  const [lightMode, setLightMode] = useState(false);
  const [clearHandler, setClearHandler] = useState<(() => void) | null>(null);

  // --- Reset session state when the active data source changes ---
  useEffect(() => {
    if (!dataSource) return;
    setDataSynced(false);
    setAvailableTickers([]);
    setDateConfirmed(false);
    chartRef.current?.resetChart();
    setSessionHistory([]);
    dispatch({ type: 'END_SESSION' });
    // Neutral date; a specific symbol/date selection will override this.
    dispatch({ type: 'SET_REPLAY_DATE', date: getLastTradingDate() });
  }, [dataSource]);

  const handleReset = useCallback(() => {
    // Discard any sandbox trades for the current symbol/date before restarting.
    dispatch({ type: 'CLEAR_ACTIVE_SESSION_TRADES_FOR_DATE', symbol: state.symbol, date: state.replayDate });
    chartRef.current?.resetChart(true);
    setSessionHistory([]);
    send({ cmd: 'reset_session' });
  }, [send, dispatch, state.symbol, state.replayDate]);

  const handleEndSession = useCallback(() => {
    setIsEndingSession(true);
    if (state.openPositions.length === 0) return;
    for (const pos of state.openPositions) {
      send({ cmd: 'close_position', position_id: pos.id });
    }
  }, [send, state.openPositions]);

  // --- Switch the active symbol mid-session.
  // Reuses POST /api/session/start, which:
  //   1. Reloads the candle buffer for the new symbol on the C++ side.
  //   2. Resets the matching engine to the (current) starting balance.
  //   3. Broadcasts session_started -> reducer's SESSION_STARTED case wipes
  //      candles/positions/orders so the chart cleanly shows the new ticker.
  // We probe the current replay date for the new ticker and fall back to the
  // nearest previous weekday with data, keeping manual symbol changes and
  // Orion's setSession on the same code path.
  const handleSymbolChange = useCallback(
    async (newSymbol: string, targetDate?: string) => {
      if (!newSymbol || (newSymbol === state.symbol && !targetDate)) return;
      try {
        const balance = state.balance > 0 ? state.balance : 100000;
        let sessionDate = targetDate ?? replayDate;
        console.log('[session-trace] handleSymbolChange start:', { newSymbol, targetDate, replayDate, sessionDate });
        if (sessionDate) {
          try {
            const probe = await fetchCandles(
              { symbol: newSymbol, date: sessionDate, timeframe: 1, limit: 1, dataDir },
              API_BASE
            );
            console.log('[session-trace] handleSymbolChange probe:', { newSymbol, sessionDate, missing: probe.missing, fallbackDate: probe.fallbackDate });
            if (probe.missing) {
              console.log('[Orion Diagnostic] handleSymbolError triggered', { reason: 'no-data', newSymbol, sessionDate });
              setSymbolError('No local market data found for this symbol.');
              return;
            }
            sessionDate = probe.fallbackDate ?? sessionDate;
          } catch (e) {
            console.error('[OpenRewind] Failed to probe symbol:', e);
          }
        }

        const requestBody = sessionStartBody(
          { symbol: newSymbol, starting_balance: balance, start_date: sessionDate },
          dataDir
        );
        console.log('[session-trace] handleSymbolChange request:', requestBody);
        const res = await fetch(`${API_BASE}/api/session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
        const data = await res.json();
        console.log('[session-trace] handleSymbolChange response:', data);
        if (data.error) {
          console.error('[OpenRewind] Symbol switch failed:', data.error);
          console.log('[Orion Diagnostic] handleSymbolError triggered', { reason: 'engine-error', error: data.error });
          setSymbolError('No local market data found for this symbol.');
          return;
        }
        clearDateError();
        clearSymbolError();
        dispatch({
          type: 'SESSION_STARTED',
          payload: {
            session_id: data.session_id ?? '1',
            symbol: newSymbol,
            total_candles: data.total_candles ?? 0,
            start_ts: data.start_ts ?? 0,
            end_ts: data.end_ts ?? 0,
            start_date: data.start_date ?? sessionDate,
            start_cursor: data.start_cursor ?? 0,
          },
        });
        dispatch({ type: 'SET_REPLAY_DATE', date: data.start_date ?? sessionDate ?? '' });
        // Keep dateConfirmed only if we sent a date; otherwise playback locks
        // until the user explicitly picks one via the Toolbar date picker.
        setDateConfirmed(!!sessionDate);
      } catch (err) {
        console.error('[OpenRewind] Failed to switch symbol:', err);
        console.log('[Orion Diagnostic] handleSymbolError triggered', { reason: 'exception', err });
        setSymbolError('No local market data found for this symbol.');
      }
    },
    [state.symbol, state.balance, replayDate, clearDateError, setSymbolError, clearSymbolError, dataDir]
  );

  // --- Data-source menu handlers ---
  const handleChooseManaged = useCallback(() => {
    selectManaged();
    setView('workspace');
  }, [selectManaged]);

  const handleChooseLocal = useCallback(async () => {
    await selectLocal();
    setView('local');
  }, [selectLocal]);

  const handleBackToMenu = useCallback(() => {
    setView('menu');
  }, []);

  const handleEnterLocalWorkspace = useCallback(
    (symbol: string, date: string) => {
      setView('workspace');
      handleSymbolChange(symbol, date);
    },
    [handleSymbolChange]
  );

  // Reset unlock states when no open positions
  useEffect(() => {
    if (state.openPositions.length === 0) {
      setPositionSLUnlocked(false);
      setPositionTPUnlocked(false);
      setDraggedPositionSL(0);
      setDraggedPositionTP(0);
    }
  }, [state.openPositions.length]);

  const currentPrice = state.currentPrice;

  // --- Render: Trading Workspace (FXReplay layout) ---
  return (
    <div className={`flex h-screen w-screen flex-col overflow-hidden ${lightMode ? 'bg-gray-100 light-mode' : 'bg-[#121416]'}`}>
      {showIntro && (
        <IntroSplash
          lightMode={lightMode}
          onFinished={() => {
            setShowIntro(false);
            setView('menu');
          }}
        />
      )}
      {view === 'menu' && (
        <DataSourceMenu
          onManaged={handleChooseManaged}
          onLocal={handleChooseLocal}
          isResolving={dataSourceResolving}
          lightMode={lightMode}
        />
      )}
      {view === 'local' && (
        <LocalDataScreen
          onBack={handleBackToMenu}
          onEnterWorkspace={handleEnterLocalWorkspace}
          lightMode={lightMode}
        />
      )}
      {view === 'workspace' && (
        <>
          {/* Top header */}
      {dateError && (
        <ErrorAlert message={dateError} onClose={clearDateError} lightMode={lightMode} />
      )}
      <Header
        connected={connected}
        reconnecting={reconnecting}
        symbol={state.symbol}
        sessionActive={state.sessionActive}
        lightMode={lightMode}
        onEndSession={handleEndSession}
      />

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Drawing toolbar (TradingView-style sidebar) */}
        <TradingToolbar
          activeTool={activeTool}
          onActiveToolChange={setActiveTool}
          chartLocked={chartLocked}
          onChartLockedChange={setChartLocked}
          onClearAll={clearHandler || (() => {})}
          lightMode={lightMode}
        />

        {/* Main chart section */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Toolbar with symbol + timeframe */}
          <Toolbar
            symbol={state.symbol}
            availableTickers={availableTickers}
            onSymbolChange={handleSymbolChange}
            error={symbolError ?? undefined}
            replayDate={replayDate}
            onDateChange={handleDateChange}
            timeframe={state.timeframe}
            lockToEdge={lockToEdge}
            showMarkers={showMarkers}
            lightMode={lightMode}
            onToggleLightMode={() => setLightMode((v) => !v)}
            indicators={state.indicators}
            onSetTimeframe={handleSetTimeframe}
            onToggleLock={() => setLockToEdge((v) => !v)}
            onToggleMarkers={() => setShowMarkers((v) => !v)}
            onToggleIndicator={(indicator) => dispatch({ type: 'TOGGLE_INDICATOR', indicator })}
            onReset={handleReset}
            onOpenCalendar={() => setShowCalendar(true)}
            orionOpen={isOrionOpen}
            onToggleOrion={() => setIsOrionOpen((v) => !v)}
          />

          {/* Chart area with drawing tools */}
          <div className="flex flex-1 overflow-hidden">
            {/* Main chart canvas with playback overlay */}
            <div className="relative flex-1 min-w-0">
              {/* Floating playback controls */}
              <PlaybackControls
                isPlaying={state.isPlaying}
                speed={state.speed}
                cursor={state.cursor}
                totalCandles={state.totalCandles}
                sessionActive={state.sessionActive}
                locked={isOrionDriving}
                playbackDirection={state.playbackDirection}
                onPlay={handlePlay}
                onPause={handlePause}
                onNextCandle={handleNextCandle}
                onRewind={handleRewind}
                onSetSpeed={handleSetSpeed}
                lightMode={lightMode}
              />

              {/* TradingView Lightweight Charts */}
              <Chart
                ref={chartRef}
                key={chartKey}
                positions={state.openPositions}
                trades={state.tradeHistory}
                currentPrice={currentPrice}
                showMarkers={showMarkers}
                lockToEdge={lockToEdge}
                timeframe={state.timeframe}
                indicators={state.indicators}
                pendingOrderSL={pendingOrderSL}
                pendingOrderTP={pendingOrderTP}
                onPendingOrderSLChange={setPendingOrderSL}
                onPendingOrderTPChange={setPendingOrderTP}
                onPositionSLTPChange={handlePositionSLTPChange}
                onPositionSLTPDrag={handlePositionSLTPDrag}
                positionSLUnlocked={positionSLUnlocked}
                positionTPUnlocked={positionTPUnlocked}
                activeTool={activeTool}
                onActiveToolChange={setActiveTool}
                chartLocked={chartLocked}
                onClearAll={setClearHandler}
                lightMode={lightMode}
              />

              {/* Orion chart-area lock. Only blocks the canvas; the toolbar
                  and symbol input remain usable. */}
              <OrionDrivingOverlay visible={isOrionDriving} activityLine={lastActivityLine} />
            </div>

            {/* Advanced Order Panel (collapsible right sidebar) */}
            {showOrderPanel && (
              <OrderPanel
                currentPrice={currentPrice}
                sessionActive={state.sessionActive}
                quantity={state.orderQuantity}
                onSetQuantity={(qty) => dispatch({ type: 'SET_QUANTITY', orderQuantity: qty })}
                onPlaceOrder={handlePlaceOrder}
                onClose={() => {
                  setShowOrderPanel(false);
                  // Only clear if no open positions
                  if (state.openPositions.length === 0) {
                    setPendingOrderSL(0);
                    setPendingOrderTP(0);
                  }
                }}
                onSLChange={setPendingOrderSL}
                onTPChange={setPendingOrderTP}
                externalSL={pendingOrderSL}
                externalTP={pendingOrderTP}
                draggedPositionSL={draggedPositionSL}
                draggedPositionTP={draggedPositionTP}
                openPositions={state.openPositions}
                onPositionSLTPUpdate={handleOrderPanelSLTPUpdate}
                onUnlockPositionSL={handleUnlockPositionSL}
                onLockPositionSL={handleLockPositionSL}
                onUnlockPositionTP={handleUnlockPositionTP}
                onLockPositionTP={handleLockPositionTP}
                lightMode={lightMode}
              />
            )}
          </div>

          {/* Trade history drawer (slides up above bottom panel) */}
          {showHistory && (
            <TradeHistoryDrawer
              trades={state.tradeHistory}
              onClearHistory={() => dispatch({ type: 'CLEAR_TRADE_HISTORY' })}
              onClose={() => setShowHistory(false)}
              lightMode={lightMode}
            />
          )}

          {/* Bottom trading panel */}
          <BottomPanel
            balance={state.balance}
            equity={state.equity}
            currentPrice={currentPrice}
            sessionActive={state.sessionActive}
            openPositions={state.openPositions}
            quantity={state.orderQuantity}
            onSetQuantity={(qty) => dispatch({ type: 'SET_QUANTITY', orderQuantity: qty })}
            onPlaceOrder={handlePlaceOrder}
            onClosePosition={handleClosePosition}
            onCancelOrder={handleCancelOrder}
            onToggleOrderPanel={() => setShowOrderPanel((v) => !v)}
            showHistory={showHistory}
            onToggleHistory={() => setShowHistory((v) => !v)}
            lightMode={lightMode}
          />
        </div>

        {/* Orion AI coach side-panel */}
        {isOrionOpen && (
          <OrionTerminal
            performanceLog={state.performanceLog}
            lightMode={lightMode}
            appState={state}
            chartRef={chartRef}
            apiBase={API_BASE}
            dataDir={dataDir}
            availableTickers={availableTickers}
            onSwitchSymbol={handleSymbolChange}
            send={send}
            dispatch={dispatch}
          />
        )}
      </div>

      <TradingCalendar
        isOpen={showCalendar}
        onClose={() => setShowCalendar(false)}
        log={state.performanceLog}
        lightMode={lightMode}
      />
      </>
    )}
    </div>
  );
}
