// SPDX-License-Identifier: MIT
/** The Stripe API calls the plugin makes, and checking Stripe's signature on its webhook events. */

/** The API version the plugin is written for (the objects' shapes it reads). */
export const API_VERSION = "2024-06-20";

/** Where the API is (tests point it elsewhere). */
export const endpoints = { api: "https://api.stripe.com" };

/** A failure Stripe answered with: its HTTP status, its type and code, and its message. */
export class StripeError extends Error {
  constructor(public status: number, public type: string | null, public code: string | null, message: string) {
    super(message);
    this.name = "StripeError";
  }

  /** Whether trying again might work (Stripe's side, too many requests, the network). */
  get retryable(): boolean { return this.status >= 500 || this.status === 429 || this.status === 0; }
}

/** Form fields as Stripe takes them: nested objects and lists as a[b][0][c]. */
export function encode(params: Record<string, unknown>, prefix = "", out = new URLSearchParams()): URLSearchParams {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (Array.isArray(value)) value.forEach((v, i) => typeof v === "object" && v !== null ? encode(v as Record<string, unknown>, `${name}[${i}]`, out) : out.append(`${name}[${i}]`, String(v)));
    else if (typeof value === "object") encode(value as Record<string, unknown>, name, out);
    else out.append(name, String(value));
  }
  return out;
}

export class Stripe {
  constructor(private readonly key: string) {}

  async request(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, unknown> = {}, idempotencyKey?: string): Promise<any> {
    const form = encode(params);
    const url = `${endpoints.api}${path}${method === "POST" || form.size === 0 ? "" : `?${form}`}`;
    let r: Response;
    try {
      r = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.key}`, "stripe-version": API_VERSION,
          ...(method === "POST" ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        },
        body: method === "POST" ? form : undefined,
      });
    } catch (e) {
      throw new StripeError(0, null, null, `Stripe can't be reached: ${(e as Error).message}`);
    }
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!r.ok) {
      const err = json?.error ?? {};
      throw new StripeError(r.status, err.type ?? null, err.code ?? null, err.message ?? `Stripe answered ${r.status}.`);
    }
    return json;
  }

  createCustomer(uid: string, email: string | null, name: string | null) {
    return this.request("POST", "/v1/customers", { email: email ?? undefined, name: name ?? undefined, metadata: { winche_uid: uid } }, `winche-customer-${uid}`);
  }
  customer(id: string) { return this.request("GET", `/v1/customers/${encodeURIComponent(id)}`); }
  price(id: string) { return this.request("GET", `/v1/prices/${encodeURIComponent(id)}`); }
  createCheckout(params: Record<string, unknown>) { return this.request("POST", "/v1/checkout/sessions", params); }
  createPortal(customer: string, returnUrl: string) { return this.request("POST", "/v1/billing_portal/sessions", { customer, return_url: returnUrl }); }
  subscriptions(customer: string) { return this.request("GET", "/v1/subscriptions", { customer, status: "all", limit: 20 }); }
  cancelAtPeriodEnd(id: string) { return this.request("POST", `/v1/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: true }); }
  resume(id: string) { return this.request("POST", `/v1/subscriptions/${encodeURIComponent(id)}`, { cancel_at_period_end: false }); }
  cancelNow(id: string) { return this.request("DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`); }

  /** The account's active prices, with their products. */
  activePrices() { return this.request("GET", "/v1/prices", { active: true, limit: 100, expand: ["data.product"] }); }
  /** A subscription item's quantity (seats), charged or credited for the rest of the period. */
  setQuantity(subscription: string, item: string, quantity: number) {
    return this.request("POST", `/v1/subscriptions/${encodeURIComponent(subscription)}`, { items: [{ id: item, quantity }], proration_behavior: "create_prorations" });
  }
  /** Usage for a billing meter (its event name), for one customer. */
  meterEvent(eventName: string, customer: string, value: number, identifier?: string) {
    return this.request("POST", "/v1/billing/meter_events", { event_name: eventName, payload: { stripe_customer_id: customer, value: String(value) }, identifier });
  }
  /** Refunds a payment, all of it or `amount` (in the currency's smallest unit). */
  refund(paymentIntent: string, amount: number | undefined, metadata: Record<string, string>) {
    return this.request("POST", "/v1/refunds", { payment_intent: paymentIntent, amount, metadata }, `winche-refund-${paymentIntent}-${amount ?? "all"}-${metadata.request ?? ""}`);
  }
  /** The Checkout session that made a payment, if one did. */
  checkoutOf(paymentIntent: string) { return this.request("GET", "/v1/checkout/sessions", { payment_intent: paymentIntent, limit: 1 }); }
  paymentIntent(id: string) { return this.request("GET", `/v1/payment_intents/${encodeURIComponent(id)}`); }
  /** The customer with this email (the newest), if any. */
  customerByEmail(email: string) { return this.request("GET", "/v1/customers", { email, limit: 1 }); }
  createCustomerByEmail(email: string, name: string | null) { return this.request("POST", "/v1/customers", { email, name: name ?? undefined }, `winche-customer-email-${email.toLowerCase()}`); }
  /** An invoice the customer pays later from Stripe's page (sent by email): one line, any amount. */
  async sendInvoice(i: { customer: string; amount: number; currency: string; description: string; daysUntilDue: number; metadata: Record<string, string> }) {
    const invoice = await this.request("POST", "/v1/invoices", {
      customer: i.customer, collection_method: "send_invoice", days_until_due: i.daysUntilDue, description: i.description, metadata: i.metadata,
      auto_advance: true, pending_invoice_items_behavior: "exclude",
    });
    await this.request("POST", "/v1/invoiceitems", { customer: i.customer, invoice: invoice.id, amount: i.amount, currency: i.currency, description: i.description, metadata: i.metadata });
    await this.request("POST", `/v1/invoices/${encodeURIComponent(invoice.id)}/finalize`, { auto_advance: true });
    return this.request("POST", `/v1/invoices/${encodeURIComponent(invoice.id)}/send`);
  }
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The event in `payload` when `header` (Stripe-Signature: t=…,v1=…) is Stripe's for it: HMAC-SHA256 with the webhook's
 * signing secret over "t.payload", made within `toleranceSeconds` of now. Null otherwise.
 */
export async function verifiedEvent(payload: string, header: string | null, secret: string, toleranceSeconds = 300, now = Date.now()): Promise<any | null> {
  if (!header) return null;
  const parts = header.split(",").map((p) => p.trim().split("=", 2) as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || signatures.length === 0) return null;
  if (Math.abs(now / 1000 - Number(t)) > toleranceSeconds) return null;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`))));
  const same = (s: string) => {
    if (s.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < s.length; i++) diff |= s.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  };
  if (!signatures.some(same)) return null;
  try { return JSON.parse(payload); } catch { return null; }
}
