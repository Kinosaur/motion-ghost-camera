'use client';

import type { ErrorType } from './GhostCamera';

const MESSAGES: Record<ErrorType, { heading: string; body: string; action?: string }> = {
  denied: {
    heading: 'Camera access is blocked.',
    body: 'Enable camera permission in your browser settings to continue.',
    action: 'Try Again',
  },
  'no-camera': {
    heading: 'No camera found.',
    body: 'No camera was detected on this device.',
  },
  unsupported: {
    heading: 'Browser not supported.',
    body: 'Try the latest version of Chrome, Safari, Edge, or Firefox.',
  },
};

interface ErrorScreenProps {
  errorType: ErrorType;
  onRetry: () => void;
}

export default function ErrorScreen({ errorType, onRetry }: ErrorScreenProps) {
  const { heading, body, action } = MESSAGES[errorType];

  return (
    <div className="relative flex flex-col items-center justify-center h-full w-full bg-black overflow-hidden">

      <div
        className="absolute inset-0 flex items-center justify-center pointer-events-none"
        aria-hidden
      >
        <div className="w-[320px] h-[320px] rounded-full bg-white/[0.015] blur-[100px]" />
      </div>

      <div className="relative z-10 flex flex-col items-center gap-7 px-8 text-center max-w-xs animate-fade-in">
        <div className="flex flex-col items-center gap-3">
          <p className="text-[9px] tracking-[0.28em] uppercase text-white/20">Error</p>
          <h2 className="font-display font-light text-2xl text-white/80 leading-snug">
            {heading}
          </h2>
          <p className="text-[11px] tracking-wide text-white/25 leading-relaxed">{body}</p>
        </div>

        {action && (
          <button
            onClick={onRetry}
            className="group flex items-center gap-3 focus:outline-none"
          >
            <span className="text-[11px] tracking-[0.3em] uppercase text-white/35
              group-hover:text-white/80 transition-colors duration-400">
              {action}
            </span>
            <span className="block h-px w-4 bg-white/20
              group-hover:w-8 group-hover:bg-white/50
              transition-all duration-500 ease-out" />
          </button>
        )}

        <button
          onClick={() => window.location.reload()}
          className="text-[9px] tracking-[0.25em] uppercase text-white/15
            hover:text-white/35 transition-colors duration-300 focus:outline-none"
        >
          Refresh page
        </button>
      </div>

      <p className="absolute bottom-8 left-0 right-0 text-center
        text-[9px] tracking-[0.22em] uppercase text-white/10">
        Camera processed locally · Refresh to reset
      </p>
    </div>
  );
}
