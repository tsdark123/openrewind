import { useEffect, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Send, Terminal } from 'lucide-react';
import { CoreSpinLoader } from './core-spin-loader';
import { cn } from '../../lib/utils';
import { ensureModel, pullOrionModel } from '../../lib/orion/client';
import { handleOrionMessage } from '../../lib/orion/agent/orchestrator';
import type { AgentContext, AgentExecutionResult } from '../../lib/orion/agent/types';
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

const ORION_MODEL = 'llama3.2';

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
  const [bootStatus, setBootStatus] = useState('Initializing...');
  const [bootProgress, setBootProgress] = useState(0);
  const [bootKey, setBootKey] = useState(0);
  const historyIndexRef = useRef(-1);
  const bootAttemptIdRef = useRef(0);

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

  const [setupStage, setSetupStage] = useState<'idle' | 'pulling' | 'ready' | 'error'>('idle');

  useEffect(() => {
    console.log('[orion-terminal] setupStage:', setupStage);
  }, [setupStage]);

  useEffect(() => {
    const startOrionBoot = async () => {
      bootAttemptIdRef.current += 1;
      const attemptId = bootAttemptIdRef.current;
      console.log('[orion-terminal] boot attempt', attemptId, 'started');
      setSetupStage('pulling');
      setBootStatus(`Checking ${ORION_MODEL}...`);
      setBootProgress(0);

      try {
        const check = await ensureModel(ORION_MODEL);
        console.log('[orion-terminal] boot attempt', attemptId, 'ensureModel result:', check);

        if (attemptId !== bootAttemptIdRef.current) {
          console.log('[orion-terminal] boot attempt', attemptId, 'ignored (stale)');
          return;
        }

        console.log('[orion-terminal] boot attempt', attemptId, 'accepted');
        if (check.ready) {
          setSetupStage('ready');
          return;
        }

        if (check.error === 'model-missing') {
          setBootStatus(`Pulling ${ORION_MODEL}...`);
          try {
            await pullOrionModel(ORION_MODEL, (pct, status) => {
              if (pct >= 0) setBootProgress(pct);
              setBootStatus(status);
            });
            if (attemptId !== bootAttemptIdRef.current) {
              console.log('[orion-terminal] boot attempt', attemptId, 'pull ignored (stale)');
              return;
            }
            setSetupStage('ready');
          } catch (e) {
            if (attemptId !== bootAttemptIdRef.current) return;
            console.log('[orion-terminal] boot attempt', attemptId, 'pull failed:', e);
            setSetupStage('error');
          }
          return;
        }

        setSetupStage('error');
      } catch (e) {
        if (attemptId !== bootAttemptIdRef.current) return;
        console.log('[orion-terminal] boot attempt', attemptId, 'error:', e);
        setSetupStage('error');
      }
    };

    startOrionBoot();
  }, [bootKey]);

  const userMessages = useMemo(
    () => messages.filter((m) => m.sender === 'user').map((m) => m.text),
    [messages]
  );

  const handleResetChat = () => {
    setThreads((prev) => setThreadMessages(prev, threadKey, [DEFAULT_GREETING]));
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isTyping) return;

    const userMessage: ChatMessage = { sender: 'user', text: trimmed };
    const nextMessages = [...messages, userMessage];
    setThreads((prev) => setThreadMessages(prev, threadKey, nextMessages));
    setInput('');
    historyIndexRef.current = -1;
    setIsTyping(true);

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
    };

    try {
      const outcome = await handleOrionMessage({
        text: trimmed,
        ctx: agentCtx,
        setupReady: setupStage === 'ready',
      });
      lastResultRef.current = outcome.result ?? undefined;
      console.log('[orion-trace] orchestrator result:', outcome);
      setThreads((prev) => appendMessage(prev, threadKey, { sender: 'ai', text: outcome.message }));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setThreads((prev) => appendMessage(prev, threadKey, { sender: 'ai', text: `Orion couldn't run that: ${detail}` }));
    } finally {
      setIsTyping(false);
    }
  };

  const handleTerminalSubmit = () => {
    const lower = input.trim().toLowerCase();
    if (!lower || isTyping) return;

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
            className="text-[#ff3700] hover:underline hover:text-[#ff3700]/80 transition-colors"
          >
            {part}
          </a>
        );
      } else if (emailRegex.test(part)) {
        return (
          <a key={index} href={`mailto:${part}`} className="text-[#ff3700] hover:underline hover:text-[#ff3700]/80 transition-colors">
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
        'relative flex w-96 flex-shrink-0 flex-col border-l',
        lightMode ? 'bg-white border-gray-200' : 'bg-[#0a0a0a] border-[#2a2e39]',
        className
      )}
    >
      {/* Header */}
      <div
        className={cn(
          'flex items-center gap-2 border-b px-3 py-2.5',
          lightMode ? 'border-gray-200 bg-white' : 'border-[#2a2e39] bg-[#151515]'
        )}
      >
        <Terminal className={cn('h-4 w-4 text-[#ff3700]')} />
        <span className={cn('text-sm font-semibold font-mono', lightMode ? 'text-gray-900' : 'text-[#d1d4dc]')}>
          orion@openrewind
        </span>

        <span className={cn('ml-auto text-[10px] font-medium', lightMode ? 'text-gray-500' : 'text-[#787b86]')}>
          {setupStage === 'ready' ? 'ready' : setupStage === 'pulling' ? 'loading…' : 'offline'}
        </span>
      </div>

      {/* Terminal output */}
      <div
        ref={scrollRef}
        onClick={() => inputRef.current?.focus()}
        className={cn(
          'relative flex-1 overflow-y-auto p-4 font-mono text-xs cursor-text',
          lightMode ? 'bg-[#f8f9fa] text-gray-900' : 'bg-[#0a0a0a] text-[#d1d4dc]'
        )}
        style={{ scrollbarWidth: 'thin', scrollbarColor: lightMode ? '#d1d5db #f3f4f6' : '#ff3700 #1f2937' }}
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
                  <span className="text-[#ff3700] font-semibold">{PROMPT}</span>
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
              className="text-[#ff3700] font-semibold"
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
            <span className="text-[#ff3700] font-semibold">{PROMPT}</span>
            <input
              ref={inputRef}
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask Orion or type help"
              disabled={isTyping}
              className={cn(
                'flex-1 bg-transparent outline-none caret-[#ff3700]',
                lightMode ? 'text-gray-900 placeholder:text-gray-400' : 'text-white placeholder:text-[#787b86]'
              )}
              autoFocus
              spellCheck="false"
            />
            <button
              type="button"
              onClick={handleTerminalSubmit}
              disabled={!input.trim() || isTyping}
              className={cn(
                'flex h-7 w-7 items-center justify-center rounded transition-colors',
                input.trim() && !isTyping ? 'text-[#ff3700] hover:bg-[#ff3700]/10' : 'text-[#787b86]'
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
          lightMode ? 'bg-white border-gray-200 text-gray-500' : 'bg-[#151515] border-[#2a2e39] text-[#787b86]'
        )}
      >
        <div className="flex justify-between items-center">
          <span>Type a command or question • ↑/↓ for history</span>
          <span>'help' for commands • 'clear' to reset</span>
        </div>
      </div>

      <AnimatePresence>
        {setupStage !== 'ready' && (
          <motion.div
            key="boot"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: 'easeInOut' }}
            className={cn(
              'absolute inset-0 z-50 flex flex-col items-center justify-center gap-4 p-6',
              lightMode ? 'bg-[#f8f9fa]' : 'bg-[#0a0a0a]'
            )}
          >
            {setupStage === 'error' ? (
              <div className="flex flex-col items-center gap-3 max-w-[85%] text-center">
                <div className={cn('text-xs font-mono uppercase tracking-widest', lightMode ? 'text-red-600' : 'text-[#ff3700]')}>Orion offline</div>
                <div className={cn('text-[10px] font-mono leading-relaxed', lightMode ? 'text-gray-600' : 'text-[#787b86]')}>
                  Ollama is not running or the <span className={lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'}>{ORION_MODEL}</span> model is missing.
                  <br />
                  Install Ollama and pull the model, then retry.
                </div>
                <button
                  type="button"
                  onClick={() => setBootKey((k) => k + 1)}
                  className={cn(
                    'px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider rounded border transition-colors',
                    lightMode
                      ? 'border-gray-300 text-gray-700 hover:bg-gray-100'
                      : 'border-[#2a2e39] text-[#d1d4dc] hover:bg-[#1a1a1a]'
                  )}
                >
                  Retry
                </button>
              </div>
            ) : (
              <>
                <CoreSpinLoader />
                <div className={cn('text-[10px] font-mono', lightMode ? 'text-gray-500' : 'text-[#787b86]')}>{bootStatus}</div>
                {bootProgress > 0 && (
                  <div className={cn('text-[10px] font-mono', lightMode ? 'text-gray-500' : 'text-[#787b86]')}>{bootProgress}%</div>
                )}
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.aside>
  );
}
