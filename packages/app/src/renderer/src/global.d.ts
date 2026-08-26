import type { ArchspaceBridge } from '../../shared/protocol';

declare global {
  interface Window {
    archspace: ArchspaceBridge;
  }
}

export {};
