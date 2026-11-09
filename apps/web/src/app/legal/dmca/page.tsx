'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Label } from '@/components/ui/primitives';
import { ApiError, post } from '@/lib/api';

function Form() {
  const params = useSearchParams();
  const [form, setForm] = useState({ kind: 'DMCA', shareToken: params.get('link') ?? '', reporterEmail: '', reporterName: '', description: '', goodFaith: false });
  const [done, setDone] = useState<string | null>(null);
  if (done) return <p className="rounded-md border p-4">{done}</p>;
  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const r = await post<{ ok: boolean; id?: string; message?: string }>('/public/abuse-reports', { ...form, shareToken: form.shareToken.replace(/.*\/s\//, '') || undefined });
          setDone(r.ok ? `Thank you. Reference: ${r.id}. We review reports within 2 business days.` : (r.message ?? 'Could not submit'));
        } catch (x) {
          setDone(x instanceof ApiError ? x.message : 'Network error');
        }
      }}
    >
      <Label htmlFor="kind">Type</Label>
      <select id="kind" className="h-9 rounded-md border bg-background px-2" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
        <option value="DMCA">Copyright infringement (DMCA)</option>
        <option value="ABUSE">Illegal or abusive content</option>
        <option value="MALWARE">Malware / phishing</option>
      </select>
      <Label htmlFor="link">Link to the content</Label>
      <Input id="link" value={form.shareToken} onChange={(e) => setForm({ ...form, shareToken: e.target.value })} placeholder="https://maxcloud.uz/s/…" />
      <Label htmlFor="name">Your name</Label>
      <Input id="name" value={form.reporterName} onChange={(e) => setForm({ ...form, reporterName: e.target.value })} />
      <Label htmlFor="email">Your email</Label>
      <Input id="email" type="email" required value={form.reporterEmail} onChange={(e) => setForm({ ...form, reporterEmail: e.target.value })} />
      <Label htmlFor="desc">Description (for DMCA: identify the copyrighted work and your authority to act)</Label>
      <textarea id="desc" required minLength={20} rows={5} className="rounded-md border bg-background p-2" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      {form.kind === 'DMCA' && (
        <label className="flex gap-2 text-xs">
          <input type="checkbox" checked={form.goodFaith} onChange={(e) => setForm({ ...form, goodFaith: e.target.checked })} />I have a good-faith belief that this use is not authorized by the copyright owner, its agent, or the law, and the information in this notice is accurate. Under penalty of perjury, I am authorized to act on behalf of the owner.
        </label>
      )}
      <Button type="submit" className="w-fit">
        Submit report
      </Button>
    </form>
  );
}

export default function Dmca() {
  return (
    <>
      <h1>Copyright &amp; abuse reports</h1>
      <p>To report content shared through MaxCloud, use the form below or email abuse@maxcloud.uz. We disable access to infringing or illegal content and notify the uploader, who may send a counter-notice. Repeat infringers lose their accounts.</p>
      <Suspense>
        <Form />
      </Suspense>
    </>
  );
}
