// =============================================================================
// controller — The Orion Automation Driver ("TeamViewer" engine).
//
// Life-cycle of an autonomous task, exactly as spec'd:
//
//   1. Capture Snapshot   — record the user's current symbol/date/timeframe
//                           /cursor/speed/openPositions so we can restore
//                           the workspace verbatim at the end.
//   2. Lock the UI        — flip controller status to 'driving' so the
//                           <OrionDrivingOverlay/> mounts a transparent
//                           pointer-events blocker with a pulsing #ff3700
//                           inset ring and an Esc-to-stop pill.
//   3. Foreground Execute — run the queued tool calls sequentially via the
//                           same WS `send()` and REST endpoints the human
//                           uses. Every place_order stamps `is_automated`
//                           in the frontend-only tracker so downstream
//                           journal writes exclude Orion's trades.
//   4. Isolate            — journal.ts::endSession filters `is_automated`
//                           trades out of the persisted log. Chart markers
//                           can style them distinctly in a future PR.
//   5. Restore & Report   — pause playback, close any positions Orion
//                           opened, POST /api/session/start with the
//                           captured symbol/date, re-apply indicators &
//                           timeframe & speed, then append a markdown
//                           result card to the current Orion chat thread.
//
// The controller is a module-level singleton exposed via `orionController`.
// App.tsx binds it once with the runtime bridge it needs (send, dispatch,
// chartRef, snapshot builder). Consumers (ai-chat, dev tools) then call
// `orionController.runAgentTask(userMessage)` without threading refs
// through their own props.
// =============================================================================

import type { AppAction, AppState, Position, Order } from '../../types';
import type { ChartHandle } from '../../components/Chart';
import { clearAutomatedIds, setAutomationActive } from './automatedIds';
import { orionChat, type OrionChatMessage, AGENT_KEEP_ALIVE, releaseAgentModel } from './client';
import { invokeOrionTool, listOrionTools, ollamaToolSchemas, type OrionRuntimeContext } from './tools';
import { buildWorldState, renderWorldStateForPrompt } from './worldState';
import { loadOrionThreads } from '../orionThreads';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export type OrionControllerStatus = 'idle' | 'planning' | 'driving' | 'finalizing';

export interface SessionSnapshot {
  symbol: string;
  date: string;
  timeframe: number;
  cursor: number;
  speed: number;
  isPlaying: boolean;
  direction: 'forward' | 'backward';
  balance: number;
  indicators: AppState['indicators'];
  openPositions: Position[];
  pendingOrders: Order[];
  capturedAt: number;
}

export interface ActivityEvent {
  at: number;
  kind: 'info' | 'tool' | 'error';
  message: string;
}

export interface OrionControllerBridge {
  getState: () => AppState;
  getChartHandle: () => ChartHandle | null;
  send: (cmd: Record<string, unknown>) => void;
  dispatch: (action: AppAction) => void;
  apiBase: string;
  /**
   * Appends a text message to the currently-active Orion chat thread.
   * The controller uses this to publish "Orion is planning…", the plan
   * card, and the final result markdown. The sidepanel owns the thread
   * key resolution so we don't duplicate it here.
   */
  postChatMessage: (text: string) => Promise<void>;
}

export interface RunAgentTaskResult {
  ok: boolean;
  reason?: string;
}

// -----------------------------------------------------------------------------
// Singleton
// -----------------------------------------------------------------------------

type Listener = () => void;

class OrionControllerImpl {
  status: OrionControllerStatus = 'idle';
  activity: ActivityEvent[] = [];
  snapshot: SessionSnapshot | null = null;

  private bridge: OrionControllerBridge | null = null;
  private cancelRequested = false;
  private listeners = new Set<Listener>();

  bind(bridge: OrionControllerBridge): void {
    this.bridge = bridge;
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  private log(kind: ActivityEvent['kind'], message: string): void {
    this.activity = [...this.activity, { at: Date.now(), kind, message }];
    this.notify();
  }

  private setStatus(s: OrionControllerStatus): void {
    this.status = s;
    this.notify();
  }

  cancel(): void {
    if (this.status === 'idle') return;
    this.cancelRequested = true;
    this.log('info', 'Cancel requested by user.');
  }

  // ---------------------------------------------------------------------------
  // System prompt
  // ---------------------------------------------------------------------------

  private buildSystemPrompt(ctx: OrionRuntimeContext): string {
    const ws = buildWorldState(ctx.state, ctx.chartRef, ctx.performanceLog);
    const tools = listOrionTools('driving')
      .map((t) => `${t.name}: ${t.description}`)
      .join('\n');
    return [
      'You are Orion, the autonomous agent for OpenRewind. You have access to these tools:',
      '',
      tools,
      '',
      'Current workspace state:',
      renderWorldStateForPrompt(ws),
      '',
      'Rules:',
      '1. Use getWorldState whenever you need current account, positions, or session context.',
      '2. Use getCandles to load historical candles; it automatically tries nearby weekdays if the date is missing.',
      '3. Use runStrategy to backtest a strategy before trading it. End-condition guardrails are enforced automatically.',
      '4. Use setSession to switch symbol/date, placeOrder to open a trade, and closePosition to close one.',
      '5. When you have enough information, answer without tool calls and summarize concisely.',
    ].join('\n');
  }

  // ---------------------------------------------------------------------------
  // Snapshot / restore
  // ---------------------------------------------------------------------------

  captureSnapshot(): SessionSnapshot {
    if (!this.bridge) throw new Error('OrionController not bound');
    const s = this.bridge.getState();
    const snap: SessionSnapshot = {
      symbol: s.symbol,
      date: s.replayDate,
      timeframe: s.timeframe,
      cursor: s.cursor,
      speed: s.speed,
      isPlaying: s.isPlaying,
      direction: s.playbackDirection,
      balance: s.balance,
      indicators: { ...s.indicators },
      openPositions: [...s.openPositions],
      pendingOrders: [...s.pendingOrders],
      capturedAt: Date.now(),
    };
    this.snapshot = snap;
    return snap;
  }

  async restoreSnapshot(snap: SessionSnapshot): Promise<void> {
    if (!this.bridge) throw new Error('OrionController not bound');
    const { send, dispatch, apiBase } = this.bridge;

    // Halt anything Orion left running before we mutate the session.
    send({ cmd: 'pause' });
    dispatch({ type: 'SET_PLAYING', isPlaying: false });

    // Close any positions Orion opened. Since automated trades are tracked
    // by id in the frontend tracker, restore semantics are simple: close
    // every currently-open position, then let the reducer flush.
    const openNow = this.bridge.getState().openPositions;
    if (openNow.length > 0) {
      for (const p of openNow) {
        send({ cmd: 'close_position', position_id: p.id });
      }
      // Wait for the position_closed/session_state events to propagate
      // through the websocket handler so is_automated flags are stamped
      // before we restore the original session.
      await new Promise<void>((resolve) => {
        let elapsed = 0;
        const interval = setInterval(() => {
          elapsed += 100;
          if (this.bridge && this.bridge.getState().openPositions.length === 0) {
            clearInterval(interval);
            resolve();
          }
          if (elapsed >= 3000) {
            clearInterval(interval);
            resolve();
          }
        }, 100);
      });
    }

    // Restore the original session context if it differs. Reuse the same
    // POST /api/session/start path the Toolbar's date picker uses so the
    // engine wipes and reseeds candles identically to a manual switch.
    if (snap.symbol && snap.date) {
      try {
        await fetch(`${apiBase}/api/session/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: snap.symbol,
            starting_balance: snap.balance > 0 ? snap.balance : 100000,
            start_date: snap.date,
          }),
        });
      } catch (e) {
        this.log('error', `Session restore failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Re-apply toggles the reducer owns. Timeframe/speed/indicators live in
    // React state, not the engine, so we dispatch actions directly.
    if (snap.timeframe !== this.bridge.getState().timeframe) {
      send({ cmd: 'set_timeframe', minutes: snap.timeframe });
      dispatch({ type: 'SET_TIMEFRAME', timeframe: snap.timeframe });
    }
    if (snap.speed !== this.bridge.getState().speed) {
      send({ cmd: 'set_speed', speed: snap.speed });
      dispatch({ type: 'SET_SPEED', speed: snap.speed });
    }
    const currentInd = this.bridge.getState().indicators;
    for (const key of Object.keys(snap.indicators) as Array<keyof AppState['indicators']>) {
      if (currentInd[key] !== snap.indicators[key]) {
        dispatch({ type: 'TOGGLE_INDICATOR', indicator: key });
      }
    }

    clearAutomatedIds();
    this.snapshot = null;
  }

  // ---------------------------------------------------------------------------
  // Top-level entry point — PR-4 ships the plumbing; PR-5 wires the LLM plan.
  // ---------------------------------------------------------------------------

  async runAgentTask(userMessage: string): Promise<RunAgentTaskResult> {
    if (!this.bridge) return { ok: false, reason: 'controller-not-bound' };
    if (this.status !== 'idle') return { ok: false, reason: 'busy' };

    this.cancelRequested = false;
    this.activity = [];
    this.log('info', `Task received: ${userMessage.slice(0, 120)}`);

    let snap: SessionSnapshot | null = null;
    try {
      this.setStatus('planning');
      setAutomationActive(true);
      snap = this.captureSnapshot();
      this.log('info', `Snapshot captured (${snap.symbol || 'no symbol'} ${snap.date || ''}).`);

      const threads = await loadOrionThreads();
      const ctx: OrionRuntimeContext = {
        mode: 'driving',
        state: this.bridge.getState(),
        chartRef: { current: this.bridge.getChartHandle() },
        performanceLog: this.bridge.getState().performanceLog,
        threads,
        apiBase: this.bridge.apiBase,
        send: this.bridge.send,
        dispatch: this.bridge.dispatch,
        getState: () => this.bridge!.getState(),
        postChatMessage: this.bridge.postChatMessage,
        restoreSnapshot: async () => {
          if (this.snapshot) {
            await this.restoreSnapshot(this.snapshot);
          }
        },
      };

      this.setStatus('driving');
      this.log('info', 'UI locked. Orion is driving.');

      const messages: OrionChatMessage[] = [
        { role: 'system', content: this.buildSystemPrompt(ctx) },
        { role: 'user', content: userMessage },
      ];

      const maxIterations = 8;
      for (let iter = 0; iter < maxIterations; iter++) {
        if (this.cancelRequested) throw new Error('cancelled');

        // Keep the context fresh across the loop so tools see the latest
        // WS-updated state after placeOrder / setSession calls.
        ctx.state = this.bridge.getState();
        ctx.performanceLog = ctx.state.performanceLog;

        const response = await orionChat({
          tier: 'agent',
          messages,
          tools: ollamaToolSchemas('driving'),
          keepAlive: AGENT_KEEP_ALIVE,
        });

        if (response.toolCalls.length === 0) {
          if (response.content) {
            await this.bridge.postChatMessage(response.content);
          }
          break;
        }

        messages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: response.toolCalls,
        });

        for (const tc of response.toolCalls) {
          if (this.cancelRequested) throw new Error('cancelled');
          const name = tc.function.name;
          let args: Record<string, unknown> = {};
          if (typeof tc.function.arguments === 'string') {
            try {
              args = JSON.parse(tc.function.arguments);
            } catch {
              args = {};
            }
          } else if (tc.function.arguments && typeof tc.function.arguments === 'object') {
            args = tc.function.arguments as Record<string, unknown>;
          }

          this.log('tool', `${name}(${JSON.stringify(args).slice(0, 120)})`);
          const result = await invokeOrionTool(name, args, ctx);
          messages.push({
            role: 'tool',
            name,
            tool_name: name,
            content: JSON.stringify(result),
          });
        }
      }

      this.setStatus('finalizing');
      if (this.snapshot) {
        await this.restoreSnapshot(this.snapshot);
      }
      this.log('info', 'Snapshot restored. Session returned to prior state.');

      // Free the 8B model from RAM after a task completes.
      void releaseAgentModel();

      this.setStatus('idle');
      return { ok: true };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      this.log('error', `Task failed: ${reason}`);
      if (this.snapshot) {
        try {
          await this.restoreSnapshot(this.snapshot);
        } catch {
          /* best effort — user can manually restart */
        }
      }
      if (reason !== 'cancelled') {
        await this.bridge?.postChatMessage(`Orion task failed: ${reason}`).catch(() => {});
      }
      this.setStatus('idle');
      return { ok: false, reason };
    } finally {
      setAutomationActive(false);
    }
  }
}

export const orionController = new OrionControllerImpl();

// Expose a global for developer testing without a full ai-chat round trip:
// > window.orionController.runAgentTask('go to AAPL 2026-07-13')
if (typeof window !== 'undefined') {
  (window as unknown as { orionController: OrionControllerImpl }).orionController = orionController;
}
