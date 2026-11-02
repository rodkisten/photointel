import { create } from 'zustand';
import { reportDiagnostic, type Diagnostic } from './diagnostics';

interface UiState {
  density: number;
  selected: Set<string>;
  selecting: boolean;
  toast: { text: string; kind: 'success' | 'error'; incident?: Diagnostic; error?: Error } | null;
  inspector: { incident: Diagnostic; error?: Error } | null;
  setDensity: (value: number) => void;
  toggle: (id: string) => void;
  clear: () => void;
  startSelection: () => void;
  notify: (text: string, kind?: 'success' | 'error', incident?: Diagnostic, error?: Error) => void;
  inspect: (incident: Diagnostic, error?: Error) => void;
  closeInspector: () => void;
  dismiss: () => void;
}
export const useUi = create<UiState>((set) => ({
  density: 1,
  selected: new Set(),
  selecting: false,
  toast: null,
  inspector: null,
  setDensity: (density) => set({ density }),
  startSelection: () => set({ selecting: true }),
  toggle: (id) =>
    set((state) => {
      const selected = new Set(state.selected);
      if (selected.has(id)) selected.delete(id);
      else if (selected.size < 500) selected.add(id);
      return { selected, selecting: true };
    }),
  clear: () => set({ selected: new Set(), selecting: false }),
  notify: (text, kind = 'success', incident, error) =>
    set({
      toast: {
        text,
        kind,
        incident: kind === 'error' ? (incident ?? reportDiagnostic(new Error(text), 'runtime')) : undefined,
        error: kind === 'error' ? error : undefined,
      },
    }),
  inspect: (incident, error) => set({ inspector: { incident, error } }),
  closeInspector: () => set({ inspector: null }),
  dismiss: () => set({ toast: null }),
}));
