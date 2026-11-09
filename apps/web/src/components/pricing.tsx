'use client';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { PLANS, formatMoney, type BillingInterval, type Currency, type PlanDef } from '@maxcloud/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, Tabs, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export function PricingTable({
  currentPlanId,
  onSelect,
  cta = 'Choose',
}: {
  currentPlanId?: string;
  onSelect: (plan: PlanDef, interval: BillingInterval, currency: Currency) => void;
  cta?: string;
}) {
  const { t, locale } = useI18n();
  const [interval, setInterval] = useState<BillingInterval>('year');
  const [currency, setCurrency] = useState<Currency>(locale === 'en' ? 'USD' : 'UZS');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Tabs value={interval} onValueChange={(v) => setInterval(v as BillingInterval)}>
          <TabsList>
            <TabsTrigger value="month">{t('pricing.month')}</TabsTrigger>
            <TabsTrigger value="year">{t('pricing.year')}</TabsTrigger>
          </TabsList>
        </Tabs>
        <Tabs value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
          <TabsList>
            <TabsTrigger value="UZS">so'm</TabsTrigger>
            <TabsTrigger value="USD">USD</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {PLANS.map((p) => {
          const price = interval === 'month' ? p.monthly[currency] : p.yearly[currency];
          const current = p.id === currentPlanId;
          const popular = p.id === 's250';
          return (
            <Card key={p.id} className={cn('gap-4', popular && 'border-primary ring-1 ring-primary')} data-testid={`plan-${p.id}`}>
              <CardHeader>
                <CardTitle className="text-2xl">{p.name}</CardTitle>
                {popular && <span className="text-xs font-medium text-primary">Most popular</span>}
              </CardHeader>
              <CardContent className="flex flex-1 flex-col gap-4">
                <div>
                  <span className="text-2xl font-semibold">{p.id === 'free' ? '0' : formatMoney(price, currency)}</span>
                  {p.id !== 'free' && <span className="text-sm text-muted-foreground">{interval === 'month' ? t('pricing.perMonth') : t('pricing.perYear')}</span>}
                  {p.id !== 'free' && interval === 'year' && (
                    <div className="text-xs text-muted-foreground">≈ {formatMoney(Math.round(p.yearly[currency] / 12), currency)}/mo</div>
                  )}
                </div>
                <ul className="flex flex-col gap-1.5 text-sm text-muted-foreground">
                  {['Phone & PC apps', 'Photo auto-backup', 'Share links with password', p.id === 'free' ? '30-day trash' : '10 file versions'].map((f) => (
                    <li key={f} className="flex items-center gap-2">
                      <Check className="size-4 text-success" /> {f}
                    </li>
                  ))}
                </ul>
                <Button className="mt-auto" variant={current ? 'secondary' : popular ? 'default' : 'outline'} disabled={current} onClick={() => onSelect(p, interval, currency)}>
                  {current ? 'Current plan' : p.id === 'free' ? 'Free' : cta}
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
