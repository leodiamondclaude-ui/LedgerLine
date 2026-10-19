# Ledgerline

Bookkeeping for firms. Set up each client company with where it stands today, scan receipts with Claude, and see cash and profit at a glance.

- **Easy sign-in:** email and password, or a one-time sign-in link by email, plus password reset links and invite links for teammates and clients.
- **One private workspace per firm.** Staff see every company. Clients see only the companies they're given.
- **Companies in folder tabs** with labels, a ledger you can edit, CSV import and export, and reports.
- **Receipt scanning:** photos are read by Claude into date, vendor, amount and category for review.
- **Paid plans:** a free trial, then a Stripe subscription. Books stay readable when a trial ends.
- **Works on phones** and can be added to the home screen.

## Run it locally

Needs Node 22.13 or newer. There's nothing else to install: the database is SQLite, built into Node.

```bash
npm install
cp .env.example .env      # optional: fill in keys
npm start                 # http://localhost:3000
npm test                  # API tests
```

Without keys the app still works:
- receipt scanning is hidden;
- invite and reset links are printed in the server log;
- billing is off.

## Configuration

See `.env.example`. The main settings:

| Setting | What it does |
|---|---|
| `APP_URL` | Public address, used in emailed links. `https://` turns on secure cookies and HSTS. |
| `ANTHROPIC_API_KEY` | Turns on receipt scanning (Claude Opus 5.5, low effort, structured output). |
| `RESEND_API_KEY`, `MAIL_FROM` | Sends invite and reset emails. |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | Turns on the free trial and subscriptions. Point a Stripe webhook at `/api/stripe/webhook` with the `checkout.session.completed` and `customer.subscription.*` events. |
| `PRICE_LABEL` | Price shown on the front page after the free-trial line, for example `$49 a month per firm`. |
| `TRUST_PROXY=1` | Use behind a load balancer so sign-in limits see real visitor addresses. |

## Deploy

The Docker image keeps its database in `/data`, so mount a persistent volume there.

```bash
docker build -t ledgerline .
docker run -p 3000:3000 -v ledgerline-data:/data --env-file .env ledgerline
```

On Render, Railway or Fly.io:
1. Deploy from this repository using the Dockerfile.
2. Attach a disk or volume at `/data`.
3. Set the environment variables.
4. Point your domain at it.

Back up `/data/ledgerline.db` daily, for example with Litestream or the host's volume snapshots.

## Security notes

- **Passwords:** hashed with scrypt.
- **Sessions:** random tokens stored only as hashes, sent in `HttpOnly`, `SameSite=Lax` cookies.
- **Sign-in and reset:** both are rate-limited. Reset links work for one hour and only once, and using one signs out every other device.
- **Firm separation:** every query is scoped to the signed-in user's firm, and client access is checked per company.
- **Forged requests:** every request that changes data must carry the `X-Ledgerline` header and come from the app's own origin.
- **Injected scripts:** a strict content security policy (no inline scripts or styles) blocks them, and all stored text is escaped when shown.
- **Spreadsheet formulas:** CSV export neutralizes them.
- **Stripe webhooks:** signatures are verified.

## Before selling

- [ ] Finish `public/terms.html` and `public/privacy.html`. They're marked drafts; fill in the bracketed details and have a lawyer review them.
- [ ] Production domain with HTTPS, daily backups, and uptime monitoring.
- [ ] Stripe account, a product with a monthly price, and the webhook.
- [ ] Email sending domain (SPF/DKIM) for invites and resets.
- [ ] Anthropic API key with a spending limit.
