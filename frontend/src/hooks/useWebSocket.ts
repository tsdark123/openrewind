import { useEffect, useRef, useCallback, useState } from 'react';
import type {
  WSEnvelope,
  CandleData,
  CandleUpdatePayload,
  AccountSnapshotPayload,
  OrderFilledPayload,
  PositionClosedPayload,
  SessionStatePayload,
  SessionStartedPayload,
  AppAction,
  Position,
  Order,
} from '../types';
import {
  isOrderAutomated,
  isPositionAutomated,
  markPositionAutomated,
} from '../lib/orion/automatedIds';

// =============================================================================
// useWebSocket — Custom React hook for bidirectional WebSocket communication
// with the OpenRewind C++ engine.
//
// Features:
//   - Connects to ws://127.0.0.1:9000/ws in Tauri, or via Vite proxy at /ws in browser
//   - Exponential backoff reconnection (1s → 2s → 4s → 8s → 16s cap)
//   - Parses incoming JSON envelopes by `type` field
//   - Dispatches typed actions to the app reducer
//   - Exposes send() for outbound commands
//   - Tracks connection status for UI indicator
// =============================================================================

// Connect straight to the engine's WebSocket endpoint. We do not go through
// the Vite proxy because the browser preview may serve the page on a
// different host/port and cannot upgrade the WebSocket handshake itself.
const WS_URL = 'ws://127.0.0.1:9000/ws';

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 16000;
const RECONNECT_MULTIPLIER = 2;

interface UseWebSocketOptions {
  dispatch: React.Dispatch<AppAction>;
  enabled?: boolean;
  onCandleUpdate?: (payload: CandleUpdatePayload) => void;
  onSessionReset?: () => void;
  onSessionHistory?: (candles: CandleData[]) => void;
  onDataSynced?: () => void;
  onDataSyncStarted?: () => void;
  onDataSyncFailed?: (payload: { mode: string; exit_code: number; timestamp: number }) => void;
}

interface UseWebSocketReturn {
  send: (data: Record<string, unknown>) => void;
  connected: boolean;
  reconnecting: boolean;
}

export function useWebSocket({
  dispatch,
  enabled = true,
  onCandleUpdate,
  onSessionReset,
  onSessionHistory,
  onDataSynced,
  onDataSyncStarted,
  onDataSyncFailed,
}: UseWebSocketOptions): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const lastSeqRef = useRef(-1);
  // Keep latest callbacks in refs so handleMessage never goes stale.
  const onCandleUpdateRef = useRef(onCandleUpdate);
  const onSessionResetRef = useRef(onSessionReset);
  const onSessionHistoryRef = useRef(onSessionHistory);
  const onDataSyncedRef = useRef(onDataSynced);
  const onDataSyncStartedRef = useRef(onDataSyncStarted);
  const onDataSyncFailedRef = useRef(onDataSyncFailed);
  onCandleUpdateRef.current = onCandleUpdate;
  onSessionResetRef.current = onSessionReset;
  onSessionHistoryRef.current = onSessionHistory;
  onDataSyncedRef.current = onDataSynced;
  onDataSyncStartedRef.current = onDataSyncStarted;
  onDataSyncFailedRef.current = onDataSyncFailed;

  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const sendQueueRef = useRef<Record<string, unknown>[]>([]);

  const flushSendQueue = useCallback(() => {
    while (
      wsRef.current &&
      wsRef.current.readyState === WebSocket.OPEN &&
      sendQueueRef.current.length > 0
    ) {
      const data = sendQueueRef.current.shift()!;
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const send = useCallback((data: Record<string, unknown>) => {
    const isDev = typeof import.meta.env !== 'undefined' && import.meta.env.DEV;
    const stack = isDev ? new Error().stack : undefined;
    console.log('[Orion Diagnostic] WS out', data, { readyState: wsRef.current?.readyState, ...(stack ? { stack } : {}) });
    sendQueueRef.current.push(data);
    flushSendQueue();
  }, [flushSendQueue]);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      let envelope: WSEnvelope;
      try {
        envelope = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const { type, seq, payload } = envelope;
      console.log('[Orion Diagnostic] WS in', { type, seq, payload });

      // Sequence ordering: discard out-of-order messages.
      if (seq <= lastSeqRef.current) {
        return;
      }
      lastSeqRef.current = seq;

      switch (type) {
        case 'candle_update': {
          const p = payload as CandleUpdatePayload;
          console.log('[Orion Diagnostic] candle_update', { cursor: p.cursor, total: p.total, timestamp: p.timestamp, close: p.close });
          // Fire direct callback first (bypasses React render cycle) so the
          // chart series.update() / setData() runs synchronously on the WS
          // message event before any React re-render can batch/delay it.
          onCandleUpdateRef.current?.(p);
          dispatch({ type: 'CANDLE_UPDATE', payload: p });
          break;
        }

        case 'account_snapshot': {
          const p = payload as AccountSnapshotPayload;
          dispatch({ type: 'ACCOUNT_SNAPSHOT', payload: p });
          break;
        }

        case 'order_filled': {
          const p = payload as OrderFilledPayload;
          // If Orion placed this order (or any order during an active run),
          // stamp the flag before dispatch so the reducer and any downstream
          // consumer see it. Also pin the position id (== order id in this
          // engine) so the corresponding position_closed event carries the
          // same flag.
          if (isOrderAutomated(p.order_id)) {
            (p as OrderFilledPayload).is_automated = true;
            markPositionAutomated(p.order_id);
          }
          dispatch({ type: 'ORDER_FILLED', payload: p });
          break;
        }

        case 'position_closed': {
          const p = payload as PositionClosedPayload;
          if (isPositionAutomated(p.position_id)) {
            (p as PositionClosedPayload).is_automated = true;
          }
          dispatch({ type: 'POSITION_CLOSED', payload: p });
          // Don't clear pending SL/TP - let user manage order panel independently
          break;
        }

        case 'session_started': {
          const p = payload as SessionStartedPayload;
          console.log('[Orion Diagnostic] session_started', { p, hasChart: !!onSessionHistoryRef.current });
          onSessionResetRef.current?.();
          dispatch({ type: 'SESSION_STARTED', payload: p });
          break;
        }

        case 'session_state': {
          const p = payload as SessionStatePayload;
          console.log('[Orion Diagnostic] session_state', { candles: p.candles?.length, openPositions: p.open_positions?.length, pendingOrders: p.pending_orders?.length, hasChart: !!onSessionHistoryRef.current });
          // The engine sends the authoritative bar history here (session
          // start, rewind, seek, timeframe change). Push it straight to the
          // chart so it redraws the whole past timeline via setData().
          if (Array.isArray(p.candles)) {
            onSessionHistoryRef.current?.(p.candles);
          }
          // Preserve the automation flag across state refreshes so chart
          // markers and journal filtering stay consistent.
          if (Array.isArray(p.open_positions)) {
            for (const pos of p.open_positions) {
              (pos as Position).is_automated = isPositionAutomated(pos.id);
            }
          }
          if (Array.isArray(p.pending_orders)) {
            for (const ord of p.pending_orders) {
              (ord as Order).is_automated = isOrderAutomated(ord.id);
            }
          }
          dispatch({ type: 'SESSION_STATE', payload: p });
          break;
        }

        case 'data_synced': {
          onDataSyncedRef.current?.();
          break;
        }

        case 'data_sync_started': {
          onDataSyncStartedRef.current?.();
          break;
        }

        case 'data_sync_failed': {
          const p = payload as { mode: string; exit_code: number; timestamp: number };
          onDataSyncFailedRef.current?.(p);
          break;
        }

        case 'error': {
          const p = payload as { message: string };
          console.warn('[OpenRewind WS] Server error:', p.message);
          break;
        }

        default:
          break;
      }
    },
    [dispatch]
  );

  const connect = useCallback(() => {
    if (!mountedRef.current || !enabled) return;

    // Clean up any existing connection.
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onclose = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      if (
        wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING
      ) {
        wsRef.current.close();
      }
    }

    const ws = new WebSocket(WS_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (!mountedRef.current) return;
      setConnected(true);
      setReconnecting(false);
      reconnectDelayRef.current = INITIAL_RECONNECT_DELAY;
      lastSeqRef.current = -1;
      dispatch({ type: 'SET_CONNECTED', connected: true });
      flushSendQueue();
    };

    ws.onclose = () => {
      if (!mountedRef.current) return;
      setConnected(false);
      dispatch({ type: 'SET_CONNECTED', connected: false });

      // Schedule reconnection with exponential backoff.
      setReconnecting(true);
      const delay = reconnectDelayRef.current;
      reconnectDelayRef.current = Math.min(
        delay * RECONNECT_MULTIPLIER,
        MAX_RECONNECT_DELAY
      );

      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          connect();
        }
      }, delay);
    };

    ws.onerror = () => {
      // onclose will fire after onerror — reconnection handled there.
    };

    ws.onmessage = handleMessage;
  }, [enabled, handleMessage, dispatch, flushSendQueue]);

  useEffect(() => {
    mountedRef.current = true;

    if (enabled) {
      connect();
    }

    return () => {
      mountedRef.current = false;

      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }

      if (wsRef.current) {
        wsRef.current.onopen = null;
        wsRef.current.onclose = null;
        wsRef.current.onmessage = null;
        wsRef.current.onerror = null;
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect, enabled]);

  return { send, connected, reconnecting };
}
