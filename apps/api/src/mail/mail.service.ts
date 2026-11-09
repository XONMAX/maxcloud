import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config';
import { render, type TemplateId } from './templates';

export interface SentMail {
  to: string;
  subject: string;
  text: string;
}

/**
 * SMTP mailer. With no SMTP_URL configured (local dev/tests) it logs the
 * message and keeps it in `outbox` so tests can assert on it.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger(MailService.name);
  private transport: Transporter | null;
  readonly outbox: SentMail[] = [];

  constructor() {
    const url = config().SMTP_URL;
    this.transport = url ? nodemailer.createTransport(url) : null;
  }

  async send(to: string, template: TemplateId, locale: string, vars: Record<string, string | number>) {
    const { subject, text } = render(template, locale, vars);
    const mail = { to, subject, text };
    this.outbox.push(mail);
    if (this.outbox.length > 200) this.outbox.shift();
    if (!this.transport) {
      this.log.log(`[mail:dev] to=${to} subject="${subject}"\n${text}`);
      return;
    }
    await this.transport.sendMail({ from: config().MAIL_FROM, to, subject, text });
  }
}
