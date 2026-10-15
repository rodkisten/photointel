import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
afterEach(cleanup);
Object.defineProperty(window, 'matchMedia', { value: (query: string) => ({
  matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false,
}) });
class TestResizeObserver {
  observe() {} unobserve() {} disconnect() {}
}
globalThis.ResizeObserver = TestResizeObserver;
