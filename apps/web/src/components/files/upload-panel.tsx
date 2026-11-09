'use client';
import { CheckCircle2, CloudOff, Loader2, X, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatBytes } from '@maxcloud/shared';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/primitives';
import { uploader, type UploadTask } from '@/lib/uploader';

export function UploadPanel() {
  const [tasks, setTasks] = useState<UploadTask[]>([]);
  useEffect(() => uploader.subscribe(setTasks), []);
  if (!tasks.length) return null;
  const active = tasks.filter((t) => !['done', 'error', 'cancelled'].includes(t.state)).length;
  return (
    <div className="fixed right-4 bottom-4 z-40 w-[min(24rem,calc(100vw-2rem))] rounded-xl border bg-popover shadow-lg" data-testid="upload-panel">
      <div className="flex items-center justify-between border-b px-4 py-2 text-sm font-medium">
        {active ? `Uploading ${active} file${active > 1 ? 's' : ''}` : 'Uploads complete'}
        {!active && (
          <Button size="icon" variant="ghost" aria-label="Close uploads" onClick={() => uploader.clearFinished()}>
            <X />
          </Button>
        )}
      </div>
      <ul className="max-h-72 overflow-y-auto">
        {tasks.map((t) => {
          const pct = t.file.size ? (t.sent / t.file.size) * 100 : 100;
          return (
            <li key={t.id} className="flex items-center gap-3 px-4 py-2 text-sm" data-testid="upload-row" data-state={t.state}>
              <div className="min-w-0 flex-1">
                <div className="truncate">{t.file.name}</div>
                {t.state === 'error' ? (
                  <div className="text-xs text-destructive">{t.error}</div>
                ) : t.state === 'done' ? (
                  <div className="text-xs text-muted-foreground">{formatBytes(t.file.size)}</div>
                ) : (
                  <>
                    <Progress value={pct} className="mt-1 h-1.5" />
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {t.state === 'paused-offline' ? 'Waiting for connection…' : t.state === 'completing' ? 'Finishing…' : `${formatBytes(t.sent)} of ${formatBytes(t.file.size)}`}
                      {t.resumed && ' · resumed'}
                    </div>
                  </>
                )}
              </div>
              {t.state === 'done' && <CheckCircle2 className="size-4 text-success" />}
              {t.state === 'error' && <XCircle className="size-4 text-destructive" />}
              {t.state === 'paused-offline' && <CloudOff className="size-4 text-warning" />}
              {['uploading', 'queued', 'completing'].includes(t.state) && (
                <>
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  <Button size="icon" variant="ghost" aria-label={`Cancel ${t.file.name}`} onClick={() => uploader.cancel(t.id)}>
                    <X />
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
