import { create } from 'zustand';
import type { SelectionTool } from '@aie/types';
import type { StrokeHint } from '@aie/canvas';

export type JobState =
  | { kind: 'idle' }
  | {
      kind: 'running';
      type: 'segment' | 'edit' | 'generate';
      stage: string;
      progress: number;
      jobId: string;
      /** Live preview frame URL (streamed from Modal). */
      previewUrl?: string;
      /** Bumped whenever previewUrl changes so the <img> refetches it. */
      previewVersion?: number;
    }
  | { kind: 'done'; type: 'segment' | 'edit' | 'generate'; jobId: string }
  | { kind: 'error'; message: string };

export interface EditorState {
  imageUrl: string | null;
  imageId: string | null;
  imageWidth: number;
  imageHeight: number;
  imageName: string;

  tool: SelectionTool;
  hint: StrokeHint | null;
  maskUrl: string | null;
  maskDataUrl: string | null;

  prompt: string;
  strength: number;

  job: JobState;

  undoStack: string[];
  redoStack: string[];

  setImage: (img: { url: string; id: string; width: number; height: number; name: string }) => void;
  setTool: (tool: SelectionTool) => void;
  setHint: (hint: StrokeHint | null) => void;
  setMask: (maskUrl: string | null, maskDataUrl?: string | null) => void;
  setPrompt: (prompt: string) => void;
  setStrength: (strength: number) => void;
  setJob: (job: JobState) => void;
  clearJob: () => void;

  pushHistory: (stateUrl: string) => void;
  undo: () => string | null;
  redo: () => string | null;
  clearHistory: () => void;
}

export const useEditor = create<EditorState>((set, get) => ({
  imageUrl: null,
  imageId: null,
  imageWidth: 0,
  imageHeight: 0,
  imageName: '',

  tool: 'brush',
  hint: null,
  maskUrl: null,
  maskDataUrl: null,

  prompt: '',
  strength: 0.85,

  job: { kind: 'idle' },

  undoStack: [],
  redoStack: [],

  setImage: (img) =>
    set({
      imageUrl: img.url,
      imageId: img.id,
      imageWidth: img.width,
      imageHeight: img.height,
      imageName: img.name,
      maskUrl: null,
      maskDataUrl: null,
      hint: null,
      undoStack: [],
      redoStack: [],
    }),

  setTool: (tool) => set({ tool }),
  setHint: (hint) => set({ hint }),
  setMask: (maskUrl, maskDataUrl) => set({ maskUrl, maskDataUrl }),
  setPrompt: (prompt) => set({ prompt }),
  setStrength: (strength) => set({ strength }),
  setJob: (job) => set({ job }),
  clearJob: () => set({ job: { kind: 'idle' } }),

  pushHistory: (stateUrl) =>
    set((s) => ({ undoStack: [...s.undoStack.slice(-49), stateUrl], redoStack: [] })),

  undo: () => {
    const s = get();
    if (s.undoStack.length === 0) return null;
    const prev = s.undoStack[s.undoStack.length - 1];
    set({
      undoStack: s.undoStack.slice(0, -1),
      redoStack: [...s.redoStack, s.imageUrl ?? ''].filter(Boolean),
      imageUrl: prev,
    });
    return prev;
  },

  redo: () => {
    const s = get();
    if (s.redoStack.length === 0) return null;
    const next = s.redoStack[s.redoStack.length - 1];
    set({
      redoStack: s.redoStack.slice(0, -1),
      undoStack: [...s.undoStack, s.imageUrl ?? ''].filter(Boolean),
      imageUrl: next,
    });
    return next;
  },

  clearHistory: () => set({ undoStack: [], redoStack: [] }),
}));
