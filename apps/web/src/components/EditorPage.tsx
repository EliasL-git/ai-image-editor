import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useEditor } from '../store/editor';
import { EditorCanvas } from '../lib/canvas';
import { rasterizeHint, maskToDataUrl, featherMask } from '@aie/canvas';
import { EDIT_PRESETS, JOB_POLL_INTERVAL_MS } from '@aie/shared';
import type { ProjectDetail, ProjectSummary, SelectionTool, User } from '@aie/types';
import type { StrokeHint } from '@aie/canvas';

interface Props {
  user: User;
  onLogout: () => void;
}

const TOOLS: { id: SelectionTool; icon: string; label: string }[] = [
  { id: 'brush', icon: 'brush', label: 'Brush' },
  { id: 'rect', icon: 'crop_square', label: 'Rectangle' },
  { id: 'ellipse', icon: 'radio_button_unchecked', label: 'Ellipse' },
  { id: 'lasso', icon: 'gesture', label: 'Lasso' },
  { id: 'magic', icon: 'auto_fix_high', label: 'Magic select' },
  { id: 'pan', icon: 'pan_tool', label: 'Pan' },
];

type InspectorTab = 'properties' | 'layers' | 'history';

export default function EditorPage({ user, onLogout }: Props) {
  const editor = useEditor();
  const qc = useQueryClient();
  const canvasHostRef = useRef<HTMLCanvasElement>(null);
  const canvasRef = useRef<EditorCanvas | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [genPrompt, setGenPrompt] = useState('');
  const [tab, setTab] = useState<InspectorTab>('properties');
  const [zoomPct, setZoomPct] = useState(100);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { data: projectsData } = useQuery({
    queryKey: ['projects'],
    queryFn: () => api.listProjects(),
    enabled: !!projectId,
  });

  const { data: projectDetail } = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.getProject(projectId as string).then((r) => r.project),
    enabled: !!projectId,
  });

  const refreshZoom = useCallback(() => {
    const z = canvasRef.current?.instance.getZoom();
    if (z) setZoomPct(Math.round(z * 100));
  }, []);

  // -------------------------------------------------------------------------
  // Job polling (shared by segment + edit + generate)
  // -------------------------------------------------------------------------
  const pollJob = useCallback(
    (jobId: string, type: 'segment' | 'edit' | 'generate') => {
      const started = Date.now();
      const tick = async () => {
        try {
          const { job } = await api.job(jobId);
          if (job.status === 'succeeded') {
            console.info(`[job ${jobId}] ${type} succeeded → ${job.outputUrl}`);
            if (type === 'segment') {
              editor.setJob({ kind: 'done', type, jobId });
              editor.setMask(job.outputUrl ?? null);
            } else {
              editor.setJob({ kind: 'done', type, jobId });
              if (job.outputUrl) {
                editor.pushHistory(editor.imageUrl ?? '');
                editor.setImage({
                  url: job.outputUrl,
                  id: type === 'generate' ? job.outputUrl : (editor.imageId ?? ''),
                  width: type === 'generate' ? 0 : editor.imageWidth,
                  height: type === 'generate' ? 0 : editor.imageHeight,
                  name: type === 'generate' ? 'Generated image' : editor.imageName,
                });
                void canvasRef.current?.setBaseImage(job.outputUrl).then(refreshZoom).catch(() => {});
              }
            }
            setBusy(false);
            return;
          }
          if (job.status === 'failed' || job.status === 'canceled') {
            console.error(`[job ${jobId}] ${type} failed: ${job.error ?? 'unknown'}`);
            editor.setJob({ kind: 'error', message: job.error ?? 'Job failed' });
            setError(job.error ?? 'Job failed');
            setBusy(false);
            return;
          }
          console.info(`[job ${jobId}] ${type} ${job.status} ${job.progress}% — ${job.stage ?? ''}`);
          editor.setJob({
            kind: 'running',
            type,
            stage: job.stage ?? 'working',
            progress: job.progress,
            jobId,
          });
          if (Date.now() - started < 5 * 60 * 1000) {
            pollRef.current = setTimeout(tick, JOB_POLL_INTERVAL_MS);
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
    [refreshZoom],
  );

  // Cleanup timer on unmount
  useEffect(() => () => {
    if (pollRef.current) clearTimeout(pollRef.current);
  }, []);

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
          const preview = rasterizeHint(hint, { width: 256, height: 256 });
          editor.setMask(null, maskToDataUrl(featherMask(preview, 256, 256, 2), 256, 256));
        } else {
          editor.setMask(null, null);
        }
      },
      onStrokeEnd: () => {
        // Magic select auto-runs SAM when the user finishes a stroke
        if (editor.tool === 'magic' && editor.imageId && editor.hint) {
          void runMagicSelect();
        }
      },
    });
    canvasRef.current = canvas;

    if (editor.imageUrl) {
      void canvas.setBaseImage(editor.imageUrl).then(refreshZoom).catch(() => {});
    }
    return () => {
      canvas.dispose();
      canvasRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    canvasRef.current?.setTool(editor.tool);
  }, [editor.tool]);

  useEffect(() => {
    if (editor.maskUrl) {
      void canvasRef.current?.setMaskOverlay(editor.maskUrl);
    } else if (!editor.maskDataUrl) {
      canvasRef.current?.clearMaskOverlay();
    }
  }, [editor.maskUrl, editor.maskDataUrl]);

  useEffect(() => {
    if (editor.imageUrl) {
      void canvasRef.current?.setBaseImage(editor.imageUrl).then(refreshZoom).catch(() => {});
      canvasRef.current?.clearMaskOverlay();
    }
  }, [editor.imageUrl, refreshZoom]);

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
      void canvasRef.current?.setBaseImage(asset.url).then(refreshZoom).catch(() => {});
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
      setError('Describe the change first');
      return;
    }
    let maskPayload: string;
    if (editor.maskUrl) {
      maskPayload = editor.maskUrl;
    } else if (editor.maskDataUrl) {
      maskPayload = editor.maskDataUrl;
    } else if (editor.hint) {
      const preview = rasterizeHint(editor.hint, { width: 512, height: 512 });
      maskPayload = maskToDataUrl(featherMask(preview, 512, 512, 4), 512, 512);
    } else {
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
  // Text-to-image (FLUX.1-schnell)
  // -------------------------------------------------------------------------
  async function runGenerateImage() {
    if (!genPrompt.trim()) {
      setError('Describe what to create');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      editor.setJob({ kind: 'running', type: 'generate', stage: 'queued', progress: 5, jobId: '' });
      const res = await api.generate({ prompt: genPrompt });
      pollJob(res.job.id, 'generate');
    } catch (err) {
      setError((err as Error).message);
      editor.clearJob();
      setBusy(false);
    }
  }

  // -------------------------------------------------------------------------
  // History (undo/redo) + project save + export
  // -------------------------------------------------------------------------
  function handleUndo() {
    const prev = editor.undo();
    if (prev) void canvasRef.current?.setBaseImage(prev).then(refreshZoom).catch(() => {});
  }

  function handleRedo() {
    const next = editor.redo();
    if (next) void canvasRef.current?.setBaseImage(next).then(refreshZoom).catch(() => {});
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
      await qc.invalidateQueries({ queryKey: ['project', res.project.id] });
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
        void canvasRef.current?.setBaseImage(head.imageUrl).then(refreshZoom).catch(() => {});
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRestore(versionId: string) {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      await api.restore(projectId, versionId);
      await qc.invalidateQueries({ queryKey: ['project', projectId] });
      await qc.invalidateQueries({ queryKey: ['projects'] });
      const { project } = await api.getProject(projectId);
      const head = project.versions.find((v) => v.isHead) ?? project.versions[0];
      if (head) {
        editor.pushHistory(editor.imageUrl ?? '');
        editor.setImage({
          url: head.imageUrl,
          id: head.imageUrl,
          width: 0,
          height: 0,
          name: project.name,
        });
        void canvasRef.current?.setBaseImage(head.imageUrl).then(refreshZoom).catch(() => {});
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function zoomIn() {
    canvasRef.current?.zoomBy(1.1);
    refreshZoom();
  }
  function zoomOut() {
    canvasRef.current?.zoomBy(1 / 1.1);
    refreshZoom();
  }
  function zoomReset() {
    canvasRef.current?.resetZoom();
    refreshZoom();
  }

  const job = editor.job;
  const running = job.kind === 'running';
  const statusText =
    job.kind === 'running'
      ? job.type === 'generate'
        ? 'Generating'
        : job.type === 'segment'
          ? 'Selecting'
          : 'Editing'
      : job.kind === 'error'
        ? 'Error'
        : job.kind === 'done'
          ? 'Done'
          : 'Ready';

  const dims = canvasRef.current?.getImageSize();
  const dimsText =
    dims?.width
      ? `${dims.width} x ${dims.height} px`
      : editor.imageWidth && editor.imageHeight
        ? `${editor.imageWidth} x ${editor.imageHeight} px`
        : editor.imageUrl
          ? 'Image loaded'
          : 'No image';

  return (
    <div className="flex h-full flex-col bg-background text-on-surface">
      {/* TopNavBar */}
      <header className="flex h-toolbar-height w-full items-center justify-between border-b border-outline-variant bg-surface px-panel-padding">
        <div className="flex items-center space-x-6">
          <span className="text-sm font-bold tracking-tight text-primary">Imaginative</span>
          <nav className="hidden space-x-1 md:flex">
            <button
              onClick={() => fileRef.current?.click()}
              className="border-b-2 border-primary px-3 py-1 text-xs font-bold text-primary"
            >
              Open
            </button>
            <button
              onClick={saveAsProject}
              disabled={busy || !editor.imageUrl}
              className="px-3 py-1 text-xs text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface disabled:opacity-40"
            >
              Save
            </button>
            <button
              onClick={exportImage}
              disabled={busy}
              className="px-3 py-1 text-xs text-on-surface-variant transition-colors hover:bg-surface-container-highest hover:text-on-surface disabled:opacity-40"
            >
              Export
            </button>
          </nav>
        </div>
        <div className="flex items-center space-x-4">
          <div className="hidden items-center space-x-2 sm:flex">
            <span className="ms cursor-pointer text-on-surface-variant transition-colors hover:text-primary" title="Share">
              share
            </span>
            <span className="ms cursor-pointer text-on-surface-variant transition-colors hover:text-primary" title="Settings">
              settings
            </span>
            <span className="ms cursor-pointer text-on-surface-variant transition-colors hover:text-primary" title="Help">
              help
            </span>
          </div>
          <button
            onClick={exportImage}
            disabled={busy}
            className="rounded bg-primary-container px-4 py-1 text-xs font-bold text-on-primary-container transition hover:bg-primary-fixed disabled:opacity-50"
          >
            Export
          </button>
          <button onClick={onLogout} title="Sign out" className="flex items-center gap-2">
            <div className="flex h-6 w-6 items-center justify-center overflow-hidden rounded-full border border-outline-variant bg-surface-container-high text-[10px] font-bold text-on-surface">
              {(user.name?.[0] ?? 'U').toUpperCase()}
            </div>
            <span className="ms hidden text-on-surface-variant transition-colors hover:text-primary sm:block" title="Sign out">
              logout
            </span>
          </button>
        </div>
      </header>

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

      <div className="relative flex flex-1 overflow-hidden">
        {/* Left SideNavBar (Toolbar) */}
        <aside className="z-40 flex w-16 flex-col items-center border-r border-outline-variant bg-surface py-panel-padding">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            title="Upload image"
            className="tool-btn mb-2 text-primary"
          >
            <span className="ms">upload</span>
          </button>
          <div className="my-2 h-px w-6 bg-outline-variant" />
          {TOOLS.map((t) => {
            const active = editor.tool === t.id;
            return (
              <button
                key={t.id}
                onClick={() => editor.setTool(t.id)}
                title={t.label}
                className={`tool-btn ${active ? 'active' : ''}`}
              >
                <span className="ms">{t.icon}</span>
              </button>
            );
          })}
          <div className="my-2 h-px w-6 bg-outline-variant" />
          <button
            onClick={handleUndo}
            disabled={editor.undoStack.length === 0}
            title="Undo"
            className="tool-btn"
          >
            <span className="ms">undo</span>
          </button>
          <button
            onClick={handleRedo}
            disabled={editor.redoStack.length === 0}
            title="Redo"
            className="tool-btn"
          >
            <span className="ms">redo</span>
          </button>
          <button
            onClick={() => {
              editor.setHint(null);
              editor.setMask(null, null);
              canvasRef.current?.clearDrawing();
            }}
            title="Clear selection"
            className="tool-btn"
          >
            <span className="ms">ink_eraser</span>
          </button>
        </aside>

        {/* Main Content Area (Canvas) */}
        <main className="canvas-bg relative flex flex-1 items-center justify-center overflow-hidden">
          <canvas ref={canvasHostRef} className="absolute inset-0 h-full w-full" />

          {error && (
            <div className="absolute left-1/2 top-3 z-20 flex -translate-x-1/2 items-center gap-3 rounded-lg border border-error-container bg-surface-container-lowest/95 px-4 py-2 text-xs text-on-error-container shadow-xl backdrop-blur">
              <span>{error}</span>
              <button onClick={() => setError(null)} className="font-bold">
                ✕
              </button>
            </div>
          )}

          {running && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-background/50 backdrop-blur-[2px]">
              <div className="animate-fade-in w-80 rounded-2xl border border-outline-variant bg-surface p-5 shadow-2xl">
                <div className="flex items-center gap-3">
                  <div className="relative flex h-10 w-10 shrink-0 items-center justify-center">
                    <span className="absolute inset-0 animate-spin rounded-full border-2 border-primary/20 border-t-primary" />
                    <span className="ms !text-lg text-primary">auto_fix_high</span>
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-on-surface">
                      {job.kind === 'running'
                        ? job.type === 'generate'
                          ? 'Generating image…'
                          : job.type === 'segment'
                            ? 'Selecting object…'
                            : 'Editing image…'
                        : ''}
                    </p>
                    <p className="truncate text-xs text-on-surface-variant">
                      {job.kind === 'running' ? job.stage : ''}
                    </p>
                  </div>
                </div>
                <div className="mt-4 h-1.5 w-full overflow-hidden rounded-full bg-surface-container-highest">
                  <div
                    className="h-full rounded-full bg-primary transition-all duration-500"
                    style={{
                      width: `${job.kind === 'running' ? Math.min(100, Math.max(5, job.progress)) : 0}%`,
                    }}
                  />
                </div>
                <div className="mt-2 flex items-center justify-between">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">
                    {job.kind === 'running' && job.type === 'generate' ? 'Text-to-image' : job.kind === 'running' && job.type === 'segment' ? 'SAM 2' : 'FLUX Kontext'}
                  </p>
                  <p className="font-mono text-[10px] text-on-surface-variant">
                    {job.kind === 'running' ? `${Math.round(job.progress)}%` : ''}
                  </p>
                </div>
              </div>
            </div>
          )}

          {!editor.imageUrl && !busy && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-12 text-center">
              <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl border border-outline-variant bg-surface-container-high">
                <span className="ms !text-3xl text-on-surface-variant">auto_fix_high</span>
              </div>
              <h2 className="text-lg font-semibold">Start creating</h2>
              <p className="mx-auto mt-1 max-w-xs text-sm text-on-surface-variant">
                Upload an image to edit it, or describe an image from scratch.
              </p>
              <div className="mt-4 flex justify-center gap-3">
                <button
                  onClick={() => fileRef.current?.click()}
                  className="rounded-lg bg-primary px-4 py-2 text-xs font-bold text-on-primary transition hover:bg-on-surface hover:text-surface"
                >
                  Upload image
                </button>
                <button
                  onClick={() => setTab('properties')}
                  className="rounded-lg border border-outline-variant px-4 py-2 text-xs font-bold text-on-surface transition hover:bg-surface-container-high"
                >
                  Generate from prompt
                </button>
              </div>
            </div>
          )}

          {/* On-canvas UI Hints */}
          {editor.imageUrl && (
            <div className="absolute right-3 top-3 z-10 rounded border border-outline-variant bg-surface-container-lowest/80 px-3 py-1 font-mono text-xs text-on-surface-variant backdrop-blur-md">
              {dimsText}
            </div>
          )}

          {/* Canvas Navigation Controls */}
          <div className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center space-x-6 rounded-full border border-outline-variant bg-surface-container-high/90 px-6 py-2.5 shadow-xl backdrop-blur-xl">
            <button onClick={zoomOut} className="ms text-on-surface-variant transition-colors hover:text-primary" title="Zoom out">
              zoom_out
            </button>
            <button onClick={zoomReset} className="w-10 text-center font-mono text-xs text-on-surface" title="Reset zoom">
              {zoomPct}%
            </button>
            <button onClick={zoomIn} className="ms text-on-surface-variant transition-colors hover:text-primary" title="Zoom in">
              zoom_in
            </button>
            <div className="h-5 w-px bg-outline-variant" />
            <button
              onClick={() => {
                canvasRef.current?.zoomToFit();
                refreshZoom();
              }}
              className="ms text-on-surface-variant transition-colors hover:text-primary"
              title="Fit to screen"
            >
              fit_screen
            </button>
          </div>
        </main>

        {/* Right SideNavBar (Inspector) */}
        <aside className="z-40 flex h-full w-sidebar-width flex-col border-l border-outline-variant bg-surface">
          {/* Inspector Tabs */}
          <div className="flex border-b border-outline-variant bg-surface-container-low">
            {(
              [
                ['properties', 'Properties'],
                ['layers', 'Layers'],
                ['history', 'History'],
              ] as [InspectorTab, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                className={`flex-1 py-3 text-xs transition-all duration-200 ${
                  tab === key ? 'border-b-2 border-primary font-bold text-primary' : 'text-on-surface-variant hover:bg-surface-container-highest'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="custom-scrollbar flex-1 space-y-8 overflow-y-auto p-panel-padding">
            {tab === 'properties' && (
              <>
                {/* AI Editing Section */}
                <div>
                  <h3 className="mb-5 text-[10px] uppercase tracking-[0.2em] text-on-surface-variant/60">
                    AI Generation
                  </h3>
                  <div className="space-y-4">
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-semibold text-on-surface">Strength</label>
                        <span className="font-mono text-xs font-bold text-on-surface">
                          {Math.round(editor.strength * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.1}
                        max={1}
                        step={0.05}
                        value={editor.strength}
                        onChange={(e) => editor.setStrength(Number(e.target.value))}
                        className="slider-thumb h-1 w-full cursor-pointer appearance-none rounded-full bg-surface-container-highest accent-primary"
                      />
                    </div>
                    <textarea
                      value={editor.prompt}
                      onChange={(e) => editor.setPrompt(e.target.value)}
                      placeholder="e.g. Replace the red car with a vintage blue car…"
                      rows={3}
                      className="w-full resize-none rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm outline-none focus:border-primary"
                    />
                    <button
                      onClick={runGenerate}
                      disabled={busy || !editor.imageUrl || !editor.prompt.trim()}
                      className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-xs font-bold text-on-primary transition hover:bg-on-surface hover:text-surface disabled:opacity-50"
                    >
                      <span className="ms !text-base">auto_fix_high</span>
                      {job.kind === 'running' && job.type === 'edit' ? 'Generating…' : 'Generate'}
                    </button>
                    {job.kind === 'done' && job.type === 'edit' && (
                      <div className="flex gap-2">
                        <button
                          onClick={() => {
                            editor.clearJob();
                            editor.setMask(null, null);
                          }}
                          className="flex-1 rounded-lg border border-outline-variant px-3 py-1.5 text-xs font-medium text-on-surface transition hover:border-primary hover:text-primary"
                        >
                          Keep
                        </button>
                        <button
                          onClick={handleUndo}
                          className="flex-1 rounded-lg border border-error/40 px-3 py-1.5 text-xs font-medium text-error transition hover:bg-error/10"
                        >
                          Discard
                        </button>
                      </div>
                    )}
                    <div className="h-px bg-outline-variant" />
                    <div className="space-y-3">
                      <label className="text-xs font-semibold text-on-surface">Create from scratch</label>
                      <textarea
                        value={genPrompt}
                        onChange={(e) => setGenPrompt(e.target.value)}
                        placeholder="e.g. A neon cyberpunk city street in the rain…"
                        rows={3}
                        className="w-full resize-none rounded-lg border border-outline-variant bg-surface-container-lowest px-3 py-2 text-sm outline-none focus:border-primary"
                      />
                      <button
                        onClick={runGenerateImage}
                        disabled={busy || !genPrompt.trim()}
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/60 py-2.5 text-xs font-bold text-primary transition hover:bg-primary/10 disabled:opacity-50"
                      >
                        <span className="ms !text-base">magic_button</span>
                        {job.kind === 'running' && job.type === 'generate' ? 'Generating…' : 'Generate from scratch'}
                      </button>
                    </div>
                  </div>
                </div>

                {/* Quick Edits */}
                <div>
                  <h3 className="mb-5 text-[10px] uppercase tracking-[0.2em] text-on-surface-variant/60">
                    Quick edits
                  </h3>
                  <div className="grid grid-cols-2 gap-2">
                    {EDIT_PRESETS.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => editor.setPrompt(p.prompt)}
                        className="rounded-lg border border-outline-variant px-2 py-2 text-left text-xs text-on-surface transition hover:border-primary/60 hover:text-primary"
                        title={p.hint}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Projects */}
                <div>
                  <div className="mb-5 flex items-center justify-between">
                    <h3 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant/60">
                      Projects
                    </h3>
                    <button
                      onClick={saveAsProject}
                      disabled={busy || !editor.imageUrl}
                      title="Save current image as a project"
                      className="ms !text-base text-on-surface-variant transition-colors hover:text-primary"
                    >
                      add
                    </button>
                  </div>
                  {projectsData?.projects.length ? (
                    <div className="space-y-2">
                      {projectsData.projects.map((p: ProjectSummary) => (
                        <div
                          key={p.id}
                          className="flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-2"
                        >
                          <img src={p.coverUrl} alt="" className="h-9 w-9 rounded-md object-cover" />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-xs font-medium text-on-surface">{p.name}</p>
                            <p className="text-[10px] text-on-surface-variant">{p.versionCount} versions</p>
                          </div>
                          <button
                            onClick={() => void loadProject(p)}
                            className="rounded-md border border-outline-variant px-2 py-1 text-[10px] text-on-surface transition hover:border-primary hover:text-primary"
                          >
                            Open
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-on-surface-variant">
                      No projects yet — save one to start your history.
                    </p>
                  )}
                </div>
              </>
            )}

            {tab === 'layers' && (
              <div>
                <h3 className="mb-5 text-[10px] uppercase tracking-[0.2em] text-on-surface-variant/60">Layers</h3>
                <div className="space-y-1">
                  <div className="flex items-center gap-3 rounded border border-outline-variant bg-surface-container-highest p-2.5 shadow-sm">
                    <span className="ms scale-75 text-primary">visibility</span>
                    <span className="ms scale-75 text-primary">image</span>
                    <span className="flex-1 truncate text-xs text-primary">
                      {editor.imageName || 'Background'}
                    </span>
                  </div>
                  {editor.maskUrl && (
                    <div className="flex items-center gap-3 rounded border border-transparent p-2.5 transition-colors hover:bg-surface-container-highest">
                      <span className="ms scale-75 text-on-surface-variant">visibility</span>
                      <span className="ms scale-75 text-on-surface-variant">auto_fix_high</span>
                      <span className="flex-1 truncate text-xs text-on-surface">Selection mask</span>
                    </div>
                  )}
                  {projectsData?.projects.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => void loadProject(p)}
                      className="flex w-full items-center gap-3 rounded border border-transparent p-2.5 text-left transition-colors hover:bg-surface-container-highest"
                    >
                      <span className="ms scale-75 text-on-surface-variant">visibility</span>
                      <span className="ms scale-75 text-on-surface-variant">layers</span>
                      <span className="flex-1 truncate text-xs text-on-surface">{p.name}</span>
                    </button>
                  ))}
                  {!editor.imageUrl && !projectsData?.projects.length && (
                    <p className="pt-2 text-xs text-on-surface-variant">No layers yet — upload an image.</p>
                  )}
                </div>
              </div>
            )}

            {tab === 'history' && (
              <div>
                <h3 className="mb-5 text-[10px] uppercase tracking-[0.2em] text-on-surface-variant/60">History</h3>
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={handleUndo}
                      disabled={editor.undoStack.length === 0}
                      className="flex items-center justify-center gap-1.5 rounded-lg border border-outline-variant px-3 py-2 text-xs font-medium text-on-surface transition hover:border-primary hover:text-primary disabled:opacity-40"
                    >
                      <span className="ms !text-base">undo</span> Undo
                    </button>
                    <button
                      onClick={handleRedo}
                      disabled={editor.redoStack.length === 0}
                      className="flex items-center justify-center gap-1.5 rounded-lg border border-outline-variant px-3 py-2 text-xs font-medium text-on-surface transition hover:border-primary hover:text-primary disabled:opacity-40"
                    >
                      <span className="ms !text-base">redo</span> Redo
                    </button>
                  </div>
                  <div className="h-px bg-outline-variant" />
                  <h3 className="text-[10px] uppercase tracking-[0.2em] text-on-surface-variant/60">Versions</h3>
                  {projectDetail && projectDetail.versions.length ? (
                    <div className="space-y-2">
                      {[...projectDetail.versions]
                        .sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))
                        .map((v) => (
                          <div
                            key={v.id}
                            className="flex items-center gap-2 rounded-lg border border-outline-variant bg-surface-container-low p-2"
                          >
                            <img src={v.imageUrl} alt="" className="h-9 w-9 rounded-md object-cover" />
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-xs font-medium text-on-surface">
                                {v.prompt || 'Version'}
                              </p>
                              <p className="text-[10px] text-on-surface-variant">
                                {new Date(v.createdAt).toLocaleString()}
                              </p>
                            </div>
                            {!v.isHead && (
                              <button
                                onClick={() => void handleRestore(v.id)}
                                className="rounded-md border border-outline-variant px-2 py-1 text-[10px] text-on-surface transition hover:border-primary hover:text-primary"
                              >
                                Restore
                              </button>
                            )}
                          </div>
                        ))}
                    </div>
                  ) : (
                    <p className="text-xs text-on-surface-variant">
                      Save a project to track versions of your image.
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Sidebar CTA */}
          <div className="border-t border-outline-variant bg-surface-container-low p-panel-padding">
            <button
              onClick={runGenerate}
              disabled={busy || !editor.imageUrl || !editor.prompt.trim()}
              className="w-full rounded-lg bg-primary py-3 text-xs font-bold text-on-primary transition hover:bg-on-surface hover:text-surface active:scale-[0.98] disabled:opacity-40"
            >
              Apply Changes
            </button>
          </div>
        </aside>
      </div>

      {/* Status Bar / Footer */}
      <footer className="flex h-6 items-center justify-between border-t border-outline-variant bg-surface-container-lowest px-4 font-mono text-[9px] uppercase tracking-wider text-on-surface-variant/80">
        <div className="flex items-center space-x-4">
          <span className={`font-bold ${running ? 'text-primary' : 'text-primary/80'}`}>{statusText}</span>
          <div className="h-3 w-px bg-outline-variant" />
          <div className="flex items-center space-x-1.5">
            <span className={`h-1.5 w-1.5 rounded-full ${running ? 'animate-pulse bg-primary' : 'bg-primary/60'}`} />
            <span>{running ? 'Processing…' : 'GPU Accelerated'}</span>
          </div>
        </div>
        <div className="flex space-x-6">
          <span>{dimsText}</span>
          <span>{zoomPct}%</span>
          <span className="text-on-surface">{user.email}</span>
        </div>
      </footer>
    </div>
  );
}
