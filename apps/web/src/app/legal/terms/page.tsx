export const metadata = { title: 'Terms of Service' };

/* DRAFT — must be reviewed by a lawyer licensed in Uzbekistan before launch (see docs/LAUNCH_CHECKLIST.md). */
export default function Terms() {
  return (
    <>
      <h1>Terms of Service</h1>
      <p className="text-muted-foreground">Draft · last updated 9 November 2026</p>
      <h2>1. Who we are</h2>
      <p>MaxCloud (&quot;we&quot;) provides online file storage. The service is operated by the legal entity named on your invoices.</p>
      <h2>2. Your account</h2>
      <ul>
        <li>You must be at least 16 years old, or have consent from a parent or guardian.</li>
        <li>Keep your password and two-factor codes safe. You are responsible for activity on your account.</li>
      </ul>
      <h2>3. Your files</h2>
      <p>You keep all rights to your files. You give us only the permission needed to store, process (for example, to make thumbnails and scan for malware) and deliver them to you and to people you share them with.</p>
      <h2>4. Plans, payment and renewals</h2>
      <ul>
        <li>Card subscriptions renew automatically until you cancel. Cancelling takes effect at the end of the paid period.</li>
        <li>Prepaid plans (Payme, Click, Uzum) last for the period you bought. We remind you 3 days before they end.</li>
        <li>Upgrades take effect immediately. Card upgrades are charged the prorated difference; prepaid upgrades convert your unused days into extra days on the new plan.</li>
        <li>Annual plans cost 10 months&apos; price.</li>
      </ul>
      <h2>5. Storage limits, grace period and deletion</h2>
      <p>If your files exceed your plan (for example after a downgrade or a failed payment), you get a 7-day grace period during which your previous limit still applies. After that, your account becomes read-only: you can view, download and delete files but not upload. If you are still over the limit 30 days later, we delete files above your limit, starting with Trash, then old versions, then the most recently uploaded files. We email you 30, 7 and 1 day before deletion.</p>
      <h2>6. Acceptable use</h2>
      <ul>
        <li>No illegal content, malware, content that infringes others&apos; rights, or content that sexually exploits minors.</li>
        <li>No using MaxCloud as a public file-hosting or CDN service for large audiences.</li>
        <li>We may disable links or suspend accounts that break these rules. Reports: see the DMCA &amp; abuse page.</li>
      </ul>
      <h2>7. Availability and liability</h2>
      <p>We work to keep the service available and your data durable, but we can&apos;t guarantee it will never be interrupted. Keep a second copy of irreplaceable files. Our liability is limited to the amount you paid us in the 12 months before the claim, to the extent the law allows.</p>
      <h2>8. Ending the service</h2>
      <p>You can delete your account at any time in Settings. We will give at least 60 days&apos; notice before shutting down the service so you can download your files.</p>
      <h2>9. Governing law</h2>
      <p>These terms are governed by the laws of the Republic of Uzbekistan.</p>
    </>
  );
}
