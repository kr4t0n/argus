import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App';
import { TooltipProvider } from './components/ui/Tooltip';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      {/* `delayDuration` of 150ms feels snappy without firing on
          accidental cursor flybys. Single provider at the root so the
          delay timer is shared across every Tooltip in the app —
          hovering one then immediately another reuses the open state
          instead of re-waiting the full delay. */}
      <TooltipProvider delayDuration={150} skipDelayDuration={300}>
        <App />
      </TooltipProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
