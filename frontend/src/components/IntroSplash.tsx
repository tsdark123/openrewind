import { useEffect, useRef, useState } from 'react';
import { GradientShimmer } from './ui/gradient-shimmer';

interface IntroSplashProps {
  onFinished: () => void;
  onFadeStart?: () => void;
  lightMode?: boolean;
}

export function IntroSplash({ onFinished, onFadeStart, lightMode = false }: IntroSplashProps) {
  const [fadeOut, setFadeOut] = useState(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const onFadeStartRef = useRef(onFadeStart);
  onFadeStartRef.current = onFadeStart;

  useEffect(() => {
    const hold = setTimeout(() => {
      onFadeStartRef.current?.();
      setFadeOut(true);
      setTimeout(() => onFinishedRef.current(), 600);
    }, 1500);
    return () => clearTimeout(hold);
  }, []);

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center transition-opacity duration-600 ease-out ${
        fadeOut ? 'opacity-0 pointer-events-none' : 'opacity-100'
      } ${lightMode ? 'bg-white' : 'bg-[#0a0a0a]'}`}
      aria-label="OpenRewind intro"
    >
      <GradientShimmer
        gradient="sunrise"
        easing="smooth"
        duration={1.2}
        spread={3}
        angle={105}
        pauseBetween={800}
        className={`text-5xl font-semibold tracking-tight sm:text-7xl ${
          lightMode ? 'text-gray-900' : 'text-white'
        }`}
      >
        OpenRewind
      </GradientShimmer>
    </div>
  );
}
