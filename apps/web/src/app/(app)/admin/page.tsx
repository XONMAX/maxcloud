'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { GB, formatBytes, getPlan } from '@maxcloud/shared';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { ApiError, get, post } from '@/lib/api';
import { useMe } from '@/lib/auth';

interface Overview {
  provider: string;
  pricePerTBMonth: number;
  users: number;
  payingUsers: number;
  mrrUsd: number;
  cogsUsd: number;
  grossMarginPct: number | null;
  freeTier: { users: number; storedGB: number; costUsd: number };
  revenue30d: { currency: string; total: number }[];
  tiers: { planId: string; name: string; subscribers: number; revenue: number; storedGB: number; avgUtilization: number; storageCogs: number; paymentFees: number; cogsRatio: number | null; alert: boolean }[];
  alerts: string[];
}
interface AdminUser {
  id: string;
  email: string;
  name: string;
  planId: string;
  quotaBytes: number;
  quotaOverride: number | null;
  usedBytes: number;
  storageCostUsd: number;
  storageState: string;
}
interface Report {
  id: string;
  kind: string;
  reporterEmail: string;
  description: string;
  status: string;
  shareToken: string | null;
  createdAt: string;
}

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="gap-1 py-4">
      <CardContent>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </CardContent>
    </Card>
  );
}

function OverviewTab() {
  const o = useQuery({ queryKey: ['admin-overview'], queryFn: () => get<Overview>('/admin/overview') });
  if (!o.data) return <p className="text-sm text-muted-foreground">Loading…</p>;
  const d = o.data;
  return (
    <div className="flex flex-col gap-6">
      {d.alerts.length > 0 && (
        <div role="alert" className="flex flex-col gap-1 rounded-lg border border-destructive/40 bg-destructive/10 p-4 text-sm" data-testid="cogs-alerts">
          {d.alerts.map((a) => (
            <div key={a} className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-destructive" /> {a}
            </div>
          ))}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="MRR (USD, normalised)" value={usd(d.mrrUsd)} hint={`${d.payingUsers} paying / ${d.users} users`} />
        <Kpi label="COGS / month" value={usd(d.cogsUsd)} hint={`storage @ ${d.provider.toUpperCase()} $${d.pricePerTBMonth}/TB + fees`} />
        <Kpi label="Gross margin" value={d.grossMarginPct === null ? '—' : `${d.grossMarginPct}%`} />
        <Kpi label="Free tier cost" value={usd(d.freeTier.costUsd)} hint={`${d.freeTier.users} users · ${d.freeTier.storedGB} GB`} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Unit economics by tier</CardTitle>
          <CardDescription>Alert when storage + payment fees exceed 60% of the tier's revenue.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm tabular-nums">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-2">Tier</th>
                <th>Subs</th>
                <th>Revenue/mo</th>
                <th>Stored</th>
                <th>Avg use</th>
                <th>Storage</th>
                <th>Fees</th>
                <th>COGS %</th>
              </tr>
            </thead>
            <tbody>
              {d.tiers.map((t) => (
                <tr key={t.planId} className="border-t" data-testid={`tier-${t.planId}`}>
                  <td className="py-2 font-medium">{t.name}</td>
                  <td>{t.subscribers}</td>
                  <td>{usd(t.revenue)}</td>
                  <td>{t.storedGB} GB</td>
                  <td>{(t.avgUtilization * 100).toFixed(0)}%</td>
                  <td>{usd(t.storageCogs)}</td>
                  <td>{usd(t.paymentFees)}</td>
                  <td>{t.alert ? <Badge variant="destructive">{t.cogsRatio === null ? '∞' : `${(t.cogsRatio * 100).toFixed(0)}%`}</Badge> : t.cogsRatio === null ? '—' : `${(t.cogsRatio * 100).toFixed(0)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Revenue, last 30 days (invoiced)</CardTitle>
        </CardHeader>
        <CardContent className="flex gap-6 text-sm">
          {d.revenue30d.length === 0 && <span className="text-muted-foreground">No paid invoices yet</span>}
          {d.revenue30d.map((r) => (
            <span key={r.currency}>{r.currency === 'UZS' ? `${(r.total / 100).toLocaleString()} so'm` : usd(r.total / 100)}</span>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function UsersTab() {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [gb, setGb] = useState('');
  const [reason, setReason] = useState('');
  const users = useQuery({ queryKey: ['admin-users', q], queryFn: () => get<{ items: AdminUser[] }>(`/admin/users?q=${encodeURIComponent(q)}`) });
  return (
    <div className="flex flex-col gap-4">
      <Input placeholder="Search email or name" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-sm" />
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-sm tabular-nums">
          <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
            <tr>
              <th className="p-2">User</th>
              <th>Plan</th>
              <th>Used / quota</th>
              <th>Storage cost/mo</th>
              <th>State</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.data?.items.map((u) => (
              <tr key={u.id} className="border-t">
                <td className="p-2">
                  <div>{u.name}</div>
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                </td>
                <td>{getPlan(u.planId).name}</td>
                <td>
                  {formatBytes(u.usedBytes)} / {formatBytes(u.quotaBytes)} {u.quotaOverride !== null && <Badge variant="outline">override</Badge>}
                </td>
                <td>${u.storageCostUsd.toFixed(4)}</td>
                <td>{u.storageState !== 'ACTIVE' ? <Badge variant="warning">{u.storageState}</Badge> : 'Active'}</td>
                <td>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditing(u);
                      setGb(u.quotaOverride === null ? '' : String(u.quotaOverride / GB));
                      setReason('');
                    }}
                  >
                    Quota
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Quota override · {editing?.email}</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await post(`/admin/users/${editing!.id}/quota`, { quotaBytes: gb === '' ? null : Math.round(Number(gb) * GB), reason });
                toast.success('Quota updated');
                setEditing(null);
                qc.invalidateQueries({ queryKey: ['admin-users'] });
              } catch (x) {
                toast.error(x instanceof ApiError ? x.message : 'Error');
              }
            }}
          >
            <Label htmlFor="gb">Quota in GB (empty = use plan)</Label>
            <Input id="gb" inputMode="decimal" value={gb} onChange={(e) => setGb(e.target.value)} />
            <Label htmlFor="reason">Reason (audit log)</Label>
            <Input id="reason" required minLength={3} value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button type="submit">Save</Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AbuseTab() {
  const qc = useQueryClient();
  const r = useQuery({ queryKey: ['admin-abuse'], queryFn: () => get<{ items: Report[] }>('/admin/abuse-reports?status=OPEN') });
  const resolve = async (id: string, action: 'ACTIONED' | 'REJECTED') => {
    const resolution = prompt(action === 'ACTIONED' ? 'Resolution note (content will be disabled):' : 'Why reject?');
    if (!resolution) return;
    await post(`/admin/abuse-reports/${id}/resolve`, { action, resolution });
    qc.invalidateQueries({ queryKey: ['admin-abuse'] });
  };
  return (
    <ul className="flex flex-col gap-3">
      {r.data?.items.length === 0 && <li className="text-sm text-muted-foreground">No open reports 🎉</li>}
      {r.data?.items.map((x) => (
        <Card key={x.id} className="gap-2 py-4">
          <CardContent className="flex flex-col gap-2 text-sm">
            <div className="flex items-center gap-2">
              <Badge>{x.kind}</Badge> {x.reporterEmail} · {new Date(x.createdAt).toLocaleString()}
              {x.shareToken && (
                <a className="text-primary underline" href={`/s/${x.shareToken}`} target="_blank" rel="noreferrer">
                  open link
                </a>
              )}
            </div>
            <p className="whitespace-pre-wrap">{x.description}</p>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={() => resolve(x.id, 'ACTIONED')}>
                Disable content
              </Button>
              <Button size="sm" variant="outline" onClick={() => resolve(x.id, 'REJECTED')}>
                Reject
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </ul>
  );
}

export default function AdminPage() {
  const me = useMe();
  if (me.data && me.data.role !== 'ADMIN') return <p>Admins only.</p>;
  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <Tabs defaultValue="overview" className="flex flex-col gap-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="abuse">Abuse & DMCA</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab />
        </TabsContent>
        <TabsContent value="users">
          <UsersTab />
        </TabsContent>
        <TabsContent value="abuse">
          <AbuseTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
