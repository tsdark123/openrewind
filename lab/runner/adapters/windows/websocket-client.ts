/**
 * Headless WebSocket client for the OpenRewind engine.
 */

import type {
  AppAction,
  CandleData,
  CandleUpdatePayload,
  AccountSnapshotPayload,
  OrderFilledPayload,
  PositionClosedPayload,
  SessionStartedPayload,
  SessionStatePayload,
  WSEnvelope,
} from './types';

export interface EngineWebSocketClient {
  send: (payload: Record<string, unknown>) => void;
  connected: () => boolean;
  close: () => void;
}

interface EngineWebSocketClientOptions {
  url: string;
  dispatch: (action: AppAction) => void;
  onSessionHistory?: (candles: CandleData[]) => void;
  onCandleUpdate?: (payload: CandleUpdatePayload) => void;
}

export function createEngineWebSocketClient(opts: EngineWebSocketClientOptions): EngineWebSocketClient {
  let ws: WebSocket | null = null;
  let lastSeq = -1;
  const messageQueue: Record<string, unknown>[] = [];
  let closing = false;

  function flushQueue() {
    while (ws && ws.readyState === WebSocket.OPEN && messageQueue.length > 0) {
      const data = messageQueue.shift()!;
      ws.send(JSON.stringify(data));
    }
  }

  function connect() {
    if (closing) return;
    ws = new WebSocket(opts.url);

    ws.onopen = () => {
      flushQueue();
    };

    ws.onmessage = (event: MessageEvent) => {

      let envelope: WSEnvelope;
      try {
        envelope = JSON.parse(event.data as string) as WSEnvelope;
      } catch {
        return;
      }

      const { type, seq, payload } = envelope;
      if (typeof seq === 'number' && seq <= lastSeq) {
        return;
      }
      if (typeof seq === 'number') {
        lastSeq = seq;
      }

      switch (type) {
        case 'candle_update': {
          const p = payload as CandleUpdatePayload;
          opts.onCandleUpdate?.(p);
          opts.dispatch({ type: 'CANDLE_UPDATE', payload: p });
          break;
        }

        case 'account_snapshot': {
          const p = payload as AccountSnapshotPayload;
          opts.dispatch({ type: 'ACCOUNT_SNAPSHOT', payload: p });
          break;
        }

        case 'order_filled': {
          const p = payload as OrderFilledPayload;
          opts.dispatch({ type: 'ORDER_FILLED', payload: p });
          break;
        }

        case 'position_closed': {
          const p = payload as PositionClosedPayload;
          opts.dispatch({ type: 'POSITION_CLOSED', payload: p });
          break;
        }

        case 'session_started': {
          const p = payload as SessionStartedPayload;
          opts.dispatch({ type: 'SESSION_STARTED', payload: p });
          break;
        }

        case 'session_state': {
          const p = payload as SessionStatePayload;
          if (Array.isArray(p.candles)) {
            opts.onSessionHistory?.(p.candles);
          }
          opts.dispatch({ type: 'SESSION_STATE', payload: p });
          break;
        }

        case 'data_synced':
        case 'data_sync_started':
        case 'data_sync_failed':
        case 'error':
          break;
      }
    };

    ws.onerror = () => {
      // ignored
    };

    ws.onclose = () => {
      ws = null;
    };
  }

  connect();

  return {
    send(payload) {
      messageQueue.push(payload);
      flushQueue();
    },

    connected() {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },

    close() {
      closing = true;
      if (ws) {
        ws.close();
        ws = null;
      }
    },
  };
}
