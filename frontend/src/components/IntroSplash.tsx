import { useState } from 'react';
import { SpecialText } from './ui/special-text';

interface IntroSplashProps {
  onFinished: () => void;
  lightMode?: boolean;
}

export function IntroSplash({ onFinished, lightMode = false }: IntroSplashProps) {
  const [fadeOut, setFadeOut] = useState(false);

  const handleComplete = () => {
    // Hold the final decoded 'OpenReplay' text for a moment before fading.
    setTimeout(() => {
      setFadeOut(true);
      setTimeout(onFinished, 600);
    }, 1000);
  };

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center transition-opacity duration-[600ms] ease-in-out ${
        fadeOut ? 'opacity-0 pointer-events-none' : 'opacity-100'
      } ${lightMode ? 'bg-white' : 'bg-[#121416]'}`}
      aria-label="OpenReplay intro"
    >
      <div className="flex items-center">
        <SpecialText
          speed={24}
          className={`text-4xl font-bold tracking-wide ${
            lightMode ? 'text-gray-900' : 'text-[#d1d4dc]'
          }`}
          onComplete={handleComplete}
        >
          OpenReplay
        </SpecialText>
      </div>
    </div>
  );
}
