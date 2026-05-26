import { useEffect, useRef, useCallback, useState } from 'react';
import type {
  WSEnvelope,
  CandleUpdatePayload,
  AccountSnapshotPayload,
  OrderFilledPayload,
  PositionClosedPayload,
  SessionStatePayload,
  SessionStartedPayload,
  AppAction,
} from '../types';

// =============================================================================
// useWebSocket — Custom React hook for bidirectional WebSocket communication
// with the OpenReplay C++ engine.
//
// Features:
//   - Connects to ws://localhost:9000/ws on mount (via Vite proxy at /ws)
//   - Exponential backoff reconnection (1s → 2s → 4s → 8s → 16s cap)
//   - Parses incoming JSON envelopes by `type` field
//   - Dispatches typed actions to the app reducer
//   - Exposes send() for outbound commands
//   - Tracks connection status for UI indicator
// =============================================================================

const WS_URL = `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/ws`;

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 16000;
const RECONNECT_MULTIPLIER = 2;

interface UseWebSocketOptions {
  dispatch: React.Dispatch<AppAction>;
  enabled?: boolean;
}

interface UseWebSocketReturn {
  send: (data: Record<string, unknown>) => void;
  connected: boolean;
  reconnecting: boolean;
}

export function useWebSocket({
  dispatch,
  enabled = true,
}: UseWebSocketOptions): UseWebSocketReturn {
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectDelayRef = useRef(INITIAL_RECONNECT_DELAY);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);
  const lastSeqRef = useRef(-1);

  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);

  const send = useCallback((data: Record<string, unknown>) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      let envelope: WSEnvelope;
      try {
        envelope = JSON.parse(event.data as string);
      } catch {
        return;
      }

      const { type, seq, payload } = envelope;

      // Sequence ordering: discard out-of-order messages.
      if (seq <= lastSeqRef.current) {
        return;
      }
      lastSeqRef.current = seq;

      switch (type) {
        case 'candle_update': {
          const p = payload as CandleUpdatePayload;
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
          dispatch({ type: 'ORDER_FILLED', payload: p });
          break;
        }

        case 'position_closed': {
          const p = payload as PositionClosedPayload;
          dispatch({ type: 'POSITION_CLOSED', payload: p });
          // Don't clear pending SL/TP - let user manage order panel independently
          break;
        }

        case 'session_started': {
          const p = payload as SessionStartedPayload;
          dispatch({ type: 'SESSION_STARTED', payload: p });
          break;
        }

        case 'session_state': {
          const p = payload as SessionStatePayload;
          dispatch({ type: 'SESSION_STATE', payload: p });
          break;
        }

        case 'error': {
          const p = payload as { message: string };
          console.warn('[OpenReplay WS] Server error:', p.message);
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
  }, [enabled, handleMessage, dispatch]);

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
