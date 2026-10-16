/**
 * Vitest global setup.
 *
 * Node >= 22 ships an experimental `localStorage` getter on globalThis that
 * returns undefined unless --localstorage-file is passed. Because the property
 * already exists on the Node global, vitest's happy-dom environment skips
 * copying happy-dom's own storage into the test global, so every test sees
 * `localStorage === undefined`. Restore happy-dom's Storage here (tests are
 * isolated via beforeEach(() => localStorage.clear())).
 */
import { Storage } from 'happy-dom';

const existing = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
if (!existing || typeof existing.get?.call(globalThis) !== 'object') {
  const storage = new Storage();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get: () => storage,
  });
}

const existingSession = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
if (!existingSession || typeof existingSession.get?.call(globalThis) !== 'object') {
  const storage = new Storage();
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get: () => storage,
  });
}
