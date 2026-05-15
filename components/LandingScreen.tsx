'use client';

import { useRef, useCallback } from 'react';

interface LandingScreenProps {
  onOpen: (file?: File) => void;
}

export default function LandingScreen({ onOpen }: LandingScreenProps) {
  const spotlightRef = useRef<HTMLDivElement>(null);
  const cursorRef    = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      cursorRef.current.style.transform = `translate(${x}px, ${y}px)`;
    }

  }, []);

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onOpen(file);
    e.target.value = '';
  }, [onOpen]);

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

      {/* Custom cursor — dot + ring */}
      <div
        ref={cursorRef}
        className="absolute top-0 left-0 pointer-events-none z-50"
        style={{ willChange: 'transform' }}
        aria-hidden
      >
        <div className="absolute w-9 h-9 rounded-full border border-white/20 -translate-x-1/2 -translate-y-1/2
          transition-[width,height,opacity] duration-150" />
        <div className="absolute w-1.5 h-1.5 rounded-full bg-white -translate-x-1/2 -translate-y-1/2
          shadow-[0_0_8px_rgba(255,255,255,0.85)]" />
      </div>

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
            {['Trace', 'Rain'].map((m) => (
              <button
                key={m}
                onClick={() => onOpen()}
                className="text-[9px] tracking-[0.22em] uppercase text-white/50
                  border border-white/15 rounded-full px-3.5 py-1.5
                  hover:text-white/85 hover:border-white/40 hover:bg-white/[0.06]
                  active:scale-95 transition-all duration-200 cursor-none focus:outline-none"
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Begin button */}
        <div className="flex flex-col items-center gap-3 animate-fade-in-delay">
          <button
            onClick={() => onOpen()}
            aria-label="Open camera"
            className="group relative flex items-center justify-center gap-4
              min-w-[160px] min-h-[52px] px-8
              border border-white/20 rounded-full
              hover:border-white/50 hover:bg-white/[0.06]
              active:scale-95
              transition-all duration-300 ease-out
              focus:outline-none focus-visible:ring-1 focus-visible:ring-white/30
              cursor-none"
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

          {/* Hidden file input */}
          <input
            ref={fileInputRef}
            type="file"
            accept="video/*"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Upload video button */}
          <button
            onClick={() => fileInputRef.current?.click()}
            aria-label="Upload video file"
            className="flex items-center gap-2 min-h-[36px] px-4
              text-[9px] tracking-[0.22em] uppercase text-white/45
              hover:text-white/75 active:text-white/90
              transition-colors duration-200 cursor-none focus:outline-none"
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 7V2M2.5 4.5L5 2L7.5 4.5"/>
              <path d="M1 9h8"/>
            </svg>
            Upload video
          </button>
        </div>

      </div>

      {/* Privacy note */}
      <p className="absolute bottom-8 left-0 right-0 text-center
        text-[9px] tracking-[0.22em] uppercase text-white/38 animate-fade-in-delay-2">
        All processing local · No data leaves your device
      </p>
    </div>
  );
}
