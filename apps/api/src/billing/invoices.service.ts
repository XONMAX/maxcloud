import { Injectable } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import { formatMoney, getPlan } from '@maxcloud/shared';
import { PrismaService } from '../common/prisma.service';
import { Errors } from '../common/errors';

/** Seller details come from env so legal can change them without a deploy of code. */
function seller() {
  return {
    name: process.env.COMPANY_LEGAL_NAME ?? 'MaxCloud LLC',
    address: process.env.COMPANY_ADDRESS ?? 'Tashkent, Uzbekistan',
    tin: process.env.COMPANY_TIN ?? '—',
    email: process.env.COMPANY_BILLING_EMAIL ?? 'billing@maxcloud.uz',
  };
}

@Injectable()
export class InvoicesService {
  constructor(private prisma: PrismaService) {}

  async pdf(userId: string, invoiceId: string): Promise<{ filename: string; buffer: Buffer }> {
    const inv = await this.prisma.invoice.findUnique({ where: { id: invoiceId }, include: { user: true } });
    if (!inv || inv.userId !== userId) throw Errors.notFound('Invoice');
    const s = seller();
    const doc = new PDFDocument({ size: 'A4', margin: 56, info: { Title: `Invoice ${inv.number}`, Author: s.name } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<void>((r) => doc.on('end', () => r()));

    const money = formatMoney(inv.amount, inv.currency as 'USD' | 'UZS').replace("so'm", 'UZS');
    const d = (x: Date) => x.toISOString().slice(0, 10);

    doc.fillColor('#1d6fe0').fontSize(22).text('MaxCloud', { continued: true }).fillColor('#111').fontSize(22).text('  Invoice / Hisob-faktura', { align: 'left' });
    doc.moveDown(0.5).fontSize(10).fillColor('#555');
    doc.text(`Invoice no.: ${inv.number}`);
    doc.text(`Date: ${d(inv.paidAt ?? inv.createdAt)}`);
    doc.text(`Status: ${inv.status}`);
    doc.moveDown();

    const top = doc.y;
    doc.fillColor('#111').fontSize(11).text('From', 56, top, { underline: true });
    doc.fontSize(10).text(s.name).text(s.address).text(`TIN/INN: ${s.tin}`).text(s.email);
    doc.fontSize(11).text('Bill to', 320, top, { underline: true });
    doc.fontSize(10).text(inv.user.name, 320).text(inv.user.email, 320);
    doc.moveDown(2);

    const y = Math.max(doc.y, top + 90);
    doc.moveTo(56, y).lineTo(539, y).strokeColor('#ddd').stroke();
    doc.fontSize(10).fillColor('#555').text('Description', 56, y + 8).text('Period', 300, y + 8).text('Amount', 460, y + 8, { width: 79, align: 'right' });
    const plan = getPlan(inv.planId);
    doc.fillColor('#111')
      .text(`MaxCloud ${plan.name} storage — ${inv.interval === 'month' ? 'monthly' : 'yearly'} plan`, 56, y + 28, { width: 230 })
      .text(`${d(inv.periodStart)} – ${d(inv.periodEnd)}`, 300, y + 28)
      .text(money, 440, y + 28, { width: 99, align: 'right' });
    doc.moveTo(56, y + 60).lineTo(539, y + 60).strokeColor('#ddd').stroke();
    doc.fontSize(12).text(`Total paid: ${money}`, 56, y + 72, { align: 'right', width: 483 });
    doc.moveDown(2).fontSize(9).fillColor('#777');
    doc.text(`Paid via ${inv.provider}. ${inv.currency === 'UZS' ? 'Price includes VAT where applicable; the fiscal receipt is issued by the payment provider.' : 'Charged in USD.'}`, 56);
    doc.text('Questions? Reply to billing@maxcloud.uz with the invoice number.');
    doc.end();
    await done;
    return { filename: `${inv.number}.pdf`, buffer: Buffer.concat(chunks) };
  }
}
