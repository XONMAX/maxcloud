export const metadata = { title: 'Privacy Policy' };

/* DRAFT — must be reviewed by a lawyer licensed in Uzbekistan before launch (see docs/LAUNCH_CHECKLIST.md). */
export default function Privacy() {
  return (
    <>
      <h1>Privacy Policy</h1>
      <p className="text-muted-foreground">Draft · last updated 9 November 2026</p>
      <h2>What we collect</h2>
      <ul>
        <li>Account data: email, name, language, password hash (never the password), two-factor settings.</li>
        <li>Your files and their names, sizes and types.</li>
        <li>Device and session data: device name, IP address, sign-in times. We use it to show you your devices and to protect your account.</li>
        <li>Billing data: plan, invoices, and payment status. Card numbers are handled by Stripe, Payme, Click or Uzum and never reach our servers.</li>
      </ul>
      <h2>What we do with it</h2>
      <p>We use it to run the service, secure your account, bill you, and send service emails (for example storage warnings). We do not sell personal data and we do not use your files for advertising or to train AI models.</p>
      <h2>Processors</h2>
      <ul>
        <li>Object storage: Backblaze B2 (EU Central region by default), Cloudflare R2 or Wasabi.</li>
        <li>Content delivery and security: Cloudflare.</li>
        <li>Payments: Stripe, Payme, Click, Uzum.</li>
        <li>Error monitoring: Sentry (no file contents).</li>
      </ul>
      <h2>Data residency</h2>
      <p>
        [DRAFT — fill in before launch] Uzbekistan&apos;s Law on Personal Data (ZRU-547, Article 27-1) requires personal data of citizens of Uzbekistan to be collected, systematised and stored in databases physically located in
        Uzbekistan. This section must state where MaxCloud actually stores account data and file contents once the hosting decision in docs/ARCHITECTURE.md (&quot;Data residency&quot;) is made and a local lawyer has signed off.
      </p>
      <h2>Security</h2>
      <p>Files are encrypted at rest with AES-256 and in transit with TLS. Optional two-factor authentication protects your account. Uploaded files are scanned for malware.</p>
      <h2>How long we keep data</h2>
      <ul>
        <li>Files in Trash: 30 days. Old versions: up to 10 per file.</li>
        <li>Deleted accounts: removed 7 days after you ask (so you can change your mind). Invoices are kept as long as tax law requires, with your personal details removed.</li>
      </ul>
      <h2>Your rights</h2>
      <p>You can download a copy of your data and delete your account in Settings. You can also email privacy@maxcloud.uz to access, correct or delete your data.</p>
    </>
  );
}
