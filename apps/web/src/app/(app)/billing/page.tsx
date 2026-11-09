'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, FileDown, Smartphone } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { formatBytes, getPlan, type BillingInterval, type Currency, type PlanDef } from '@maxcloud/shared';
import { PricingTable } from '@/components/pricing';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/primitives';
import { ApiError, get, post } from '@/lib/api';
import { useMe } from '@/lib/auth';

interface BillingStatus {
  planId: string;
  subscription: null | {
    provider: string;
    planId: string;
    interval: BillingInterval;
    status: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
    recurring: boolean;
  };
  invoices: { id: string; number: string; display: string; status: string; planId: string; paidAt: string | null; hostedUrl: string | null }[];
}
interface Providers {
  providers: { id: string; currency: string; recurring: boolean; available: boolean }[];
}

const err = (e: unknown) => toast.error(e instanceof ApiError ? e.message : 'Network error');

function Billing() {
  const me = useMe();
  const qc = useQueryClient();
  const params = useSearchParams();
  const status = useQuery({ queryKey: ['billing'], queryFn: () => get<BillingStatus>('/billing') });
  const providers = useQuery({ queryKey: ['billing-plans'], queryFn: () => get<Providers>('/billing/plans') });
  const [choice, setChoice] = useState<{ plan: PlanDef; interval: BillingInterval; currency: Currency } | null>(null);

  useEffect(() => {
    const s = params.get('status');
    if (s === 'success' || params.get('order')) {
      toast.success('Payment received. Your plan will update in a few seconds.');
      const t = setInterval(() => {
        qc.invalidateQueries({ queryKey: ['billing'] });
        qc.invalidateQueries({ queryKey: ['me'] });
      }, 3000);
      setTimeout(() => clearInterval(t), 30_000);
      return () => clearInterval(t);
    }
    if (s === 'cancelled') toast('Checkout cancelled');
    const plan = params.get('plan');
    if (plan && plan !== 'free') {
      try {
        setChoice({ plan: getPlan(plan), interval: params.get('interval') === 'month' ? 'month' : 'year', currency: 'UZS' });
      } catch {
        /* unknown plan id in URL */
      }
    }
  }, [params, qc]);

  const sub = status.data?.subscription;
  const available = (id: string) => providers.data?.providers.find((p) => p.id === id)?.available;

  const checkout = async (provider: string) => {
    if (!choice) return;
    try {
      if (sub?.recurring && provider === 'stripe') {
        await post('/billing/change-plan', { planId: choice.plan.id, interval: choice.interval });
        toast.success('Plan changed. Prorated difference charged to your card.');
        setChoice(null);
        qc.invalidateQueries({ queryKey: ['billing'] });
        qc.invalidateQueries({ queryKey: ['me'] });
        return;
      }
      const r = await post<{ url: string }>('/billing/checkout', { planId: choice.plan.id, interval: choice.interval, provider });
      location.href = r.url;
    } catch (e) {
      err(e);
    }
  };

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Plan & billing</h1>
        <p className="text-sm text-muted-foreground">
          {me.data && `${formatBytes(me.data.usedBytes)} of ${formatBytes(me.data.quotaBytes)} used`}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Current plan: {getPlan(status.data?.planId ?? 'free').name}
            {sub?.status === 'PAST_DUE' && <Badge variant="destructive">Payment overdue</Badge>}
            {sub?.cancelAtPeriodEnd && <Badge variant="warning">Ends {new Date(sub.currentPeriodEnd).toLocaleDateString()}</Badge>}
          </CardTitle>
          <CardDescription>
            {!sub && 'Free forever, 5 GB.'}
            {sub &&
              (sub.recurring
                ? `Renews automatically on ${new Date(sub.currentPeriodEnd).toLocaleDateString()} (${sub.interval === 'month' ? 'monthly' : 'yearly'}, card).`
                : `Paid with ${sub.provider} until ${new Date(sub.currentPeriodEnd).toLocaleDateString()}. We'll remind you 3 days before it ends.`)}
          </CardDescription>
        </CardHeader>
        {sub && (
          <CardContent className="flex flex-wrap gap-2">
            {sub.recurring && (
              <Button
                variant="outline"
                onClick={async () => {
                  try {
                    location.href = (await post<{ url: string }>('/billing/portal')).url;
                  } catch (e) {
                    err(e);
                  }
                }}
              >
                <CreditCard /> Manage card & invoices
              </Button>
            )}
            {!sub.cancelAtPeriodEnd && (
              <Button
                variant="ghost"
                onClick={async () => {
                  if (!confirm('Cancel at the end of the paid period? Files above 5 GB will need to be removed within 7 days after that.')) return;
                  try {
                    await post('/billing/change-plan', { planId: 'free', interval: 'month' });
                    qc.invalidateQueries({ queryKey: ['billing'] });
                  } catch (e) {
                    err(e);
                  }
                }}
              >
                Cancel plan
              </Button>
            )}
          </CardContent>
        )}
      </Card>

      <PricingTable currentPlanId={status.data?.planId} onSelect={(plan, interval, currency) => plan.id !== 'free' && setChoice({ plan, interval, currency })} cta="Upgrade" />

      <Card>
        <CardHeader>
          <CardTitle>Invoices</CardTitle>
        </CardHeader>
        <CardContent>
          {!status.data?.invoices.length && <p className="text-sm text-muted-foreground">No invoices yet.</p>}
          <ul className="divide-y">
            {status.data?.invoices.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="font-mono">{i.number}</span>
                <span className="text-muted-foreground">{i.paidAt && new Date(i.paidAt).toLocaleDateString()}</span>
                <span className="flex-1">{getPlan(i.planId).name}</span>
                <span>{i.display}</span>
                <Badge variant={i.status === 'PAID' ? 'secondary' : 'outline'}>{i.status}</Badge>
                <Button size="sm" variant="ghost" asChild>
                  <a href={`/api/billing/invoices/${i.id}/pdf`}>
                    <FileDown /> PDF
                  </a>
                </Button>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Dialog open={!!choice} onOpenChange={(o) => !o && setChoice(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {choice?.plan.name} · {choice?.interval === 'month' ? 'monthly' : 'yearly'}
            </DialogTitle>
            <DialogDescription>Choose how to pay.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <Button size="lg" variant="outline" className="justify-start" disabled={!available('payme') || sub?.recurring} onClick={() => checkout('payme')}>
              <Smartphone /> Payme (Uzcard, Humo) · so'm {!available('payme') && '— unavailable'}
            </Button>
            <Button size="lg" variant="outline" className="justify-start" disabled>
              <Smartphone /> Click · coming soon
            </Button>
            <Button size="lg" variant="outline" className="justify-start" disabled>
              <Smartphone /> Uzum · coming soon
            </Button>
            <Button size="lg" variant="outline" className="justify-start" disabled={!available('stripe') || (!!sub && !sub.recurring)} onClick={() => checkout('stripe')}>
              <CreditCard /> Visa / Mastercard · USD {sub?.recurring ? '(prorated change)' : '(auto-renews)'} {!available('stripe') && '— unavailable'}
            </Button>
            <p className="text-xs text-muted-foreground">
              Upgrades take effect immediately. Prepaid plans (Payme) convert unused days of your current plan into extra days on the new one.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default function BillingPage() {
  return (
    <Suspense>
      <Billing />
    </Suspense>
  );
}
