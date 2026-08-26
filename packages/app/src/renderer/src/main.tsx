/**
 * Renderer entry: mount React, and start the engine client before it
 * (ARCHITECTURE §3.2).
 *
 * `initEngineClient()` runs above `createRoot` on purpose. It asks main for
 * the engine MessagePort, and the port arrives as a `window` message that must
 * have a listener already attached — mounting first would open a window in
 * which the reply can land with nothing to receive it. Nothing renders in that
 * gap anyway, so the ordering costs nothing and removes a race.
 *
 * `ReactFlowProvider` wraps the whole app rather than just the canvas because
 * `NodeLibrary` calls `useReactFlow()` to place a double-clicked node at the
 * viewport centre, and that hook needs the provider above it.
 */
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
