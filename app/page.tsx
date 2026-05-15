'use client';

import { useState } from 'react';
import LandingScreen from '@/components/LandingScreen';
import GhostCamera, { type ErrorType } from '@/components/GhostCamera';
import ErrorScreen from '@/components/ErrorScreen';

type AppState = 'landing' | 'camera' | 'error';

export default function Page() {
  const [appState, setAppState] = useState<AppState>('landing');
  const [errorType, setErrorType] = useState<ErrorType | null>(null);
  const [videoFile, setVideoFile] = useState<File | null>(null);

  const handleOpen = (file?: File) => {
    setVideoFile(file ?? null);
    setAppState('camera');
  };

  const handleError = (type: ErrorType) => {
    setErrorType(type);
    setAppState('error');
  };

  const handleStop = () => {
    setAppState('landing');
    setErrorType(null);
    setVideoFile(null);
  };

  const handleRetry = () => {
    setErrorType(null);
    setAppState('camera');
  };

  return (
    <main className="h-full w-full bg-black">
      {appState === 'landing' && <LandingScreen onOpen={handleOpen} />}
      {appState === 'camera' && (
        <GhostCamera
          key={videoFile ? videoFile.name + videoFile.size : 'camera'}
          onError={handleError}
          onStop={handleStop}
          videoFile={videoFile ?? undefined}
        />
      )}
      {appState === 'error' && errorType && (
        <ErrorScreen errorType={errorType} onRetry={handleRetry} />
      )}
    </main>
  );
}
