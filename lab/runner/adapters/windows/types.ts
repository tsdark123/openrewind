/**
 * Lab-local types for the Windows production adapter.
 *
 * These mirror a small, stable subset of frontend/src/types and the production
 * agent runtime so the adapter can be type-checked without importing Vite/React
 * modules into the lab package.
 */

export interface CandleData {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = 'buy' | 'sell';
export type OrdType = 'market' | 'limit' | 'stop';
export type CloseReason = 'sl' | 'tp' | 'manual';

export interface Position {
  id: number;
  side: Side;
  entry_price: number;
  quantity: number;
  stop_loss: number;
  take_profit: number;
  opened_at: number;
  is_automated?: boolean;
}

export interface Order {
  id: number;
  side: Side;
  type: OrdType;
  entry_price: number;
  stop_loss: number;
  take_profit: number;
  quantity: number;
  status: string;
  created_at: number;
  filled_at?: number;
  fill_price?: number;
  is_automated?: boolean;
}

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
  is_automated?: boolean;
}

export interface ActiveSessionTrade extends ClosedTrade {
  symbol: string;
  date: string;
}

export interface AccountSnapshot {
  balance: number;
  equity: number;
  open_position_count: number;
  pending_order_count: number;
}

export interface CandleUpdatePayload extends CandleData {
  cursor: number;
  total: number;
}

export interface AccountSnapshotPayload {
  balance: number;
  equity: number;
}

export interface OrderFilledPayload {
  order_id: number;
  side: Side;
  type: OrdType;
  fill_price: number;
  quantity: number;
  timestamp: number;
  is_automated?: boolean;
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
  is_automated?: boolean;
}

export interface SessionStartedPayload {
  session_id: string;
  symbol: string;
  total_candles: number;
  start_ts: number;
  end_ts: number;
  start_date?: string;
  start_cursor?: number;
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
  account: AccountSnapshot;
  open_positions: Position[];
  pending_orders: Order[];
  trade_history: ClosedTrade[];
}

export interface IndicatorsState {
  ema20: boolean;
  sma50: boolean;
  bollinger: boolean;
  rsi: boolean;
  macd: boolean;
  atr: boolean;
  stochastic: boolean;
}

export interface AppState {
  connected: boolean;
  sessionActive: boolean;
  symbol: string;
  replayDate: string;
  cursor: number;
  totalCandles: number;
  timeframe: number;
  startTimestamp: number;
  currentPrice: number;
  isPlaying: boolean;
  speed: number;
  playbackDirection: 'forward' | 'backward';
  orderQuantity: number;
  indicators: IndicatorsState;
  balance: number;
  equity: number;
  openPositions: Position[];
  pendingOrders: Order[];
  tradeHistory: ClosedTrade[];
  activeSessionTrades: ActiveSessionTrade[];
  performanceLog: PerformanceLog;
}

export type PerformanceLog = Record<string, unknown>;

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
  | { type: 'TOGGLE_INDICATOR'; indicator: keyof IndicatorsState }
  | { type: 'CLEAR_PENDING_SLTP' }
  | { type: 'SET_REPLAY_DATE'; date: string }
  | { type: 'ADD_ACTIVE_SESSION_TRADE'; trade: ActiveSessionTrade }
  | { type: 'CLEAR_ACTIVE_SESSION_TRADES_FOR_DATE'; symbol: string; date: string }
  | { type: 'CLEAR_ACTIVE_SESSION_TRADES' }
  | { type: 'SET_PERFORMANCE_LOG'; log: PerformanceLog }
  | { type: 'END_SESSION' };

export interface WSEnvelope {
  type: string;
  seq: number;
  payload: unknown;
}

export interface ScenarioInitialWorldState {
  session: {
    symbol: string;
    date: string;
    timeframe: number;
    cursor: number;
    totalCandles: number;
    startTimestamp?: number;
    isPlaying: boolean;
    speed: number;
    direction: 'forward' | 'backward';
    currentPrice: number;
    sessionActive: boolean;
  };
  account?: {
    balance: number;
    equity: number;
    openPositions?: Position[];
    pendingOrders?: Order[];
  };
  indicators?: Partial<IndicatorsState>;
  availableTickers: string[];
  recentCandles: CandleData[];
  [key: string]: unknown;
}

export interface LoadedScenario {
  id: string;
  dataSet: { symbol: string; date: string; timeframe: number };
  initialWorldState: ScenarioInitialWorldState;
}

export interface ScenarioRuntime {
  appState: AppState;
  chartHandle: LabChartHandle;
  performanceLog: PerformanceLog;
  lastResult: Record<string, unknown> | undefined;
  executionLog: Record<string, unknown>;
  availableTickers: string[];
}

export interface LabChartHandle {
  updateCandle: (payload: CandleUpdatePayload) => void;
  setHistory: (candles: CandleData[]) => void;
  resetChart: (clearLayout?: boolean) => void;
  getRecentCandles: (n: number) => CandleData[];
}
