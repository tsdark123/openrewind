'use client';

import { HTMLMotionProps, motion } from 'motion/react';
import { cn } from '../../lib/utils';

export interface MorphingSquareProps {
  message?: string;
  /**
   * Position of the message relative to the spinner.
   * @default bottom
   */
  messagePlacement?: 'top' | 'bottom' | 'left' | 'right';
}

const placementClasses: Record<NonNullable<MorphingSquareProps['messagePlacement']>, string> = {
  bottom: 'flex-col',
  top: 'flex-col-reverse',
  right: 'flex-row',
  left: 'flex-row-reverse',
};

export function MorphingSquare({
  className,
  message,
  messagePlacement = 'bottom',
  ...props
}: HTMLMotionProps<'div'> & MorphingSquareProps) {
  return (
    <div className={cn('flex gap-2 items-center justify-center', placementClasses[messagePlacement])}>
      <motion.div
        className={cn('bg-[#3b6fff] h-10 w-10', className)}
        animate={{
          borderRadius: ['6%', '50%', '6%'],
          rotate: [0, 180, 360],
        }}
        transition={{
          duration: 2,
          repeat: Number.POSITIVE_INFINITY,
          ease: 'easeInOut',
        }}
        {...props}
      />
      {message && <div className="text-xs font-mono text-[#d1d4dc]">{message}</div>}
    </div>
  );
}
