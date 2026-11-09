/**
 * Browser upload engine: resumable S3 multipart uploads straight to storage.
 *
 * - Parts are PUT directly to presigned URLs (XHR for progress); the API only signs.
 * - 4 parts in flight; each part retries forever with exponential backoff (max 30 s),
 *   pausing while the browser is offline, so a 1 GB upload survives Wi-Fi drops.
 * - Survives reloads: uploadId is remembered per file fingerprint in localStorage; when
 *   the same file is picked again we ask the API which parts storage already has.
 */
import type { NodeDto, UploadSessionDto } from '@maxcloud/shared';
import { ApiError, api, post } from './api';

export type UploadState = 'queued' | 'uploading' | 'paused-offline' | 'completing' | 'done' | 'error' | 'cancelled';

export interface UploadTask {
  id: string;
  file: File;
  parentId: string | null;
  state: UploadState;
  sent: number;
  error?: string;
  node?: NodeDto;
  resumed?: boolean;
}

type Listener = (tasks: UploadTask[]) => void;

const CONCURRENCY = 4;
const STORE_KEY = 'mc_uploads_v1';

function fingerprint(f: File, parentId: string | null) {
  return `${parentId ?? 'root'}:${f.name}:${f.size}:${f.lastModified}`;
}

function loadStore(): Record<string, { uploadId: string; at: number }> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
  } catch {
    return {};
  }
}
function saveStore(s: Record<string, { uploadId: string; at: number }>) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(s));
  } catch {
    /* storage full or disabled: resume-after-reload just won't work */
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function waitOnline() {
  if (typeof navigator === 'undefined' || navigator.onLine) return Promise.resolve();
  return new Promise<void>((r) => window.addEventListener('online', () => r(), { once: true }));
}

/** PUT a Blob with progress; resolves to the ETag. */
function putPart(url: string, body: Blob, onProgress: (loaded: number) => void, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onProgress(e.loaded);
    xhr.onload = () => {
      const etag = xhr.getResponseHeader('ETag');
      if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
      else reject(Object.assign(new Error(`storage responded ${xhr.status}`), { status: xhr.status }));
    };
    xhr.onerror = () => reject(Object.assign(new Error('network error'), { status: 0 }));
    xhr.ontimeout = () => reject(Object.assign(new Error('timeout'), { status: 0 }));
    xhr.timeout = 5 * 60_000;
    signal.addEventListener('abort', () => xhr.abort());
    xhr.send(body);
  });
}

class Uploader {
  private tasks: UploadTask[] = [];
  private listeners = new Set<Listener>();
  private aborts = new Map<string, AbortController>();
  onComplete?: (node: NodeDto) => void;

  subscribe(l: Listener) {
    this.listeners.add(l);
    l(this.tasks);
    return () => void this.listeners.delete(l);
  }
  private emit() {
    this.tasks = [...this.tasks];
    for (const l of this.listeners) l(this.tasks);
  }
  private patch(id: string, p: Partial<UploadTask>) {
    this.tasks = this.tasks.map((t) => (t.id === id ? { ...t, ...p } : t));
    this.emit();
  }

  add(files: FileList | File[], parentId: string | null) {
    for (const file of Array.from(files)) {
      const task: UploadTask = { id: crypto.randomUUID(), file, parentId, state: 'queued', sent: 0 };
      this.tasks.push(task);
      void this.run(task.id);
    }
    this.emit();
  }

  cancel(id: string) {
    this.aborts.get(id)?.abort();
    this.patch(id, { state: 'cancelled' });
  }

  clearFinished() {
    this.tasks = this.tasks.filter((t) => !['done', 'cancelled', 'error'].includes(t.state));
    this.emit();
  }

  private async session(task: UploadTask): Promise<UploadSessionDto> {
    const fp = fingerprint(task.file, task.parentId);
    const store = loadStore();
    const known = store[fp];
    if (known) {
      try {
        const s = await api<UploadSessionDto>(`/uploads/${known.uploadId}`);
        this.patch(task.id, { resumed: true });
        return s;
      } catch {
        delete store[fp];
        saveStore(store);
      }
    }
    const s = await post<UploadSessionDto>('/uploads', { name: task.file.name, parentId: task.parentId, size: task.file.size, mimeType: task.file.type || 'application/octet-stream' });
    if (s.uploadId) {
      store[fp] = { uploadId: s.uploadId, at: Date.now() };
      saveStore(store);
    }
    return s;
  }

  private async run(id: string) {
    const task = this.tasks.find((t) => t.id === id)!;
    const ctrl = new AbortController();
    this.aborts.set(id, ctrl);
    const fp = fingerprint(task.file, task.parentId);
    try {
      this.patch(id, { state: 'uploading' });
      const s = await this.session(task);
      if (s.deduplicatedNode) {
        this.patch(id, { state: 'done', sent: task.file.size, node: s.deduplicatedNode });
        return;
      }
      const done = new Map(s.completedParts.map((p) => [p.partNumber, p.etag]));
      const progress = new Map<number, number>();
      for (const p of s.completedParts) progress.set(p.partNumber, p.size);
      const report = () => this.patch(id, { sent: [...progress.values()].reduce((a, b) => a + b, 0) });
      report();

      const todo = Array.from({ length: s.partCount }, (_, i) => i + 1).filter((n) => !done.has(n));
      let cursor = 0;
      const urlCache = new Map<number, string>();
      const urlFor = async (n: number, fresh = false) => {
        if (!fresh && urlCache.has(n)) return urlCache.get(n)!;
        const batch = fresh ? [n] : todo.slice(todo.indexOf(n), todo.indexOf(n) + 20);
        const r = await post<{ parts: { partNumber: number; url: string }[] }>(`/uploads/${s.uploadId}/parts`, { partNumbers: batch });
        for (const p of r.parts) urlCache.set(p.partNumber, p.url);
        return urlCache.get(n)!;
      };

      const worker = async () => {
        while (cursor < todo.length) {
          if (ctrl.signal.aborted) return;
          const n = todo[cursor++];
          const blob = task.file.slice((n - 1) * s.partSize, n * s.partSize);
          for (let attempt = 0; ; attempt++) {
            if (ctrl.signal.aborted) return;
            try {
              await waitOnline();
              const url = await urlFor(n, attempt > 0);
              const etag = await putPart(url, blob, (loaded) => {
                progress.set(n, loaded);
                report();
              }, ctrl.signal);
              done.set(n, etag);
              progress.set(n, blob.size);
              report();
              break;
            } catch (e) {
              if (ctrl.signal.aborted) return;
              if (e instanceof ApiError && e.status < 500 && e.status !== 429) throw e; // upload expired / forbidden: give up
              progress.set(n, 0);
              this.patch(id, { state: navigator.onLine ? 'uploading' : 'paused-offline' });
              await sleep(Math.min(30_000, 1000 * 2 ** attempt) * (0.5 + Math.random()));
              this.patch(id, { state: 'uploading' });
            }
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, Math.max(1, todo.length)) }, worker));
      if (ctrl.signal.aborted) {
        await api(`/uploads/${s.uploadId}`, { method: 'DELETE' }).catch(() => undefined);
        return;
      }
      this.patch(id, { state: 'completing' });
      let node: NodeDto | undefined;
      for (let attempt = 0; !node; attempt++) {
        try {
          node = await post<NodeDto>(`/uploads/${s.uploadId}/complete`, { parts: [...done].map(([partNumber, etag]) => ({ partNumber, etag })) });
        } catch (e) {
          if (e instanceof ApiError && e.status < 500) throw e;
          await waitOnline();
          await sleep(Math.min(30_000, 1000 * 2 ** attempt));
        }
      }
      const store = loadStore();
      delete store[fp];
      saveStore(store);
      this.patch(id, { state: 'done', sent: task.file.size, node });
      this.onComplete?.(node);
    } catch (e) {
      const store = loadStore();
      delete store[fp];
      saveStore(store);
      this.patch(id, { state: 'error', error: e instanceof ApiError ? e.message : (e as Error).message });
    } finally {
      this.aborts.delete(id);
    }
  }
}

export const uploader = new Uploader();
