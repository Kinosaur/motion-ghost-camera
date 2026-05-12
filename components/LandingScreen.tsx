'use client';

import { useRef, useCallback } from 'react';

interface LandingScreenProps {
  onOpen: () => void;
}

export default function LandingScreen({ onOpen }: LandingScreenProps) {
  const spotlightRef = useRef<HTMLDivElement>(null);
  const cursorRef    = useRef<HTMLDivElement>(null);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (spotlightRef.current) {
      spotlightRef.current.style.background =
        `radial-gradient(500px circle at ${x}px ${y}px,
          rgba(180,210,255,0.13) 0%,
          rgba(140,180,255,0.06) 25%,
          rgba(100,150,255,0.02) 50%,
          transparent 70%)`;
    }

    if (cursorRef.current) {
      cursorRef.current.style.transform = `translate(${x - 5}px, ${y - 5}px)`;
    }

  }, []);

  return (
    <div
      className="relative flex flex-col items-center justify-center h-full w-full bg-black overflow-hidden cursor-none"
      onPointerMove={handlePointerMove}
    >
      {/* Cursor spotlight */}
      <div
        ref={spotlightRef}
        className="absolute inset-0 pointer-events-none"
        aria-hidden
      />

      {/* Custom cursor — dot */}
      <div
        ref={cursorRef}
        className="absolute top-0 left-0 w-2.5 h-2.5 rounded-full bg-white pointer-events-none z-50"
        style={{ willChange: 'transform' }}
        aria-hidden
      />

      {/* Ambient center glow */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none" aria-hidden>
        <div className="w-[600px] h-[600px] rounded-full bg-white/[0.025] blur-[160px]" />
      </div>

      {/* Main content */}
      <div className="relative z-10 flex flex-col items-center gap-10 px-8 text-center">

        {/* Title */}
        <div className="flex flex-col items-center gap-5 animate-fade-in">
          <h1 className="font-display font-light text-[clamp(3.5rem,10vw,7rem)] leading-none tracking-[0.12em] text-white">
            Motion Ghost
          </h1>

          <div className="flex items-center gap-4">
            <span className="block h-px w-10 bg-white/20" />
            <p className="text-[10px] tracking-[0.28em] uppercase text-white/55">
              A camera that only reveals movement
            </p>
            <span className="block h-px w-10 bg-white/20" />
          </div>

          {/* Mode hints — interactive */}
          <div className="flex items-center gap-2.5 pt-0.5">
            {['Ghost', 'Web', 'Rain'].map((m) => (
              <button
                key={m}
                onClick={onOpen}
                className="text-[9px] tracking-[0.22em] uppercase text-white/40
                  border border-white/10 rounded-full px-3.5 py-1.5
                  hover:text-white/80 hover:border-white/35 hover:bg-white/[0.06]
                  active:scale-95 transition-all duration-200 cursor-none focus:outline-none"
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Begin button */}
        <button
          onClick={onOpen}
          aria-label="Open camera"
          className="group relative flex items-center justify-center gap-4
            min-w-[160px] min-h-[52px] px-8
            border border-white/20 rounded-full
            hover:border-white/50 hover:bg-white/[0.06]
            active:scale-95
            transition-all duration-300 ease-out
            focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30
            animate-fade-in-delay cursor-none"
        >
          <span className="text-[11px] tracking-[0.35em] uppercase text-white/65
            group-hover:text-white transition-colors duration-300">
            Begin
          </span>
          <span
            className="block h-px w-4 bg-white/35
              group-hover:w-7 group-hover:bg-white/80
              transition-all duration-400 ease-out"
          />
        </button>

      </div>

      {/* Privacy note */}
      <p className="absolute bottom-8 left-0 right-0 text-center
        text-[9px] tracking-[0.22em] uppercase text-white/28 animate-fade-in-delay-2">
        All processing local · No data leaves your device
      </p>
    </div>
  );
}
