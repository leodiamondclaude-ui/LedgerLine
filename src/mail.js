// Sends through Resend when RESEND_API_KEY is set; otherwise prints the message so links still work in development
export async function sendMail({ to, subject, text }) {
  if (!process.env.RESEND_API_KEY) {
    console.log(`\n[email to ${to}] ${subject}\n${text}\n`);
    return false;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: process.env.MAIL_FROM || 'Ledgerline <no-reply@ledgerline.app>', to, subject, text }),
  });
  if (!res.ok) throw new Error(`Email failed (${res.status})`);
  return true;
}
