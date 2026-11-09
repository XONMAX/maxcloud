-- Gap-free-enough sequential invoice numbers (MC-2026-000001). Sequences never roll back,
-- so a failed transaction can leave a gap; accountants accept that if voided numbers are logged.
CREATE SEQUENCE IF NOT EXISTS "InvoiceNumberSeq" START 1;
