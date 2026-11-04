import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';

// A file dropped outside the composer would otherwise replace the app with the file.
for (const type of ['dragover', 'drop'] as const) window.addEventListener(type, (event) => event.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
