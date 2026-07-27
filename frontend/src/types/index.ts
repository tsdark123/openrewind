// =============================================================================
// OpenRewind Frontend — TypeScript Interfaces
//
// Mirrors the C++ structs defined in matching.hpp and the JSON payloads
// documented in ARCHITECTURE.md §5.3. These types are the single source
// of truth for all frontend state and network communication.
// =============================================================================

// --- Candle (OHLCV Bar) ---

export interface CandleData {
  timestamp: number; // Unix epoch seconds (UTC)
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// lightweight-charts expects `time` as a UTCTimestamp (number).
export interface LWCCandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

// --- Order ---

export type Side = 'buy' | 'sell';
export type OrdType = 'market' | 'limit' | 'stop';
export type OrdStatus =
  | 'pending'
  | 'filled'
  | 'cancelled'
  | 'stop_loss_hit'
  | 'take_profit_hit';
export type CloseReason = 'sl' | 'tp' | 'manual';

export interface Order {
  id: number;
  side: Side;
  type: OrdType;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  quantity: number;
  status: OrdStatus;
  created_at: number;
  filled_at?: number;
  fill_price?: number;
}

// --- Position ---

export interface Position {
  id: number;
  side: Side;
  entry_price: number;
  quantity: number;
  stop_loss: number;
  take_profit: number;
  opened_at: number;
}

// --- Closed Trade ---

export interface ClosedTrade {
  id: number;
  side: Side;
  entry_price: number;
  exit_price: number;
  quantity: number;
  realized_pnl: number;
  stop_loss?: number;
  take_profit?: number;
  reason: CloseReason;
  opened_at: number;
  closed_at: number;
}

// --- Account Snapshot ---

export interface AccountSnapshot {
  balance: number;
  equity: number;
  open_position_count: number;
  pending_order_count: number;
}

// --- WebSocket Event Envelope ---

export interface WSEnvelope<T = unknown> {
  type: string;
  seq: number;
  payload: T;
}

// --- Server → Client Event Payloads ---

export interface CandleUpdatePayload {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  cursor: number;
  total: number;
}

export interface AccountSnapshotPayload {
  balance: number;
  equity: number;
  open_position_count: number;
  pending_order_count: number;
}

export interface OrderFilledPayload {
  order_id: number;
  side: Side;
  type: OrdType;
  fill_price: number;
  quantity: number;
  timestamp: number;
}

export interface PositionClosedPayload {
  position_id: number;
  side: Side;
  entry_price: number;
  exit_price: number;
  quantity: number;
  realized_pnl: number;
  stop_loss: number;
  take_profit: number;
  opened_at: number;
  reason: CloseReason;
  timestamp: number;
}

export interface SessionStartedPayload {
  session_id: string;
  symbol: string;
  total_candles: number;
  start_ts: number;
  end_ts: number;
}

export interface SessionStatePayload {
  symbol: string;
  cursor: number;
  total_candles: number;
  is_playing: boolean;
  speed: number;
  timeframe: number;
  candle: CandleData | null;
  candles: CandleData[];
  account: AccountSnapshotPayload;
  open_positions: Position[];
  pending_orders: Order[];
  trade_history: ClosedTrade[];
}

// --- Calendar / Journal Types ---

export interface ActiveSessionTrade extends ClosedTrade {
  symbol: string;
  date: string; // YYYY-MM-DD
}

export interface TradeLog {
  id: string;
  symbol: string;
  date: string; // YYYY-MM-DD
  action: 'BUY' | 'SELL';
  entryTime: number; // Unix epoch seconds
  exitTime: number; // Unix epoch seconds
  entryPrice: number;
  exitPrice: number;
  quantity: number;
  realizedPnl: number;
  stopLoss?: number;
  takeProfit?: number;
  rMultiple: number;
}

export interface SessionRecord {
  id: string;
  symbol: string;
  date: string; // YYYY-MM-DD
  startedAt: number;
  endedAt: number;
  startingBalance: number;
  endingBalance: number;
  trades?: TradeLog[]; // canonical granular log; new records always set this
  closedTrades?: ClosedTrade[]; // legacy: only present in pre-Orion journal records
}

export type PerformanceLog = Record<string, SessionRecord[]>; // key = `${symbol}:${date}`

// --- Application State ---

export interface AppState {
  connected: boolean;
  sessionActive: boolean;
  symbol: string;
  replayDate: string; // YYYY-MM-DD

  cursor: number;
  totalCandles: number;
  timeframe: number;
  currentPrice: number;

  isPlaying: boolean;
  speed: number;
  playbackDirection: 'forward' | 'backward';
  orderQuantity: number;

  indicators: {
    ema20: boolean;
    sma50: boolean;
    bollinger: boolean;
    rsi: boolean;
    macd: boolean;
    atr: boolean;
    stochastic: boolean;
  };

  balance: number;
  equity: number;
  openPositions: Position[];
  pendingOrders: Order[];
  tradeHistory: ClosedTrade[];

  // Calendar/session tracking
  activeSessionTrades: ActiveSessionTrade[];
  performanceLog: PerformanceLog;
}

// --- Reducer Actions ---

export type AppAction =
  | { type: 'SET_CONNECTED'; connected: boolean }
  | { type: 'SESSION_STARTED'; payload: SessionStartedPayload }
  | { type: 'SESSION_STOPPED' }
  | { type: 'SESSION_STATE'; payload: SessionStatePayload }
  | { type: 'CANDLE_UPDATE'; payload: CandleUpdatePayload }
  | { type: 'ACCOUNT_SNAPSHOT'; payload: AccountSnapshotPayload }
  | { type: 'ORDER_FILLED'; payload: OrderFilledPayload }
  | { type: 'POSITION_CLOSED'; payload: PositionClosedPayload }
  | { type: 'SET_PLAYING'; isPlaying: boolean }
  | { type: 'SET_SPEED'; speed: number }
  | { type: 'SET_DIRECTION'; playbackDirection: 'forward' | 'backward' }
  | { type: 'SET_QUANTITY'; orderQuantity: number }
  | { type: 'SET_TIMEFRAME'; timeframe: number }
  | { type: 'SET_POSITIONS'; positions: Position[] }
  | { type: 'SET_PENDING_ORDERS'; orders: Order[] }
  | { type: 'ADD_TRADE'; trade: ClosedTrade }
  | { type: 'CLEAR_TRADE_HISTORY' }
  | { type: 'TOGGLE_INDICATOR'; indicator: keyof AppState['indicators'] }
  | { type: 'CLEAR_PENDING_SLTP' }
  | { type: 'SET_REPLAY_DATE'; date: string }
  | { type: 'ADD_ACTIVE_SESSION_TRADE'; trade: ActiveSessionTrade }
  | { type: 'CLEAR_ACTIVE_SESSION_TRADES_FOR_DATE'; symbol: string; date: string }
  | { type: 'CLEAR_ACTIVE_SESSION_TRADES' }
  | { type: 'SET_PERFORMANCE_LOG'; log: PerformanceLog }
  | { type: 'END_SESSION' };
