import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Terminal, RefreshCw, Download, AlertCircle, PlayCircle } from 'lucide-react';
import { CoreSpinLoader } from './core-spin-loader';
import { cn } from '../../lib/utils';
import {
  useOrionStartup,
  retryOrionStartup,
  pullSelectedModelWithConsent,
  installOllamaWithConsent,
  continueDeterministicOrion,
} from '../../lib/orion/startupState';
import { handleOrionMessage } from '../../lib/orion/agent/orchestrator';
import type { AgentContext, AgentExecutionResult, ExecutionContextStore } from '../../lib/orion/agent/types';
import {
  DEFAULT_GREETING,
  GLOBAL_THREAD_KEY,
  appendMessage,
  getThreadMessages,
  loadOrionThreads,
  setThreadMessages,
  writeOrionThreads,
  type ChatMessage,
  type OrionThreads,
} from '../../lib/orionThreads';
import type { AppAction, AppState, PerformanceLog } from '../../types';
import type { ChartHandle } from '../Chart';



const WELCOME_TEXT = `[SYSTEM INITIALIZED] - Orion Terminal v1.0

Welcome to OpenRewind. I am Orion, your private risk supervisor.
Type 'help' to see available commands.`;

const HELP_TEXT = `[AVAILABLE COMMANDS]

- Ask me anything: "What did I do wrong on that trade?" or "Analyze my session"
- Chart control: "switch to <SYMBOL>" / "go to <DATE>" / "play" / "pause" / "reset"
- Timeframe: "5m" / "15m" / "1h" / "4h" / "daily" (also "AAPL 5m" or "switch to AAPL daily")
- Type 'help' to see this message
- Type 'clear' to reset the terminal`;

const PROMPT = 'user@openrewind:~$';

interface OrionTerminalProps {
  className?: string;
  performanceLog: PerformanceLog;
  lightMode?: boolean;
  appState: AppState;
  chartRef: { current: ChartHandle | null } | null;
  apiBase: string;
  dataDir?: string;
  availableTickers: string[];
  onSwitchSymbol: (symbol: string, date?: string) => void | Promise<void>;
  send: (payload: Record<string, unknown>) => void;
  dispatch: (action: AppAction) => void;
  executionLog: ExecutionContextStore;
}

export function OrionTerminal({
  className,
  performanceLog,
  lightMode = false,
  appState,
  chartRef,
  apiBase,
  dataDir,
  availableTickers,
  onSwitchSymbol,
  send,
  dispatch,
  executionLog,
}: OrionTerminalProps) {
  const threadKey = GLOBAL_THREAD_KEY;

  const [threads, setThreads] = useState<OrionThreads>({});
  const [threadsLoaded, setThreadsLoaded] = useState(false);

  const messages = useMemo<ChatMessage[]>(
    () => getThreadMessages(threads, threadKey),
    [threads]
  );

  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const startup = useOrionStartup();
  const historyIndexRef = useRef(-1);

  // Authoritative-run ownership. Only the latest runId may append output,
  // clear isTyping, or update the pending abort controller.
  const runIdRef = useRef(0);
  const latestRunIdRef = useRef(0);
  const pendingControllerRef = useRef<{ runId: number; controller: AbortController } | null>(null);

  const isAuthoritative = (runId: number) => latestRunIdRef.current === runId;

  const releasePending = (runId: number) => {
    if (pendingControllerRef.current?.runId === runId) {
      pendingControllerRef.current = null;
    }
  };

  const clearTypingIfAuthoritative = (runId: number) => {
    if (isAuthoritative(runId)) {
      setIsTyping(false);
    }
  };

  // Cancel the active terminal request on unmount.
  useEffect(() => {
    return () => {
      pendingControllerRef.current?.controller.abort();
    };
  }, []);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const appStateRef = useRef(appState);
  const lastResultRef = useRef<AgentExecutionResult | undefined>(undefined);
  useEffect(() => {
    appStateRef.current = appState;
  }, [appState]);

  useEffect(() => {
    let cancelled = false;
    loadOrionThreads().then((loaded) => {
      if (cancelled) return;
      setThreads(loaded);
      setThreadsLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);


  useEffect(() => {
    if (!threadsLoaded) return;
    void writeOrionThreads(threads);
  }, [threads, threadsLoaded]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isTyping]);

  const userMessages = useMemo(
    () => messages.filter((m) => m.sender === 'user').map((m) => m.text),
    [messages]
  );

  const handleResetChat = () => {
    // Reset only the chat thread UI; the App-owned execution log is durable
    // across side-panel open/close and must not be cleared here.
    setThreads((prev) => setThreadMessages(prev, threadKey, [DEFAULT_GREETING]));
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed) return;

    // Start a new authoritative run. A newer prompt can supersede an
    // in-flight one; the old run will discover it is no longer authoritative
    // and silently clean up.
    const runId = ++runIdRef.current;
    latestRunIdRef.current = runId;

    pendingControllerRef.current?.controller.abort();

    const controller = new AbortController();
    pendingControllerRef.current = { runId, controller };

    const userMessage: ChatMessage = { sender: 'user', text: trimmed };
    const nextMessages = [...messages, userMessage];
    setThreads((prev) => setThreadMessages(prev, threadKey, nextMessages));
    setInput('');
    historyIndexRef.current = -1;
    setIsTyping(true);

    const ownedAppend = (text: string) => {
      if (isAuthoritative(runId)) {
        setThreads((prev) => appendMessage(prev, threadKey, { sender: 'ai', text }));
      }
    };

    const ownedAppendError = (text: string) => {
      if (isAuthoritative(runId)) {
        setThreads((prev) => appendMessage(prev, threadKey, { sender: 'ai', text }));
      }
    };

    const cleanup = (clearSpinner = true) => {
      releasePending(runId);
      if (clearSpinner) {
        clearTypingIfAuthoritative(runId);
      }
    };

    const agentCtx: AgentContext = {
      getState: () => appStateRef.current,
      chartRef,
      performanceLog,
      apiBase,
      dataDir,
      availableTickers,
      send,
      dispatch,
      onSwitchSymbol,
      lastResult: lastResultRef.current,
      executionLog,
    };

    try {
      const outcome = await handleOrionMessage({
        text: trimmed,
        ctx: agentCtx,
        setupReady: startup.stage === 'ready',
        signal: controller.signal,
      });
      if (isAuthoritative(runId)) {
        lastResultRef.current = outcome.result ?? undefined;
        console.log('[orion-trace] orchestrator result:', outcome);
        if (outcome.route !== 'aborted') {
          if (outcome.message) {
            ownedAppend(outcome.message);
          } else if (outcome.route === 'error' && !outcome.ok) {
            ownedAppendError('Orion could not process that request.');
          }
        }
      }
    } catch (err) {
      const code = (err as { code?: string }).code;
      const detail = err instanceof Error ? err.message : String(err);
      if (code !== 'ABORTED') {
        ownedAppendError(`Orion couldn't run that: ${detail}`);
      }
    } finally {
      cleanup();
    }
  };

  const handleTerminalSubmit = () => {
    const lower = input.trim().toLowerCase();
    if (!lower) return;

    if (lower === 'clear') {
      handleResetChat();
      setInput('');
      historyIndexRef.current = -1;
      return;
    }

    if (lower === 'help' || lower === '?') {
      const trimmed = input.trim();
      setThreads((prev) => appendMessage(prev, threadKey, { sender: 'user', text: trimmed }));
      setThreads((prev) => appendMessage(prev, threadKey, { sender: 'ai', text: HELP_TEXT }));
      setInput('');
      historyIndexRef.current = -1;
      return;
    }

    void handleSend();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleTerminalSubmit();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (userMessages.length === 0) return;
      const upNext = Math.min(historyIndexRef.current + 1, userMessages.length - 1);
      historyIndexRef.current = upNext;
      setInput(userMessages[userMessages.length - 1 - upNext]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      const downNext = Math.max(historyIndexRef.current - 1, -1);
      historyIndexRef.current = downNext;
      setInput(downNext === -1 ? '' : userMessages[userMessages.length - 1 - downNext]);
    }
  };

  const displayText = (msg: ChatMessage) => {
    if (msg.sender === 'ai' && msg.text === DEFAULT_GREETING.text) {
      return WELCOME_TEXT;
    }
    return msg.text;
  };

  const renderOutput = (output: string) => {
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const emailRegex = /([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

    let parts: string[] = [];
    output.split(urlRegex).forEach((part) => {
      if (urlRegex.test(part)) {
        parts.push(part);
      } else {
        parts.push(...part.split(emailRegex));
      }
    });

    return parts.map((part, index) => {
      if (urlRegex.test(part)) {
        return (
          <a
            key={index}
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[#3b6fff] hover:underline hover:text-[#3b6fff]/80 transition-colors"
          >
            {part}
          </a>
        );
      } else if (emailRegex.test(part)) {
        return (
          <a key={index} href={`mailto:${part}`} className="text-[#3b6fff] hover:underline hover:text-[#3b6fff]/80 transition-colors">
            {part}
          </a>
        );
      }
      return <span key={index}>{part}</span>;
    });
  };

  return (
    <motion.aside
      initial={{ x: 20, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      className={cn(
        'relative flex w-[26rem] flex-shrink-0 flex-col border-l',
        lightMode ? 'bg-white border-gray-200' : 'bg-orion-terminal border-[#2a2e39]',
        className
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'flex items-center gap-2 border-b px-3 py-2.5',
          lightMode ? 'border-gray-200 bg-white' : 'border-[#2a2e39] bg-orion-terminal'
        )}
      >
        <Terminal className={cn('h-4 w-4 text-[#3b6fff]')} />
        <span className={cn('text-sm font-semibold font-mono', lightMode ? 'text-gray-900' : 'text-[#d1d4dc]')}>
          orion@openrewind
        </span>

        <span className={cn('ml-auto text-[10px] font-medium', lightMode ? 'text-gray-500' : 'text-[#787b86]')}>
          {startup.stage === 'ready'
            ? 'ready'
            : startup.stage === 'deterministic_only'
              ? 'deterministic'
              : startup.stage === 'checking_runtime' ||
                  startup.stage === 'checking_model' ||
                  startup.stage === 'pulling_model' ||
                  startup.stage === 'warming_model'
                ? 'loading…'
                : 'offline'}
        </span>
      </div>

      {/* Terminal output */}
      <div
        ref={scrollRef}
        onClick={() => inputRef.current?.focus()}
        className={cn(
          'relative flex-1 overflow-y-auto p-4 font-mono text-xs cursor-text',
          lightMode ? 'bg-[#f8f9fa] text-gray-900' : 'bg-orion-terminal text-[#d1d4dc]'
        )}
        style={{ scrollbarWidth: 'thin', scrollbarColor: lightMode ? '#d1d5db #f3f4f6' : '#3b6fff #1f2937' }}
      >
        <div className="space-y-3">
          {messages.map((msg, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.1 }}
              className="space-y-1"
            >
              {msg.sender === 'user' && (
                <div className="flex gap-2">
                  <span className="text-[#3b6fff] font-semibold">{PROMPT}</span>
                  <span className={cn(lightMode ? 'text-gray-900' : 'text-white')}>{msg.text}</span>
                </div>
              )}
              {msg.sender === 'ai' && (
                <div
                  className={cn(
                    'whitespace-pre-wrap leading-relaxed',
                    lightMode ? 'text-gray-700' : 'text-gray-300'
                  )}
                >
                  {renderOutput(displayText(msg))}
                </div>
              )}
            </motion.div>
          ))}

          {isTyping && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              className="text-[#3b6fff] font-semibold"
            >
              orion&gt;{' '}
              <span className="inline-flex gap-1 text-[#d1d4dc]">
                <span className="animate-bounce">.</span>
                <span className="animate-bounce [animation-delay:0.1s]">.</span>
                <span className="animate-bounce [animation-delay:0.2s]">.</span>
              </span>
            </motion.div>
          )}

          {/* Active input line */}
          <div className="flex gap-2 items-center">
            <span className="text-[#3b6fff] font-semibold">{PROMPT}</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Orion or type help"
              className={cn(
                'flex-1 bg-transparent outline-none caret-[#3b6fff]',
                lightMode ? 'text-gray-900 placeholder:text-gray-400' : 'text-white placeholder:text-[#787b86]'
              )}
              autoFocus
              spellCheck="false"
            />
            <button
              type="button"
              onClick={handleTerminalSubmit}
              disabled={!input.trim()}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded transition-colors',
                input.trim() && !isTyping ? 'text-[#3b6fff] hover:bg-[#3b6fff]/10' : 'text-[#787b86]'
              )}
            >
              <Send className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div ref={bottomRef} />
      </div>

      {/* Footer */}
      <div
        className={cn(
          'px-4 py-2 text-[10px] font-mono border-t',
          lightMode ? 'bg-white border-gray-200 text-gray-500' : 'bg-orion-terminal border-[#2a2e39] text-[#787b86]'
        )}
      >
        <div className="flex justify-between items-center">
          <span>
            {startup.activeModelName}
            {startup.stage !== 'idle' && (
              <span className={cn('ml-2', startup.stage === 'ready' ? 'text-[#3b6fff]' : '')}>
                {startup.stage === 'ready' ? '● ready' : `● ${startup.stage.replace(/_/g, ' ')}`}
              </span>
            )}
          </span>
          <span>Type a command or question • ↑/↓ for history</span>
        </div>
      </div>

      <AnimatePresence>
        {startup.stage !== 'ready' && startup.stage !== 'deterministic_only' && (
          <motion.div
            key="boot"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: 'easeInOut' }}
            className={cn(
              'absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 p-6',
              lightMode ? 'bg-[#f8f9fa]' : 'bg-[#0c0c0c]'
            )}
          >
            {startup.stage === 'runtime_missing' ||
            startup.stage === 'model_missing' ||
            startup.stage === 'warmup_failed' ||
            startup.stage === 'download_failed' ? (
              <div className="flex flex-col items-center gap-3 max-w-[90%] text-center">
                <AlertCircle className="h-6 w-6 text-[#3b6fff]" />
                <div className={cn('text-xs font-mono uppercase tracking-widest', lightMode ? 'text-gray-900' : 'text-[#d1d4dc]')}>
                  {startup.stage === 'runtime_missing' ? 'Ollama runtime missing' : `${startup.activeModelName} not ready`}
                </div>
                <div className={cn('text-[10px] font-mono leading-relaxed max-w-[260px]', lightMode ? 'text-gray-600' : 'text-[#787b86]')}>
                  {startup.error || startup.status || 'Orion could not start.'}
                </div>
                {startup.stage === 'model_missing' && startup.canPull && (
                  <div className="text-[10px] font-mono leading-relaxed max-w-[260px] text-[#3b6fff]">
                    This is a large local download (~5.6 GB for qwen3:8b).
                  </div>
                )}
                {startup.stage === 'runtime_missing' && startup.canInstallOllama && (
                  <div className="text-[10px] font-mono leading-relaxed max-w-[260px] text-[#3b6fff]">
                    Ollama is a large local download and install.
                  </div>
                )}
                <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
                  {startup.canRetry && (
                    <button
                      type="button"
                      onClick={() => retryOrionStartup()}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors',
                        lightMode
                          ? 'border-gray-300 text-gray-700 hover:bg-gray-100'
                          : 'border-[#2a2e39] text-[#d1d4dc] hover:bg-[#1a1a1a]'
                      )}
                    >
                      <RefreshCw className="h-3 w-3" />
                      Retry
                    </button>
                  )}
                  {startup.canPull && (
                    <button
                      type="button"
                      onClick={() => pullSelectedModelWithConsent()}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors',
                        lightMode
                          ? 'border-[#3b6fff] text-[#3b6fff] hover:bg-[#3b6fff]/10'
                          : 'border-[#3b6fff] text-[#3b6fff] hover:bg-[#3b6fff]/10'
                      )}
                    >
                      <Download className="h-3 w-3" />
                      Pull {startup.activeModelName}
                    </button>
                  )}
                  {startup.canInstallOllama && (
                    <button
                      type="button"
                      onClick={() => installOllamaWithConsent()}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors',
                        lightMode
                          ? 'border-[#3b6fff] text-[#3b6fff] hover:bg-[#3b6fff]/10'
                          : 'border-[#3b6fff] text-[#3b6fff] hover:bg-[#3b6fff]/10'
                      )}
                    >
                      <Download className="h-3 w-3" />
                      Install Ollama
                    </button>
                  )}
                  {startup.canContinueDeterministic && (
                    <button
                      type="button"
                      onClick={() => continueDeterministicOrion()}
                      className={cn(
                        'flex items-center gap-1.5 px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors',
                        lightMode
                          ? 'border-gray-300 text-gray-700 hover:bg-gray-100'
                          : 'border-[#2a2e39] text-[#d1d4dc] hover:bg-[#1a1a1a]'
                      )}
                    >
                      <PlayCircle className="h-3 w-3" />
                      Continue without
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <>
                <CoreSpinLoader />
                <div className={cn('text-[10px] font-mono text-center max-w-[260px]', lightMode ? 'text-gray-500' : 'text-[#787b86]')}>
                  {startup.status || 'Starting Orion...'}
                </div>
                {startup.progress >= 0 && (
                  <div className={cn('text-[10px] font-mono', lightMode ? 'text-gray-500' : 'text-[#787b86]')}>
                    {startup.progress}%
                  </div>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.aside>
  );
}
