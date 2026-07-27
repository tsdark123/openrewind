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
import { OrionChatSidepanel } from './components/ui/ai-chat';
import { useWebSocket } from './hooks/useWebSocket';
import { endSession, loadPerformanceLog } from './lib/journal';
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
        totalCandles: action.payload.total_candles,
        cursor: 0,
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

  // dateConfirmed — true only after a session has been successfully started with
  //                 that date; controls stay locked until this is true.
  const [dateConfirmed, setDateConfirmed] = useState(false);
  const [dateError, setDateError] = useState<string | null>(null);

  // Calendar / session flow state.
  const [showCalendar, setShowCalendar] = useState(false);
  const [isEndingSession, setIsEndingSession] = useState(false);

  // Orion AI coach side-panel visibility.
  const [isOrionOpen, setIsOrionOpen] = useState(false);

  // Intro splash control.
  const [showIntro, setShowIntro] = useState(true);
  const [introFinished, setIntroFinished] = useState(false);
  const [dataSynced, setDataSynced] = useState(false);

  const replayDate = state.replayDate;

  const showDateError = useCallback(() => {
    setDateError('Please select a valid past trading weekday where market data has been synced.');
  }, []);

  const clearDateError = useCallback(() => setDateError(null), []);

  const onCandleUpdate = useCallback((payload: CandleUpdatePayload) => {
    chartRef.current?.updateCandle(payload);
  }, []);

  const onSessionReset = useCallback(() => {
    chartRef.current?.resetChart();
  }, []);

  const onSessionHistory = useCallback((candles: CandleData[]) => {
    chartRef.current?.setHistory(candles);
  }, []);

  const [availableTickers, setAvailableTickers] = useState<string[]>([]);

  const fetchTickers = useCallback(() => {
    fetch(`${API_BASE}/api/tickers`)
      .then((r) => r.json())
      .then((d: { tickers?: string[] }) => {
        if (Array.isArray(d.tickers)) setAvailableTickers(d.tickers);
      })
      .catch((err) => {
        console.warn('[OpenRewind] Failed to fetch ticker list:', err);
      });
  }, []);

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

  // --- Fetch the list of tradable tickers from the C++ engine on mount.
  // Used by both the Start Session form and the in-app Toolbar autocomplete.
  useEffect(() => {
    fetchTickers();
    loadPerformanceLog().then((log) => dispatch({ type: 'SET_PERFORMANCE_LOG', log }));

    // Boot the local Ollama service automatically when running as a Tauri app.
    if (isTauri) {
      const tauri = (window as any).__TAURI_INTERNALS__;
      tauri
        ?.invoke?.('ensure_ollama_running')
        .catch((err: unknown) => {
          console.warn('[Orion] Could not auto-start Ollama:', err);
        });
    }
    return () => {}; // no cleanup needed — fetchTickers is idempotent
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // run once on mount; onDataSynced handles subsequent refreshes

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
        setDateConfirmed(false);
        setChartKey((k) => k + 1);
        setIsEndingSession(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEndingSession, state.openPositions.length]);

  // --- Keyboard shortcuts ---
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!state.sessionActive) return;

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
  }, [state.sessionActive, state.isPlaying, send]);

  // --- Auto-pull fresh market data once the intro splash finishes ---
  useEffect(() => {
    if (!introFinished || dataSynced) return;

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
  }, [introFinished, dataSynced]);

  // --- Change replay date from the Toolbar date picker ---
  const handleDateChange = useCallback(
    async (newDate: string) => {
      if (!newDate || !state.sessionActive) return;
      if (newDate.length !== 10) {
        showDateError();
        return;
      }
      dispatch({ type: 'SET_REPLAY_DATE', date: newDate });
      setDateConfirmed(false);
      try {
        const balance = state.balance > 0 ? state.balance : 100000;
        const res = await fetch(`${API_BASE}/api/session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: state.symbol,
            starting_balance: balance,
            start_date: newDate,
          }),
        });
        const data = await res.json();
        if (data.error) {
          console.error('[OpenRewind] Date change failed:', data.error);
          setDateConfirmed(false);
          showDateError();
          return;
        }
        clearDateError();
        setChartKey((k) => k + 1);
        setDateConfirmed(true);
      } catch (err) {
        console.error('[OpenRewind] Failed to change date:', err);
        showDateError();
      }
    },
    [state.sessionActive, state.symbol, state.balance, clearDateError, showDateError]
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
      // Force Chart to remount on TF change — prevents stale LineSeries
      // timestamp conflicts after setData rebuilds the time scale.
      setChartKey((k) => k + 1);
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
  const [chartKey, setChartKey] = useState(0);
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

  const handleReset = useCallback(() => {
    // Discard any sandbox trades for the current symbol/date before restarting.
    dispatch({ type: 'CLEAR_ACTIVE_SESSION_TRADES_FOR_DATE', symbol: state.symbol, date: state.replayDate });
    send({ cmd: 'reset_session' });
    setChartKey((k) => k + 1);
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
  // We bump chartKey for the same reason set_timeframe does: forces
  // lightweight-charts to remount and avoid stale time-scale state.
  const handleSymbolChange = useCallback(
    async (newSymbol: string) => {
      if (!newSymbol || newSymbol === state.symbol) return;
      try {
        const balance = state.balance > 0 ? state.balance : 100000;
        // Carry the current replay date so the new symbol starts on the same
        // day. If no date has been chosen yet, the C++ engine loads the full
        // 30-day buffer and playback stays locked until the user picks one.
        const body: Record<string, unknown> = {
          symbol: newSymbol,
          starting_balance: balance,
        };
        if (replayDate) body.start_date = replayDate;
        const res = await fetch(`${API_BASE}/api/session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        if (data.error) {
          console.error('[OpenRewind] Symbol switch failed:', data.error);
          showDateError();
          return;
        }
        clearDateError();
        setChartKey((k) => k + 1);
        // Keep dateConfirmed only if we sent a date; otherwise playback locks
        // until the user explicitly picks one via the Toolbar date picker.
        setDateConfirmed(!!replayDate);
      } catch (err) {
        console.error('[OpenRewind] Failed to switch symbol:', err);
        showDateError();
      }
    },
    [state.symbol, state.balance, replayDate, clearDateError, showDateError]
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
            setIntroFinished(true);
          }}
        />
      )}
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
        orionOpen={isOrionOpen}
        onToggleOrion={() => setIsOrionOpen((v) => !v)}
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
                locked={!dateConfirmed}
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
          <OrionChatSidepanel
            performanceLog={state.performanceLog}
            lightMode={lightMode}
          />
        )}
      </div>

      <TradingCalendar
        isOpen={showCalendar}
        onClose={() => setShowCalendar(false)}
        log={state.performanceLog}
        lightMode={lightMode}
      />
    </div>
  );
}
