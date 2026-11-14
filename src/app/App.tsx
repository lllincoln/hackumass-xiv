import { useEffect } from 'react';
import { loadPack } from '../data/pack';
import { useStore } from '../store';
import { Main } from './Main';
import { Start } from './Start';

export function App() {
  const started = useStore((s) => s.started);
  const largeText = useStore((s) => s.settings.largeText);
  const highContrast = useStore((s) => s.settings.highContrast);
  const announcement = useStore((s) => s.announcement);

  // The campus pack is static: start loading it before the user taps Start.
  useEffect(() => {
    if (useStore.getState().pack) return;
    loadPack().then(
      (pack) => useStore.setState({ pack, packError: null }),
      (err: unknown) => {
        console.error('[pack] load failed', err);
        useStore.setState({ packError: 'Campus map data could not be loaded. Check the connection and reload.' });
      },
    );
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle('large-text', largeText);
    document.documentElement.classList.toggle('hc', highContrast);
  }, [largeText, highContrast]);

  return (
    <>
      {started ? <Main /> : <Start />}
      {/* State changes for screen readers (VoiceOver / TalkBack). */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </div>
    </>
  );
}
