/**
 * In-memory AppState reducer for the headless lab runner.
 */

import type { AppState, AppAction, IndicatorsState, ScenarioInitialWorldState } from './types';

const defaultIndicators: IndicatorsState = {
  ema20: false,
  sma50: false,
  bollinger: false,
  rsi: false,
  macd: false,
  atr: false,
  stochastic: false,
};

export function createDefaultAppState(): AppState {
  return {
    connected: false,
    sessionActive: false,
    symbol: '',
    replayDate: '',
    cursor: 0,
    totalCandles: 0,
    startTimestamp: 0,
    timeframe: 1,
    currentPrice: 0,
    isPlaying: false,
    speed: 1,
    playbackDirection: 'forward',
    orderQuantity: 10,
    indicators: { ...defaultIndicators },
    balance: 0,
    equity: 0,
    openPositions: [],
    pendingOrders: [],
    tradeHistory: [],
    activeSessionTrades: [],
    performanceLog: {},
  };
}

export function appStateFromInitialWorldState(initial: ScenarioInitialWorldState): AppState {
  const s = initial.session;

  return {
    ...createDefaultAppState(),
    symbol: s.symbol,
    replayDate: s.date,
    timeframe: s.timeframe,
    cursor: s.cursor,
    totalCandles: s.totalCandles,
    startTimestamp: s.startTimestamp ?? 0,
    isPlaying: s.isPlaying,
    speed: s.speed,
    playbackDirection: s.direction,
    currentPrice: s.currentPrice,
    sessionActive: s.sessionActive,
    balance: initial.account?.balance ?? 0,
    equity: initial.account?.equity ?? 0,
    openPositions: initial.account?.openPositions ?? [],
    pendingOrders: initial.account?.pendingOrders ?? [],
    indicators: { ...defaultIndicators, ...(initial.indicators ?? {}) },
  };
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_CONNECTED':
      return { ...state, connected: action.connected };

    case 'SESSION_STARTED': {
      const p = action.payload;
      return {
        ...state,
        sessionActive: true,
        symbol: p.symbol,
        replayDate: p.start_date ?? state.replayDate,
        totalCandles: p.total_candles,
        startTimestamp: p.start_ts ?? state.startTimestamp,
        cursor: p.start_cursor ?? 0,
        currentPrice: 0,
        isPlaying: false,
        indicators: { ...defaultIndicators },
        openPositions: [],
        pendingOrders: [],
        tradeHistory: [],
        activeSessionTrades: [],
      };
    }

    case 'SESSION_STOPPED':
      return { ...state, sessionActive: false, isPlaying: false };

    case 'SESSION_STATE': {
      const p = action.payload;
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
      return {
        ...state,
        cursor: c.cursor,
        totalCandles: c.total,
        currentPrice: c.close,
      };
    }

    case 'ACCOUNT_SNAPSHOT':
      return { ...state, balance: action.payload.balance, equity: action.payload.equity };

    case 'ORDER_FILLED':
      return state;

    case 'POSITION_CLOSED': {
      const closedId = action.payload.position_id;
      const trade: import('./types').ClosedTrade = {
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
        is_automated: action.payload.is_automated === true,
      };
      const activeTrade: import('./types').ActiveSessionTrade = {
        ...trade,
        symbol: state.symbol,
        date: state.replayDate,
      };
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
      return { ...state, tradeHistory: [...state.tradeHistory, action.trade] };

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
      return { ...state, activeSessionTrades: [...state.activeSessionTrades, action.trade] };

    case 'CLEAR_ACTIVE_SESSION_TRADES_FOR_DATE':
      return {
        ...state,
        activeSessionTrades: state.activeSessionTrades.filter(
          (t) => !(t.symbol === action.symbol && t.date === action.date),
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
