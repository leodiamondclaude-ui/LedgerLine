import crypto from 'node:crypto';

// Stripe is optional: without STRIPE_SECRET_KEY every firm can use the app freely (self-hosting, your own firm)
export const billingEnabled = () => !!process.env.STRIPE_SECRET_KEY && !!process.env.STRIPE_PRICE_ID;
export const TRIAL_DAYS = Number(process.env.TRIAL_DAYS || 14);
const ACTIVE = new Set(['active', 'trialing']);

export function billingState(firm) {
  if (!billingEnabled()) return { enabled: false, canWrite: true };
  const inTrial = firm.trial_ends_at > Date.now();
  const status = firm.subscription_status || null;
  return { enabled: true, status, trialEndsAt: firm.trial_ends_at, inTrial, canWrite: inTrial || ACTIVE.has(status) };
}

async function stripe(path, params) {
  const res = await fetch('https://api.stripe.com/v1/' + path, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error?.message || `Stripe error ${res.status}`);
  return body;
}

export async function checkoutUrl(db, firm, user, appUrl) {
  let customer = firm.stripe_customer_id;
  if (!customer) {
    customer = (await stripe('customers', { email: user.email, name: firm.name, 'metadata[firm_id]': String(firm.id) })).id;
    db.prepare('UPDATE firms SET stripe_customer_id = ? WHERE id = ?').run(customer, firm.id);
  }
  const session = await stripe('checkout/sessions', {
    mode: 'subscription', customer,
    'line_items[0][price]': process.env.STRIPE_PRICE_ID, 'line_items[0][quantity]': '1',
    client_reference_id: String(firm.id),
    success_url: `${appUrl}/?billing=done`, cancel_url: `${appUrl}/?billing=cancelled`,
  });
  return session.url;
}

export async function portalUrl(firm, appUrl) {
  if (!firm.stripe_customer_id) throw new Error('This firm has no subscription yet.');
  return (await stripe('billing_portal/sessions', { customer: firm.stripe_customer_id, return_url: appUrl })).url;
}

// Verifies the Stripe-Signature header (t=...,v1=...) over the raw body
export function verifyWebhook(raw, header, secret = process.env.STRIPE_WEBHOOK_SECRET, toleranceSec = 300) {
  if (!secret || !header) return null;
  const parts = Object.fromEntries(header.split(',').map(p => p.split('=')).filter(p => p.length === 2 && p[0] !== 'v1'));
  const sigs = header.split(',').filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return null;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  const ok = sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
  return ok ? JSON.parse(raw) : null;
}

export function applyWebhook(db, event) {
  const o = event.data?.object || {};
  if (event.type === 'checkout.session.completed' && o.client_reference_id) {
    db.prepare('UPDATE firms SET stripe_customer_id = COALESCE(stripe_customer_id, ?), subscription_status = ? WHERE id = ?')
      .run(o.customer || null, 'active', Number(o.client_reference_id));
  } else if (event.type?.startsWith('customer.subscription.') && o.customer) {
    const status = event.type === 'customer.subscription.deleted' ? 'canceled' : o.status;
    db.prepare('UPDATE firms SET subscription_status = ? WHERE stripe_customer_id = ?').run(status, o.customer);
  }
}
