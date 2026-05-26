import { useReducer, useCallback, useEffect, useState, useMemo } from 'react';
import { Loader2, PlayCircle, Search } from 'lucide-react';
import { Chart } from './components/Chart';
import { Header } from './components/layout/Header';
import { LeftSidebar } from './components/layout/LeftSidebar';
import { Toolbar } from './components/layout/Toolbar';
import { BottomPanel } from './components/layout/BottomPanel';
import { PlaybackControls } from './components/layout/PlaybackControls';
import { OrderPanel } from './components/layout/OrderPanel';
import { TradeHistoryDrawer } from './components/layout/TradeHistoryDrawer';
import { useWebSocket } from './hooks/useWebSocket';
import type {
  AppState,
  AppAction,
  CandleData,
  Side,
  OrdType,
} from './types';
import { aggregateCandles } from './utils/aggregateCandles';

// =============================================================================
// App State Reducer
// =============================================================================

const initialState: AppState = {
  connected: false,
  sessionActive: false,
  symbol: '',

  candles: [],
  cursor: 0,
  totalCandles: 0,
  timeframe: 1,

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
        candles: [],
        cursor: 0,
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
      let candles: CandleData[];
      if (state.candles.length === 0) {
        // Initial load — seed with current candle if provided
        candles = p.candle ? [p.candle] : [];
      } else if (p.cursor < state.cursor && state.candles.length > 0) {
        // Rewind: cursor moved backwards — truncate candle array to match
        candles = state.candles.slice(0, p.cursor + 1);
      } else {
        // Normal state refresh (order placement, TF change, etc.)
        candles = state.candles;
      }
      return {
        ...state,
        sessionActive: true,
        symbol: p.symbol,
        candles,
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
      const newCandle: CandleData = {
        timestamp: c.timestamp,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
      };

      // Detect backward step: if cursor decreased, truncate instead of append
      if (c.cursor < state.cursor) {
        // Backward step: truncate to new cursor + 1
        const truncated = state.candles.slice(0, c.cursor + 1);
        return {
          ...state,
          candles: truncated,
          cursor: c.cursor,
          totalCandles: c.total,
        };
      }

      // Forward step: append new candle (or update if same timestamp)
      const existingIndex = state.candles.findIndex(candle => candle.timestamp === c.timestamp);
      if (existingIndex >= 0) {
        // Update existing candle (in case of refresh)
        const updated = [...state.candles];
        updated[existingIndex] = newCandle;
        return {
          ...state,
          candles: updated,
          cursor: c.cursor,
          totalCandles: c.total,
        };
      }

      // Append new candle
      return {
        ...state,
        candles: [...state.candles, newCandle],
        cursor: c.cursor,
        totalCandles: c.total,
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
      return {
        ...state,
        openPositions: state.openPositions.filter((p) => p.id !== closedId),
        tradeHistory: [
          ...state.tradeHistory,
          {
            id: action.payload.position_id,
            side: action.payload.side,
            entry_price: action.payload.entry_price,
            exit_price: action.payload.exit_price,
            quantity: action.payload.quantity,
            realized_pnl: action.payload.realized_pnl,
            reason: action.payload.reason,
            opened_at: action.payload.timestamp,
            closed_at: action.payload.timestamp,
          },
        ],
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

    default:
      return state;
  }
}

// =============================================================================
// Start Session Dialog — Dark FXReplay-style
// =============================================================================

function StartSessionForm({
  onStart,
  connected,
}: {
  onStart: (symbol: string, balance: number) => void;
  connected: boolean;
}) {
  const [symbol, setSymbol] = useState('AAPL');
  const [balance, setBalance] = useState('100000');

  const handleSubmit = () => {
    const bal = parseFloat(balance);
    if (!symbol.trim() || isNaN(bal) || bal <= 0) return;
    onStart(symbol.trim().toUpperCase(), bal);
  };

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 bg-[#121416]">
      <div className="flex flex-col items-center gap-2">
        <PlayCircle size={48} className="text-[#2962ff]" />
        <div className="flex items-center">
          <span className="text-2xl font-bold text-[#2962ff]">Open</span>
          <span className="text-2xl font-bold text-white">Replay</span>
        </div>
        <p className="text-sm text-[#787b86] max-w-sm text-center">
          Market replay and backtesting engine. Load historical data and
          practice trading under real market conditions.
        </p>
      </div>

      <div className="flex flex-col gap-3 w-72">
        <div>
          <label className="block text-[10px] text-[#787b86] uppercase tracking-wider mb-1">
            Symbol
          </label>
          <div className="relative">
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              placeholder="AAPL"
              className="w-full pl-9 pr-3 py-2.5 bg-[#1e222d] border border-[#363a45] rounded-lg text-sm font-mono text-[#d1d4dc] placeholder-[#787b86] focus:border-[#2962ff] focus:outline-none transition-colors"
            />
            <Search
              size={14}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-[#787b86]"
            />
          </div>
        </div>

        <div>
          <label className="block text-[10px] text-[#787b86] uppercase tracking-wider mb-1">
            Starting Balance
          </label>
          <input
            type="number"
            value={balance}
            onChange={(e) => setBalance(e.target.value)}
            placeholder="100000"
            className="w-full px-3 py-2.5 bg-[#1e222d] border border-[#363a45] rounded-lg text-sm font-mono text-[#d1d4dc] placeholder-[#787b86] focus:border-[#2962ff] focus:outline-none transition-colors"
          />
        </div>

        <button
          onClick={handleSubmit}
          disabled={!connected}
          className="flex items-center justify-center gap-2 w-full py-3 mt-1 bg-[#2962ff] hover:bg-[#2962ff]/90 text-white font-semibold rounded-lg transition-all disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {!connected ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              Connecting to engine...
            </>
          ) : (
            <>
              <PlayCircle size={16} />
              Start Session
            </>
          )}
        </button>

        {!connected && (
          <p className="text-[10px] text-center text-[#787b86]">
            Make sure the C++ engine is running on localhost:9000
          </p>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// App — Main Application Shell
// =============================================================================

export default function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const { send, connected, reconnecting } = useWebSocket({ dispatch });

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

  // --- Session start ---
  const handleStartSession = useCallback(
    async (symbol: string, balance: number) => {
      try {
        const res = await fetch('/api/session/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol,
            starting_balance: balance,
            data_dir: 'C:/Users/logja/CascadeProjects/2048/data',
          }),
        });
        const data = await res.json();
        if (data.error) {
          console.error('[OpenReplay] Session start failed:', data.error);
        }
      } catch (err) {
        console.error('[OpenReplay] Failed to start session:', err);
      }
    },
    []
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
    // Set direction to backward, pause if currently playing (key fix for "rewind is dead")
    if (state.isPlaying) {
      send({ cmd: 'pause' });
      dispatch({ type: 'SET_PLAYING', isPlaying: false });
    }
    dispatch({ type: 'SET_DIRECTION', playbackDirection: 'backward' });
    send({ cmd: 'set_direction', direction: 'backward' });
    send({ cmd: 'rewind' });
  }, [send, state.isPlaying]);

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
  const [drawingManager, setDrawingManager] = useState<any>(null);
  const [activeTool, setActiveTool] = useState<'NONE' | 'FIB' | 'RECTANGLE' | 'TEXT' | 'BRUSH' | 'LINE'>('NONE');
  const [chartLocked, setChartLocked] = useState(false);
  const [lightMode, setLightMode] = useState(false);

  const handleReset = useCallback(() => {
    send({ cmd: 'reset_session' });
    setChartKey((k) => k + 1);
  }, [send]);

  // Aggregate candles to the selected timeframe for display
  const displayCandles = useMemo(
    () => aggregateCandles(state.candles, state.timeframe),
    [state.candles, state.timeframe]
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

  const currentPrice =
    state.candles.length > 0
      ? state.candles[state.candles.length - 1].close
      : 0;

  // --- Render: Start Screen (no active session) ---
  if (!state.sessionActive) {
    return (
      <div className={`flex flex-col h-screen w-screen overflow-hidden ${lightMode ? 'bg-gray-100 light-mode' : 'bg-[#121416]'}`}>
        <Header
          connected={connected}
          reconnecting={reconnecting}
          symbol=""
          sessionActive={false}
          lightMode={lightMode}
        />
        <StartSessionForm
          onStart={handleStartSession}
          connected={connected}
        />
      </div>
    );
  }

  // --- Render: Trading Workspace (FXReplay layout) ---
  return (
    <div className={`flex h-screen w-screen flex-col overflow-hidden ${lightMode ? 'bg-gray-100 light-mode' : 'bg-[#121416]'}`}>
      {/* Top header */}
      <Header
        connected={connected}
        reconnecting={reconnecting}
        symbol={state.symbol}
        sessionActive={state.sessionActive}
        lightMode={lightMode}
      />

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left sidebar with icons */}
        <LeftSidebar
          drawingManager={drawingManager}
          activeTool={activeTool}
          onActiveToolChange={setActiveTool}
          chartLocked={chartLocked}
          onChartLockedChange={setChartLocked}
          lightMode={lightMode}
        />

        {/* Main chart section */}
        <div className="flex flex-1 flex-col overflow-hidden">
          {/* Toolbar with symbol + timeframe */}
          <Toolbar
            symbol={state.symbol}
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
                key={chartKey}
                candles={displayCandles}
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
                onDrawingManagerReady={setDrawingManager}
                activeTool={activeTool}
                onActiveToolChange={setActiveTool}
                chartLocked={chartLocked}
                onChartLockedChange={setChartLocked}
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
      </div>
    </div>
  );
}
