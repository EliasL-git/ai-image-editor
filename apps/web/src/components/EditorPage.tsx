import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Download,
  Eraser,
  Hand,
  ImagePlus,
  LogOut,
  MagicWand,
  Redo2,
  Scan,
  Sparkles,
  Square,
  Undo2,
  Wand2,
} from 'lucide-react';
import { api } from '../lib/api';
import { useEditor } from '../store/editor';
import { EditorCanvas } from '../lib/canvas';
import { rasterizeHint, maskToDataUrl, featherMask } from '@aie/canvas';
import { EDIT_PRESETS, JOB_POLL_INTERVAL_MS } from '@aie/shared';
import type { ProjectSummary, SelectionTool, User } from '@aie/types';
import type { StrokeHint } from '@aie/canvas';

interface Props {
  user: User;
  onLogout: () => void;
}

const TOOLS: { id: SelectionTool; icon: typeof Scan; label: string }[] = [
  { id: 'brush', icon: Wand2, label: 'Brush' },
  { id: 'rect', icon: Square, label: 'Rectangle' },
  { id: 'ellipse', icon: Scan, label: 'Ellipse' },
  { id: 'lasso', icon: MagicWand, label: 'Lasso' },
  { id: 'magic', icon: Sparkles, label: 'Magic select' },
  { id: 'pan', icon: Hand, label: 'Pan' },
];

export default function EditorPage({ user, onLogout }: Props) {
  const editor = useEditor();
  const qc = useQueryClient();
  const canvasHostRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<EditorCanvas | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);

  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
    enabled: !!projectId,
  });

  // -------------------------------------------------------------------------
  // Canvas lifecycle
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!canvasHostRef.current) return;
    const host = canvasHostRef.current;
    const w = host.parentElement?.clientWidth ?? 800;
    const h = host.parentElement?.clientHeight ?? 600;
    const canvas = new EditorCanvas(host, w, h, {
      onHintChange: (hint) => {
        editor.setHint(hint);
        if (hint) {
          // Instant local mask preview for brush/box (before SAM refines it)
          const preview = rasterizeHint(hint, { width: 256, height: 256 });
          editor.setMask(null, maskToDataUrl(featherMask(preview, 256, 256, 2), 256, 256));
        } else {
          editor.setMask(null, null);
        }
      },
    });
    canvasRef.current = canvas;

    // load image if store already has one (e.g. after project open)
    if (editor.imageUrl) {
      void canvas.setBaseImage(editor.imageUrl);
    }
    return () => {
      canvas.dispose();
      canvasRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply tool to canvas
  useEffect(() => {
    canvasRef.current?.setTool(editor.tool);
  }, [editor.tool]);

  // Apply mask overlay from SAM result
  useEffect(() => {
    if (editor.maskUrl) {
      void canvasRef.current?.setMaskOverlay(editor.maskUrl);
    } else if (!editor.maskDataUrl) {
      canvasRef.current?.clearMaskOverlay();
    }
  }, [editor.maskUrl, editor.maskDataUrl]);

  // Apply new base image (accepted edit / upload / restore)
  useEffect(() => {
    if (editor.imageUrl) {
      void canvasRef.current?.setBaseImage(editor.imageUrl);
      canvasRef.current?.clearMaskOverlay();
    }
  }, [editor.imageUrl]);

  // -------------------------------------------------------------------------
  // Upload
  // -------------------------------------------------------------------------
  async function handleFile(file: File) {
    setBusy(true);
    setError(null);
    try {
      const asset = await api.upload(file);
      editor.setImage({
        url: asset.url,
        id: asset.id,
        width: asset.width,
        height: asset.height,
        name: file.name,
      });
      setProjectId(null);
      void canvasRef.current?.setBaseImage(asset.url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Magic select (SAM 2)
  // -------------------------------------------------------------------------
  async function runMagicSelect() {
    if (!editor.imageId || !editor.hint) return;
    setBusy(true);
    setError(null);
    try {
      editor.setJob({ kind: 'running', type: 'segment', stage: 'queued', progress: 5, jobId: '' });
      const res = await api.segment({
        imageId: editor.imageId,
        mode: editor.hint.kind,
        point: editor.hint.kind === 'point' ? editor.hint.point : undefined,
        box: editor.hint.kind === 'box' ? editor.hint.box : undefined,
        points: editor.hint.kind === 'brush' ? editor.hint.points : undefined,
      });
      pollJob(res.job.id, 'segment');
    } catch (err) {
      setError((err as Error).message);
      editor.clearJob();
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Generate (FLUX Kontext)
  // -------------------------------------------------------------------------
  async function runGenerate() {
    if (!editor.imageId || !editor.prompt.trim()) {
      setError('Draw a selection and describe the change first');
      return;
    }
    // Build mask payload: prefer SAM mask URL, else the local rasterized hint
    let maskPayload: string;
    if (editor.maskUrl) {
      maskPayload = editor.maskUrl;
    } else if (editor.maskDataUrl) {
      maskPayload = editor.maskDataUrl;
    } else if (editor.hint) {
      const preview = rasterizeHint(editor.hint, { width: 512, height: 512 });
      maskPayload = maskToDataUrl(featherMask(preview, 512, 512, 4), 512, 512);
    } else {
      // Expand/relight without selection: full-image mask
      const full = new Uint8ClampedArray(512 * 512 * 4).fill(255);
      maskPayload = maskToDataUrl(full, 512, 512);
    }

    setBusy(true);
    setError(null);
    try {
      editor.setJob({ kind: 'running', type: 'edit', stage: 'queued', progress: 5, jobId: '' });
      const res = await api.edit({
        imageId: editor.imageId,
        prompt: editor.prompt,
        mask: maskPayload,
        strength: editor.strength,
      });
      pollJob(res.job.id, 'edit');
    } catch (err) {
      setError((err as Error).message);
      editor.clearJob();
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // Job polling
  // -------------------------------------------------------------------------
  const pollJob = useCallback(
    (jobId: string, type: 'segment' | 'edit') => {
      const started = Date.now();
      const tick = async () => {
        try {
          const { job } = await api.job(jobId);
          if (job.status === 'succeeded') {
            if (type === 'segment') {
              const result = job.outputUrl;
              editor.setJob({ kind: 'done', type, jobId });
              editor.setMask(result ?? null);
            } else {
              editor.setJob({ kind: 'done', type, jobId });
              if (job.outputUrl) {
                editor.pushHistory(editor.imageUrl ?? '');
                editor.setImage({
                  url: job.outputUrl,
                  id: editor.imageId ?? '',
                  width: editor.imageWidth,
                  height: editor.imageHeight,
                  name: editor.imageName,
                });
                void canvasRef.current?.setBaseImage(job.outputUrl);
              }
            }
            setBusy(false);
            return;
          }
          if (job.status === 'failed') {
            editor.setJob({ kind: 'error', message: job.error ?? 'Job failed' });
            setError(job.error ?? 'Job failed');
            setBusy(false);
            return;
          }
          if (job.status === 'canceled') {
            editor.setJob({ kind: 'error', message: 'Job canceled' });
            setBusy(false);
            return;
          }
          // still running
          editor.setJob({
            kind: 'running',
            type,
            stage: job.stage ?? 'working',
            progress: job.progress,
            jobId,
          });
          if (Date.now() - started < 5 * 60 * 1000) {
            setTimeout(tick, JOB_POLL_INTERVAL_MS);
          } else {
            editor.setJob({ kind: 'error', message: 'Timed out waiting for the job' });
            setBusy(false);
          }
        } catch (err) {
          editor.setJob({ kind: 'error', message: (err as Error).message });
          setBusy(false);
        }
      };
      void tick();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // -------------------------------------------------------------------------
  // History (undo/redo within session) + project save
  // -------------------------------------------------------------------------
  function handleUndo() {
    const prev = editor.undo();
    if (prev) void canvasRef.current?.setBaseImage(prev);
  }

  function handleRedo() {
    const next = editor.redo();
    if (next) void canvasRef.current?.setBaseImage(next);
  }

  async function saveAsProject() {
    if (!editor.imageUrl) return;
    setBusy(true);
    setError(null);
    try {
      const name = window.prompt('Project name', editor.imageName || 'Untitled project');
      if (name === null) return;
      const res = await api.createProject({ name, imageUrl: editor.imageUrl });
      setProjectId(res.project.id);
      await qc.invalidateQueries({ queryKey: ['projects'] });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportImage() {
    if (!projectId) {
      setError('Save the project first, then export');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api.export({ projectId, format: 'png' });
      window.open(res.url, '_blank');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const job = editor.job;
  const running = job.kind === 'running';

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex h-14 items-center justify-between border-b border-ink-700 bg-ink-900 px-4">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-accent to-accent-deep text-sm shadow-glow">
            🎨
          </div>
          <span className="text-sm font-semibold tracking-tight">AI Image Editor</span>
          <span className="ml-2 hidden rounded-full border border-ink-600 px-2 py-0.5 text-[10px] text-zinc-400 sm:inline">
            {user.email}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {editor.imageUrl && (
            <>
              <button onClick={saveAsProject} disabled={busy} className="btn-ghost">
                Save project
              </button>
              <button onClick={exportImage} disabled={busy} className="btn-ghost">
                <Download className="h-4 w-4" /> Export
              </button>
            </>
          )}
          <button onClick={onLogout} className="btn-ghost" title="Sign out">
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left toolbar */}
        <aside className="flex w-14 flex-col items-center gap-1 border-r border-ink-700 bg-ink-900 py-3">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="tool-btn !text-accent"
            title="Upload image"
          >
            <ImagePlus className="h-5 w-5" />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = '';
            }}
          />
          <div className="my-1 h-px w-8 bg-ink-700" />
          {TOOLS.map((t) => {
            const Icon = t.icon;
            const active = editor.tool === t.id;
            return (
              <button
                key={t.id}
                onClick={() => editor.setTool(t.id)}
                title={t.label}
                className={`tool-btn ${active ? '!bg-accent !text-ink-950' : ''}`}
              >
                <Icon className="h-5 w-5" />
              </button>
            );
          })}
          <div className="my-1 h-px w-8 bg-ink-700" />
          <button onClick={handleUndo} disabled={editor.undoStack.length === 0} className="tool-btn" title="Undo">
            <Undo2 className="h-5 w-5" />
          </button>
          <button onClick={handleRedo} disabled={editor.redoStack.length === 0} className="tool-btn" title="Redo">
            <Redo2 className="h-5 w-5" />
          </button>
          <button
            onClick={() => {
              editor.setHint(null);
              editor.setMask(null, null);
              canvasRef.current?.clearDrawing();
            }}
            className="tool-btn"
            title="Clear selection"
          >
            <Eraser className="h-5 w-5" />
          </button>
        </aside>

        {/* Canvas */}
        <main className="checkerboard relative min-w-0 flex-1">
          <canvas ref={canvasHostRef} className="absolute inset-0 h-full w-full" />

          {!editor.imageUrl && !busy && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center">
              <div className="rounded-2xl border border-ink-700 bg-ink-850/80 p-8 backdrop-blur">
                <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-accent-deep text-2xl shadow-glow">
                  🎨
                </div>
                <h2 className="text-lg font-semibold">Start editing</h2>
                <p className="mt-1 max-w-xs text-sm text-zinc-400">
                  Upload an image, select an object, describe the change, and let AI do the rest.
                </p>
                <button
                  onClick={() => fileRef.current?.click()}
                  className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-ink-950 transition hover:bg-accent-soft"
                >
                  Upload image
                </button>
              </div>
            </div>
          )}

          {/* Job progress overlay */}
          {running && (
            <div className="absolute left-1/2 top-4 w-72 -translate-x-1/2 rounded-xl border border-accent/30 bg-ink-900/90 p-4 shadow-glow backdrop-blur animate-fade-in">
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="font-medium text-accent">
                  {job.type === 'segment' ? 'Smart selecting…' : 'Generating…'}
                </span>
                <span className="text-zinc-400">{job.progress}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-ink-700">
                <div
                  className="h-full rounded-full bg-accent transition-all"
                  style={{ width: `${job.progress}%` }}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-zinc-400">{job.stage}</p>
            </div>
          )}

          {error && (
            <div className="absolute bottom-4 left-1/2 w-max max-w-sm -translate-x-1/2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300 backdrop-blur">
              {error}
              <button onClick={() => setError(null)} className="ml-2 text-red-400 hover:text-red-200">
                ✕
              </button>
            </div>
          )}
        </main>

        {/* Right panel */}
        <aside className="flex w-80 flex-col gap-4 overflow-y-auto border-l border-ink-700 bg-ink-900 p-4">
          {/* Prompt */}
          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">What should AI do?</label>
            <textarea
              value={editor.prompt}
              onChange={(e) => editor.setPrompt(e.target.value)}
              placeholder="e.g. Replace the red car with a vintage blue car…"
              rows={3}
              className="w-full resize-none rounded-lg border border-ink-700 bg-ink-950 px-3 py-2 text-sm outline-none focus:border-accent"
            />
            <button
              onClick={runGenerate}
              disabled={busy || !editor.imageUrl}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-accent-soft disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              Generate
            </button>
            <div className="mt-2 flex items-center gap-2">
              <label className="text-[11px] text-zinc-500">Strength {Math.round(editor.strength * 100)}%</label>
              <input
                type="range"
                min={0.1}
                max={1}
                step={0.05}
                value={editor.strength}
                onChange={(e) => editor.setStrength(Number(e.target.value))}
                className="flex-1 accent-cyan-400"
              />
            </div>
            {/* Accept / discard after an edit completes */}
            {job.kind === 'done' && job.type === 'edit' && (
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => {
                    editor.clearJob();
                    editor.setMask(null, null);
                  }}
                  className="flex-1 rounded-lg border border-ink-600 px-3 py-1.5 text-xs font-medium text-zinc-300 hover:border-accent hover:text-accent"
                >
                  Keep (auto-accepted)
                </button>
                <button
                  onClick={handleUndo}
                  className="flex-1 rounded-lg border border-red-500/40 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/10"
                >
                  Discard
                </button>
              </div>
            )}
          </div>

          {/* Presets */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Quick edits</h3>
            <div className="grid grid-cols-2 gap-2">
              {EDIT_PRESETS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => editor.setPrompt(p.prompt)}
                  className="rounded-lg border border-ink-700 bg-ink-850 px-2 py-2 text-left text-xs text-zinc-300 transition hover:border-accent/60 hover:text-white"
                  title={p.hint}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Projects */}
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Projects</h3>
            {projectsData?.projects.length ? (
              <div className="space-y-2">
                {projectsData.projects.map((p: ProjectSummary) => (
                  <div key={p.id} className="flex items-center gap-2 rounded-lg border border-ink-700 bg-ink-850 p-2">
                    <img src={p.coverUrl} alt="" className="h-9 w-9 rounded-md object-cover" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-zinc-200">{p.name}</p>
                      <p className="text-[10px] text-zinc-500">{p.versionCount} versions</p>
                    </div>
                    <button
                      onClick={() => void loadProject(p)}
                      className="rounded-md border border-ink-600 px-2 py-1 text-[10px] text-zinc-300 hover:border-accent hover:text-accent"
                    >
                      Open
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-zinc-500">No projects yet — save one to start your history.</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );

  async function loadProject(p: ProjectSummary) {
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.getProject(p.id);
      const head = project.versions.find((v) => v.isHead) ?? project.versions[0];
      if (head) {
        editor.setImage({
          url: head.imageUrl,
          id: '',
          width: 0,
          height: 0,
          name: project.name,
        });
        setProjectId(project.id);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
}
