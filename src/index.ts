// SPDX-License-Identifier: MIT
/**
 * @winche-technologies/winche-plugin-stripe: payments and subscriptions with Stripe, as a Winche plugin.
 *
 * Installed as "payments" (its functions are then payments.checkout, …):
 *   - checkout (callable): { price, quantity? } → { url, id }: a Checkout page for the signed-in user (a subscription
 *     for a recurring price, a payment otherwise), their Stripe customer made the first time.
 *   - portal (callable): → { url }: Stripe's customer portal (cards, invoices, changing or cancelling the plan).
 *   - subscription (callable): → { plan, subscription }: the user's subscription now, read from Stripe.
 *   - cancel (callable): { now?, resume? } → { plan, subscription }: at the period's end (or now), or undo that.
 *   - webhook (HTTP): Stripe's events, checked against its signature: each user's subscription kept on their document
 *     and in their plan claim, one-off purchases recorded.
 * The project's own code (ctx.byServer) can call the callables for a user by giving their uid.
 */

import { callable, http, plugin, HttpsError, type Context } from "@winche-technologies/winche-functions";
import { auth, documents } from "@winche-technologies/winche-admin";
import { Stripe, StripeError, verifiedEvent } from "./stripe.js";

export { Stripe, StripeError, verifiedEvent, encode, endpoints, API_VERSION } from "./stripe.js";

/** A callable's answer for a failure Stripe gave: what the app can act on, never the account's details. */
function asHttpsError(e: unknown): never {
  if (e instanceof HttpsError) throw e;
  if (e instanceof StripeError) {
    if (e.status === 401 || e.status === 403) throw new HttpsError("failed-precondition", "Stripe refused the secret key: check it (and a restricted key's permissions).");
    if (e.status === 429) throw new HttpsError("resource-exhausted", "Stripe is limiting requests: try again shortly.");
    if (e.retryable) throw new HttpsError("unavailable", "Stripe can't be reached now: try again.");
    if (e.status === 404) throw new HttpsError("not-found", e.message);
    throw new HttpsError("invalid-argument", e.message, { stripeCode: e.code });
  }
  throw e;
}

/** "a=b, c=d" → { a: "b", c: "d" }. */
export function pairs(text: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (text ?? "").split(",")) {
    const eq = part.indexOf("=");
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

/** "a, b" → ["a", "b"]. */
const list = (text: string | null | undefined) => (text ?? "").split(",").map((s) => s.trim()).filter(Boolean);

/** Statuses a subscriber keeps their plan in (past_due: Stripe is still retrying the payment). */
export const PLAN_STATUSES = ["active", "trialing", "past_due"];

export interface SubscriptionSummary {
  id: string;
  status: string;
  plan: string | null;
  price: string | null;
  product: string | null;
  quantity: number | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
}

/** The subscription that counts: one in a plan status (active and trialing first), else the newest. */
export function summarize(subscriptions: any[], plans: Record<string, string>): { plan: string | null; subscription: SubscriptionSummary | null } {
  const rank = (s: any) => (s.status === "active" || s.status === "trialing" ? 0 : s.status === "past_due" ? 1 : 2);
  const sorted = [...subscriptions].sort((a, b) => rank(a) - rank(b) || (b.created ?? 0) - (a.created ?? 0));
  const s = sorted[0];
  if (!s) return { plan: null, subscription: null };
  const item = s.items?.data?.[0];
  const price = item?.price;
  const product = typeof price?.product === "string" ? price.product : price?.product?.id ?? null;
  const plan = price ? plans[price.id] ?? price.lookup_key ?? product : null;
  const date = (n: unknown) => (typeof n === "number" ? new Date(n * 1000) : null);
  const subscription: SubscriptionSummary = {
    id: s.id, status: s.status, plan, price: price?.id ?? null, product, quantity: item?.quantity ?? null,
    currentPeriodEnd: date(s.current_period_end ?? item?.current_period_end), cancelAtPeriodEnd: s.cancel_at_period_end === true, trialEnd: date(s.trial_end),
  };
  return { plan: PLAN_STATUSES.includes(s.status) ? plan : null, subscription };
}

export default plugin((p) => {
  const secretKey = p.secret("SECRET_KEY");
  const webhookSecret = p.secret("WEBHOOK_SECRET");
  const stripe = () => new Stripe(secretKey.value());
  const collection = (p.setting<string>("COLLECTION") ?? "billing").trim() || "billing";
  const record = p.setting<boolean>("RECORD_SUBSCRIPTIONS") !== false;
  const planClaim = (p.setting<string>("PLAN_CLAIM") ?? "").trim();
  const plans = pairs(p.setting<string>("PLANS"));
  const prices = list(p.setting<string>("PRICES"));
  const userDoc = (uid: string) => documents.collection(collection).doc(uid);

  /** Whose billing this is: the signed-in caller, or the uid the project's own code gives. */
  const whose = (ctx: Context, d: any): { uid: string; email: string | null; name: string | null } => {
    if (ctx.caller) {
      const t = ctx.caller.token ?? {};
      return { uid: ctx.caller.uid, email: typeof t.email === "string" ? t.email : null, name: typeof t.name === "string" ? t.name : null };
    }
    if (ctx.byServer) {
      if (typeof d?.uid !== "string" || !d.uid) throw new HttpsError("invalid-argument", "Give the user's uid (the server calls for a user).");
      return { uid: d.uid, email: typeof d.email === "string" ? d.email : null, name: null };
    }
    throw new HttpsError("unauthenticated", "Sign in first.");
  };

  /** The user's Stripe customer: the one kept on their document, else a new one (with their uid, once). */
  const customerFor = async (who: { uid: string; email: string | null; name: string | null }, create: boolean): Promise<string | null> => {
    const snap = await userDoc(who.uid).get();
    const kept = snap.exists ? snap.get("customerId") : null;
    if (typeof kept === "string" && kept) return kept;
    if (!create) return null;
    const c = await stripe().createCustomer(who.uid, who.email, who.name);
    await userDoc(who.uid).set({ customerId: c.id }, { merge: true });
    return c.id;
  };

  /** Brings the user's document and plan claim in line with their subscriptions in Stripe now; returns them. */
  const sync = async (uid: string, customerId: string) => {
    const subs = await stripe().subscriptions(customerId);
    const now = summarize(subs.data ?? [], plans);
    await userDoc(uid).set(record ? { customerId, plan: now.plan, subscription: now.subscription, updatedAt: new Date() } : { customerId }, { merge: true });
    if (planClaim) {
      const user = auth.user(uid);
      let claims: Record<string, unknown> = {};
      try { claims = (await user.getCustomClaims()) ?? {}; } catch { return now; }   // no such user (deleted, or another app's customer)
      if ((claims[planClaim] ?? null) !== now.plan) {
        const next: Record<string, unknown> = { ...claims };
        if (now.plan) next[planClaim] = now.plan; else delete next[planClaim];
        await user.setCustomClaims(next as never);
      }
    }
    return now;
  };

  /** The uid behind a customer: on its subscription or session, else on the customer in Stripe. */
  const uidOf = async (customerId: string, metadata?: Record<string, string> | null): Promise<string | null> => {
    if (metadata?.winche_uid) return metadata.winche_uid;
    const c = await stripe().customer(customerId);
    return c?.metadata?.winche_uid ?? null;
  };

  const signedIn = { secrets: [secretKey] };

  return {
    checkout: callable(async (d: any, ctx) => {
      const who = whose(ctx, d);
      if (typeof d?.price !== "string" || !d.price.startsWith("price_")) throw new HttpsError("invalid-argument", "price is a Stripe price ID (price_…).");
      if (prices.length > 0 && !prices.includes(d.price)) throw new HttpsError("invalid-argument", "That price isn't on offer here.");
      const quantity = d.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 999) throw new HttpsError("invalid-argument", "quantity is a whole number from 1 to 999.");
      try {
        const price = await stripe().price(d.price);
        if (!price.active) throw new HttpsError("failed-precondition", "That price isn't active in Stripe.");
        const subscription = !!price.recurring;
        const customer = (await customerFor(who, true))!;
        if (subscription) {
          const current = summarize((await stripe().subscriptions(customer)).data ?? [], plans);
          if (current.plan) throw new HttpsError("already-exists", "There's a subscription already: change it in the customer portal (portal).");
        }
        const trial = p.setting<number>("TRIAL_DAYS") ?? 0;
        const tax = p.setting<boolean>("AUTOMATIC_TAX") === true;
        const meta = { winche_uid: who.uid, price: d.price };
        const session = await stripe().createCheckout({
          mode: subscription ? "subscription" : "payment",
          customer, client_reference_id: who.uid,
          line_items: [{ price: d.price, quantity }],
          success_url: p.setting<string>("SUCCESS_URL"), cancel_url: p.setting<string>("CANCEL_URL"),
          allow_promotion_codes: p.setting<boolean>("PROMOTION_CODES") === true ? true : undefined,
          automatic_tax: tax ? { enabled: true } : undefined,
          customer_update: tax ? { address: "auto" } : undefined,
          metadata: meta,
          ...(subscription
            ? { subscription_data: { metadata: meta, ...(trial > 0 ? { trial_period_days: trial } : {}) } }
            : { payment_intent_data: { metadata: meta } }),
        });
        return { url: session.url, id: session.id };
      } catch (e) { asHttpsError(e); }
    }, {
      ...signedIn,
      description: "A Checkout page for a price: { price, quantity? } → { url, id }. Open the url in a browser.",
      input: { type: "object", properties: { price: { type: "string" }, quantity: { type: "integer" } }, required: ["price"] },
      output: { type: "object", properties: { url: { type: "string" }, id: { type: "string" } } },
    }),

    portal: callable(async (d: any, ctx) => {
      const who = whose(ctx, d);
      try {
        const customer = await customerFor(who, false);
        if (!customer) throw new HttpsError("failed-precondition", "There's nothing to manage yet: start a checkout first.");
        const back = (p.setting<string>("PORTAL_RETURN_URL") ?? "").trim() || p.setting<string>("CANCEL_URL");
        const session = await stripe().createPortal(customer, back);
        return { url: session.url };
      } catch (e) { asHttpsError(e); }
    }, { ...signedIn, description: "Stripe's customer portal for the user: → { url } (cards, invoices, changing or cancelling the plan)." }),

    subscription: callable(async (d: any, ctx) => {
      const who = whose(ctx, d);
      try {
        const customer = await customerFor(who, false);
        return customer ? await sync(who.uid, customer) : { plan: null, subscription: null };
      } catch (e) { asHttpsError(e); }
    }, { ...signedIn, description: "The user's subscription now, read from Stripe: → { plan, subscription }." }),

    cancel: callable(async (d: any, ctx) => {
      const who = whose(ctx, d);
      try {
        const customer = await customerFor(who, false);
        const current = customer ? summarize((await stripe().subscriptions(customer)).data ?? [], plans).subscription : null;
        if (!customer || !current || !PLAN_STATUSES.includes(current.status)) throw new HttpsError("failed-precondition", "There's no subscription to cancel.");
        if (d?.resume === true) await stripe().resume(current.id);
        else if (d?.now === true) await stripe().cancelNow(current.id);
        else await stripe().cancelAtPeriodEnd(current.id);
        return await sync(who.uid, customer);
      } catch (e) { asHttpsError(e); }
    }, {
      ...signedIn,
      description: "Cancels the user's subscription at the end of its period ({ now: true }: at once; { resume: true }: undoes a cancellation) → { plan, subscription }.",
      input: { type: "object", properties: { now: { type: "boolean" }, resume: { type: "boolean" } } },
    }),

    webhook: http.onRequest(async (req) => {
      const payload = await req.text();
      const event = await verifiedEvent(payload, req.headers.get("stripe-signature"), webhookSecret.value());
      if (!event) return new Response("This request isn't Stripe's (or the webhook signing secret isn't this endpoint's).", { status: 400 });
      const o = event.data?.object ?? {};
      switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded": {
          const uid = o.client_reference_id ?? o.metadata?.winche_uid ?? null;
          if (!uid || typeof o.customer !== "string") break;
          if (o.mode === "subscription") { await sync(uid, o.customer); break; }
          if (record && o.payment_status === "paid")
            await userDoc(uid).collection("purchases").doc(o.id).set({
              price: o.metadata?.price ?? null, amount: o.amount_total ?? null, currency: o.currency ?? null,
              paymentIntent: o.payment_intent ?? null, at: new Date((event.created ?? Date.now() / 1000) * 1000),
            });
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
        case "customer.subscription.paused":
        case "customer.subscription.resumed":
        case "invoice.paid":
        case "invoice.payment_failed": {
          const customer = typeof o.customer === "string" ? o.customer : o.customer?.id;
          if (!customer) break;
          const uid = await uidOf(customer, event.type.startsWith("customer.subscription") ? o.metadata : o.subscription_details?.metadata);
          if (uid) await sync(uid, customer);
          break;
        }
      }
      return { received: true };   // anything else: acknowledged, nothing to do
    }, { methods: ["POST"], secrets: [secretKey, webhookSecret], description: "Stripe's events (add it as a webhook endpoint in Stripe): subscriptions kept on users, purchases recorded." }),
  };
});
