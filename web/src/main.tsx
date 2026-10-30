import { createRoot } from 'react-dom/client';
import '@fontsource-variable/big-shoulders-display';
import '@fontsource-variable/atkinson-hyperlegible-next';
import './styles.css';
import { App } from './App.tsx';
import { connectEvents, loadLibrary, loadMarks, loadAllowed, loadYear, startNowPlayingLoop } from './store.ts';

void loadLibrary();
void loadMarks();
void loadAllowed();
void loadYear();
connectEvents();
startNowPlayingLoop();

createRoot(document.getElementById('root')!).render(<App />);
