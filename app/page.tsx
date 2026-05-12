'use client';

import { useState } from 'react';
import LandingScreen from '@/components/LandingScreen';
import GhostCamera, { type ErrorType } from '@/components/GhostCamera';
import ErrorScreen from '@/components/ErrorScreen';

type AppState = 'landing' | 'camera' | 'error';

export default function Page() {
  const [appState, setAppState] = useState<AppState>('landing');
  const [errorType, setErrorType] = useState<ErrorType | null>(null);

  const handleOpen = () => setAppState('camera');

  const handleError = (type: ErrorType) => {
    setErrorType(type);
    setAppState('error');
  };

  const handleStop = () => {
    setAppState('landing');
    setErrorType(null);
  };

  const handleRetry = () => {
    setErrorType(null);
    setAppState('camera');
  };

  return (
    <main className="h-full w-full bg-black">
      {appState === 'landing' && <LandingScreen onOpen={handleOpen} />}
      {appState === 'camera' && (
        <GhostCamera onError={handleError} onStop={handleStop} />
      )}
      {appState === 'error' && errorType && (
        <ErrorScreen errorType={errorType} onRetry={handleRetry} />
      )}
    </main>
  );
}
