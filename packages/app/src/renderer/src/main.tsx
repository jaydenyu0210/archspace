import { createRoot } from 'react-dom/client';
import { ReactFlowProvider } from '@xyflow/react';
import App from './App';
import { initEngineClient } from './engine-client';
import '@xyflow/react/dist/style.css';
import './styles.css';

initEngineClient();

createRoot(document.getElementById('root') as HTMLElement).render(
  <ReactFlowProvider>
    <App />
  </ReactFlowProvider>,
);
