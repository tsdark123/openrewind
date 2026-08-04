'use client';

import { useState, useEffect } from 'react';

export function CoreSpinLoader() {
  const [loadingText, setLoadingText] = useState('Initializing');

  useEffect(() => {
    const states = ['Loading...', 'Fetching Data..', 'Syncing...', 'Processing..', 'Optimizing...'];
    let i = 0;
    const interval = setInterval(() => {
      i = (i + 1) % states.length;
      setLoadingText(states[i]);
    }, 1000);

    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex flex-col items-center justify-center min-h-[200px] gap-8">
      <div className="relative w-20 h-20 flex items-center justify-center">
        {/* Base Glow */}
        <div
          className="
            absolute inset-0 rounded-full blur-xl animate-pulse
            bg-[#3b6fff]/15
            dark:bg-[#3b6fff]/10
          "
        />

        {/* Outer Dashed Ring */}
        <div
          className="
            absolute inset-0 rounded-full border border-dashed
            border-[#3b6fff]/40
            dark:border-[#3b6fff]/20
            animate-[spin_10.3s_linear_infinite]
          "
        />

        {/* Main Arc */}
        <div
          className="
            absolute inset-1 rounded-full border-2 border-transparent
            border-t-[#3b6fff]
            dark:border-t-[#3b6fff]
            shadow-[0_0_6px_rgba(59,111,255,0.5)]
            dark:shadow-[0_0_10px_rgba(59,111,255,0.4)]
            animate-[spin_2.3s_linear_infinite]
          "
        />

        {/* Reverse Arc */}
        <div
          className="
            absolute inset-3 rounded-full border-2 border-transparent
            border-b-[#3b6fff]
            dark:border-b-[#3b6fff]
            shadow-[0_0_6px_rgba(59,111,255,0.4)]
            dark:shadow-[0_0_10px_rgba(59,111,255,0.4)]
            animate-[spin_3.3s_linear_infinite_reverse]
          "
        />

        {/* Inner Fast Ring */}
        <div
          className="
            absolute inset-5 rounded-full border border-transparent
            border-l-[#3b6fff]/60
            dark:border-l-[#3b6fff]/50
            animate-[spin_1.3s_ease-in-out_infinite]
          "
        />

        {/* Orbital Dot */}
        <div className="absolute inset-0 animate-[spin_4.3s_linear_infinite]">
          <div
            className="
              absolute top-0 left-1/2 -translate-x-1/2
              w-1 h-1 rounded-full
              bg-[#3b6fff]
              dark:bg-[#3b6fff]
              shadow-[0_0_4px_rgba(59,111,255,0.9)]
              dark:shadow-[0_0_6px_rgba(59,111,255,0.8)]
            "
          />
        </div>

        {/* Center Core */}
        <div
          className="
            absolute w-2 h-2 rounded-full animate-pulse
            bg-[#3b6fff]
            dark:bg-[#3b6fff]
            shadow-[0_0_6px_rgba(59,111,255,0.6)]
            dark:shadow-[0_0_10px_rgba(59,111,255,0.8)]
          "
        />
      </div>

      {/* Text */}
      <div className="flex flex-col items-center gap-1 h-8 justify-center">
        <span
          key={loadingText}
          className="
            text-[10px] font-medium tracking-[0.3em] uppercase
            text-[#3b6fff]
            dark:text-[#3b6fff]/70
            animate-in fade-in slide-in-from-bottom-2 duration-500
          "
        >
          {loadingText}
        </span>
      </div>
    </div>
  );
}
