import { create } from 'zustand';
import type { Diagnostic } from './diagnostics';

interface UiState {
  density: number; selected: Set<string>; selecting: boolean;
  toast: { text: string; kind: 'success' | 'error'; incident?: Diagnostic } | null;
  setDensity: (value: number) => void;
  toggle: (id: string) => void;
  clear: () => void;
  startSelection: () => void;
  notify: (text: string, kind?: 'success' | 'error', incident?: Diagnostic) => void;
  dismiss: () => void;
}
export const useUi = create<UiState>((set) => ({
  density: 1, selected: new Set(), selecting: false, toast: null,
  setDensity: (density) => set({ density }),
  startSelection: () => set({ selecting: true }),
  toggle: (id) => set((state) => {
    const selected = new Set(state.selected);
    if (selected.has(id)) selected.delete(id); else if (selected.size < 500) selected.add(id);
    return { selected, selecting: true };
  }),
  clear: () => set({ selected: new Set(), selecting: false }),
  notify: (text, kind = 'success', incident) => set({ toast: { text, kind, incident } }),
  dismiss: () => set({ toast: null }),
}));
