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
 *   - pay (callable): { amount, currency, description } → { url, id }: a Checkout page for any amount, paid now.
 *   - bill (callable): { uid | email, amount, currency, description, dueDays? } → the invoice: Stripe emails it, with
 *     its own page to pay it later.
 *   - prices (callable): the prices on offer, with their products, for a pricing page.
 *   - setQuantity (callable): { quantity } → seats on the user's subscription, charged or credited for the rest of it.
 *   - reportUsage (callable, the project's own code): { meter, value } → usage for a Stripe billing meter.
 *   - refund (callable, the project's own code or as set): { uid, purchase, amount? } → a refund.
 *   - webhook (HTTP): Stripe's events, checked against its signature: each user's subscriptions kept on their document
 *     and in their plan claim; purchases (with refunds and disputes) and invoices recorded.
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
  /** The subscription item (for its seats). */
  item?: string | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  trialEnd: Date | null;
}

/** The subscription that counts: one in a plan status (active and trialing first), else the newest. */
export function summarize(subscriptions: any[], plans: Record<string, string>): { plan: string | null; subscription: SubscriptionSummary | null } {
  const all = summarizeAll(subscriptions, plans);
  return { plan: all.plans[0] ?? null, subscription: all.subscriptions[0] ?? null };
}

/** Every subscription, the ones that count first, and the plans of those in a plan status. */
export function summarizeAll(subscriptions: any[], plans: Record<string, string>): { plans: string[]; subscriptions: SubscriptionSummary[] } {
  const rank = (s: any) => (s.status === "active" || s.status === "trialing" ? 0 : s.status === "past_due" ? 1 : 2);
  const sorted = [...subscriptions].sort((a, b) => rank(a) - rank(b) || (b.created ?? 0) - (a.created ?? 0));
  const date = (n: unknown) => (typeof n === "number" ? new Date(n * 1000) : null);
  const list = sorted.map((s): SubscriptionSummary => {
    const item = s.items?.data?.[0];
    const price = item?.price;
    const product = typeof price?.product === "string" ? price.product : price?.product?.id ?? null;
    return {
      id: s.id, status: s.status, plan: price ? plans[price.id] ?? price.lookup_key ?? product : null, price: price?.id ?? null, product,
      quantity: item?.quantity ?? null, item: item?.id ?? null,
      currentPeriodEnd: date(s.current_period_end ?? item?.current_period_end), cancelAtPeriodEnd: s.cancel_at_period_end === true, trialEnd: date(s.trial_end),
    };
  });
  const active = list.filter((s) => PLAN_STATUSES.includes(s.status) && s.plan).map((s) => s.plan!);
  return { plans: [...new Set(active)], subscriptions: list };
}

/** Whether the caller's token has the claim: "admin" (any true value) or "role=admin" (that value, or in a list). */
export function hasClaim(caller: { token?: Record<string, unknown> } | null | undefined, claim: string | null | undefined): boolean {
  const c = (claim ?? "").trim();
  if (!caller || !c) return false;
  const [name, want] = c.includes("=") ? [c.slice(0, c.indexOf("=")).trim(), c.slice(c.indexOf("=") + 1).trim()] : [c, null];
  const v = caller.token?.[name];
  if (want === null) return v === true || (typeof v === "string" && v !== "") || (Array.isArray(v) && v.length > 0);
  return v === want || (Array.isArray(v) && v.includes(want));
}

/** An amount in the currency's smallest unit (pence, cents): a whole number from the minimum to the maximum. */
export function checkAmount(amount: unknown, min: number, max: number): number {
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 1)
    throw new HttpsError("invalid-argument", "amount is a whole number in the currency's smallest unit (1999 is £19.99).");
  if (amount < min || amount > max) throw new HttpsError("invalid-argument", `amount is ${min} to ${max} (in the currency's smallest unit).`);
  return amount;
}

/** A purchase or invoice's record from Stripe's objects. */
const when = (n: unknown) => (typeof n === "number" ? new Date(n * 1000) : null);
export function invoiceRecord(i: any) {
  return {
    number: i.number ?? null, status: i.status ?? null, description: i.description ?? i.lines?.data?.[0]?.description ?? null,
    amountDue: i.amount_due ?? null, amountPaid: i.amount_paid ?? null, currency: i.currency ?? null,
    hostedUrl: i.hosted_invoice_url ?? null, pdf: i.invoice_pdf ?? null, dueDate: when(i.due_date), created: when(i.created),
    subscription: typeof i.subscription === "string" ? i.subscription : i.parent?.subscription_details?.subscription ?? null, updatedAt: new Date(),
  };
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
  const multiple = p.setting<boolean>("MULTIPLE_SUBSCRIPTIONS") === true;
  const currencies = list(p.setting<string>("CURRENCIES") || "gbp").map((c) => c.toLowerCase());
  const minAmount = Number(p.setting<number>("MIN_AMOUNT") ?? 50);
  const maxAmount = Number(p.setting<number>("MAX_AMOUNT") ?? 100000);
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

  /** Whether the caller may do what <setting> allows: server (the project's own code), signed-in, or claim <claim setting>. */
  const allowed = (ctx: Context, setting: string, claimSetting: string, what: string) => {
    if (ctx.byServer) return;
    const who = p.setting<string>(setting);
    if (who === "signed-in" && ctx.caller) return;
    if (who === "claim" && hasClaim(ctx.caller, p.setting<string>(claimSetting))) return;
    throw new HttpsError(ctx.caller ? "permission-denied" : "unauthenticated", `${what} by the project's own code${who === "claim" ? " and users with its claim" : who === "signed-in" ? " and signed-in users" : ""} here.`);
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
    const all = summarizeAll(subs.data ?? [], plans);
    const plan = all.plans[0] ?? null;
    const now = multiple ? { plan, plans: all.plans, subscription: all.subscriptions[0] ?? null, subscriptions: all.subscriptions }
      : { plan, subscription: all.subscriptions[0] ?? null };
    await userDoc(uid).set(record ? { customerId, ...now, updatedAt: new Date() } : { customerId }, { merge: true });
    if (planClaim) {
      const user = auth.user(uid);
      let claims: Record<string, unknown> = {};
      try { claims = (await user.getCustomClaims()) ?? {}; } catch { return now; }   // no such user (deleted, or another app's customer)
      const want: unknown = multiple ? (all.plans.length ? all.plans : null) : plan;
      if (JSON.stringify(claims[planClaim] ?? null) !== JSON.stringify(want)) {
        const next: Record<string, unknown> = { ...claims };
        if (want) next[planClaim] = want; else delete next[planClaim];
        await user.setCustomClaims(next as never);
      }
    }
    return now;
  };

  /** The uid behind a customer: on its subscription, session or invoice, else on the customer in Stripe. */
  const uidOf = async (customerId: string, metadata?: Record<string, string> | null): Promise<string | null> => {
    if (metadata?.winche_uid) return metadata.winche_uid;
    const c = await stripe().customer(customerId);
    return c?.metadata?.winche_uid ?? null;
  };

  /** The subscription a call is about: the one given, else the user's only one that counts. */
  const pickSubscription = (all: SubscriptionSummary[], id: unknown) => {
    const live = all.filter((s) => PLAN_STATUSES.includes(s.status));
    if (typeof id === "string") return live.find((s) => s.id === id) ?? null;
    if (live.length > 1) throw new HttpsError("invalid-argument", "There are several subscriptions: say which (subscription).");
    return live[0] ?? null;
  };

  /**
   * The purchase a payment (its payment intent) is recorded as, under its user. Stripe may send a refund or dispute
   * before the checkout's own event: then the purchase it will be (its Checkout session's), written to first.
   */
  const purchaseOf = async (uid: string, paymentIntent: string) => {
    const found = await userDoc(uid).collection("purchases").where("paymentIntent", "==", paymentIntent).limit(1).get();
    if (!found.empty) return found.docs[0].reference;
    const session = (await stripe().checkoutOf(paymentIntent)).data?.[0];
    if (!session?.id || (session.client_reference_id ?? session.metadata?.winche_uid) !== uid) return null;
    const ref = userDoc(uid).collection("purchases").doc(session.id);
    await ref.set({ paymentIntent }, { merge: true });
    return ref;
  };

  const signedIn = { secrets: [secretKey] };
  const tax = () => p.setting<boolean>("AUTOMATIC_TAX") === true;

  return {
    checkout: callable(async (d: any, ctx) => {
      const who = whose(ctx, d);
      const items: { price: string; quantity: number }[] = Array.isArray(d?.items) ? d.items : [{ price: d?.price, quantity: d?.quantity ?? 1 }];
      if (items.length === 0 || items.length > 20) throw new HttpsError("invalid-argument", "items is 1 to 20 { price, quantity }.");
      for (const it of items) {
        if (typeof it?.price !== "string" || !it.price.startsWith("price_")) throw new HttpsError("invalid-argument", "price is a Stripe price ID (price_…).");
        if (prices.length > 0 && !prices.includes(it.price)) throw new HttpsError("invalid-argument", `${it.price} isn't on offer here.`);
        it.quantity = it.quantity ?? 1;
        if (!Number.isInteger(it.quantity) || it.quantity < 1 || it.quantity > 999) throw new HttpsError("invalid-argument", "quantity is a whole number from 1 to 999.");
      }
      try {
        const found = await Promise.all(items.map((it) => stripe().price(it.price)));
        if (found.some((pr) => !pr.active)) throw new HttpsError("failed-precondition", "A price isn't active in Stripe.");
        // Any recurring price: a subscription (one-off prices go on its first invoice); none: a payment.
        const subscription = found.some((pr) => !!pr.recurring);
        const customer = (await customerFor(who, true))!;
        if (subscription && !multiple) {
          const current = summarize((await stripe().subscriptions(customer)).data ?? [], plans);
          if (current.plan) throw new HttpsError("already-exists", "There's a subscription already: change it in the customer portal (portal).");
        }
        const trial = p.setting<number>("TRIAL_DAYS") ?? 0;
        const meta = { winche_uid: who.uid, price: items.map((it) => it.price).join(",") };
        const session = await stripe().createCheckout({
          mode: subscription ? "subscription" : "payment",
          customer, client_reference_id: who.uid,
          line_items: items.map((it) => ({ price: it.price, quantity: it.quantity })),
          success_url: p.setting<string>("SUCCESS_URL"), cancel_url: p.setting<string>("CANCEL_URL"),
          allow_promotion_codes: p.setting<boolean>("PROMOTION_CODES") === true ? true : undefined,
          automatic_tax: tax() ? { enabled: true } : undefined,
          customer_update: tax() ? { address: "auto" } : undefined,
          metadata: meta,
          ...(subscription
            ? { subscription_data: { metadata: meta, ...(trial > 0 ? { trial_period_days: trial } : {}) } }
            : { payment_intent_data: { metadata: meta } }),
        });
        return { url: session.url, id: session.id };
      } catch (e) { asHttpsError(e); }
    }, {
      ...signedIn,
      description: "A Checkout page for a price, or several: { price, quantity? } or { items: [{ price, quantity }] } → { url, id }.",
      input: { type: "object", properties: { price: { type: "string" }, quantity: { type: "integer" }, items: { type: "array" } } },
      output: { type: "object", properties: { url: { type: "string" }, id: { type: "string" } } },
    }),

    pay: callable(async (d: any, ctx) => {
      allowed(ctx, "WHO_CAN_CHARGE", "CHARGE_CLAIM", "Amounts are charged");
      const who = whose(ctx, d);
      const amount = checkAmount(d?.amount, minAmount, maxAmount);
      const currency = String(d?.currency ?? currencies[0]).toLowerCase();
      if (!currencies.includes(currency)) throw new HttpsError("invalid-argument", `currency is ${currencies.join(" or ")}.`);
      const description = String(d?.description ?? "").trim();
      if (!description || description.length > 200) throw new HttpsError("invalid-argument", "description says what it's for (up to 200 characters).");
      try {
        const customer = (await customerFor(who, true))!;
        const meta = { winche_uid: who.uid, kind: "amount", description };
        const session = await stripe().createCheckout({
          mode: "payment", customer, client_reference_id: who.uid,
          line_items: [{ quantity: 1, price_data: { currency, unit_amount: amount, product_data: { name: description } } }],
          success_url: p.setting<string>("SUCCESS_URL"), cancel_url: p.setting<string>("CANCEL_URL"),
          automatic_tax: tax() ? { enabled: true } : undefined, customer_update: tax() ? { address: "auto" } : undefined,
          metadata: meta, payment_intent_data: { metadata: meta, description },
        });
        return { url: session.url, id: session.id };
      } catch (e) { asHttpsError(e); }
    }, {
      ...signedIn,
      description: "A Checkout page for any amount, paid now: { amount (smallest unit: 1999 is £19.99), currency?, description, uid? } → { url, id }.",
      input: { type: "object", properties: { amount: { type: "integer" }, currency: { type: "string" }, description: { type: "string" }, uid: { type: "string" } }, required: ["amount", "description"] },
      example: { amount: 2500, currency: "gbp", description: "Deposit for the 12 March booking" },
    }),

    bill: callable(async (d: any, ctx) => {
      allowed(ctx, "WHO_CAN_CHARGE", "CHARGE_CLAIM", "Bills are sent");
      const amount = checkAmount(d?.amount, minAmount, maxAmount);
      const currency = String(d?.currency ?? currencies[0]).toLowerCase();
      if (!currencies.includes(currency)) throw new HttpsError("invalid-argument", `currency is ${currencies.join(" or ")}.`);
      const description = String(d?.description ?? "").trim();
      if (!description || description.length > 200) throw new HttpsError("invalid-argument", "description says what it's for (up to 200 characters).");
      const dueDays = d?.dueDays ?? Number(p.setting<number>("INVOICE_DAYS") ?? 14);
      if (!Number.isInteger(dueDays) || dueDays < 1 || dueDays > 365) throw new HttpsError("invalid-argument", "dueDays is 1 to 365.");
      try {
        let customer: string, uid: string | null = null;
        if (typeof d?.uid === "string" && d.uid) {
          uid = d.uid;
          customer = (await customerFor({ uid: d.uid, email: typeof d.email === "string" ? d.email : null, name: null }, true))!;
        } else if (typeof d?.email === "string" && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) {
          const found = await stripe().customerByEmail(d.email);
          customer = found.data?.[0]?.id ?? (await stripe().createCustomerByEmail(d.email, typeof d.name === "string" ? d.name : null)).id;
        } else throw new HttpsError("invalid-argument", "Say who's billed: uid (one of the app's users) or email.");
        const meta: Record<string, string> = { kind: "amount", ...(uid ? { winche_uid: uid } : {}) };
        const invoice = await stripe().sendInvoice({ customer, amount, currency, description, daysUntilDue: dueDays, metadata: meta });
        return { id: invoice.id, number: invoice.number, status: invoice.status, hostedUrl: invoice.hosted_invoice_url, amount, currency };
      } catch (e) { asHttpsError(e); }
    }, {
      ...signedIn,
      description: "Bills someone any amount: Stripe emails the invoice, with its page to pay it: { uid | email, amount, currency?, description, dueDays? } → the invoice.",
      input: { type: "object", properties: { uid: { type: "string" }, email: { type: "string" }, amount: { type: "integer" }, currency: { type: "string" }, description: { type: "string" }, dueDays: { type: "integer" } }, required: ["amount", "description"] },
      example: { email: "pat@example.com", amount: 12000, currency: "gbp", description: "Call-out and repair, 14 March" },
    }),

    prices: callable(async () => {
      try {
        const all = (await stripe().activePrices()).data ?? [];
        return {
          prices: all.filter((pr: any) => prices.length === 0 || prices.includes(pr.id)).map((pr: any) => {
            const product = typeof pr.product === "object" && pr.product ? pr.product : { id: pr.product };
            return {
              id: pr.id, plan: plans[pr.id] ?? pr.lookup_key ?? product.id ?? null, product: { id: product.id ?? null, name: product.name ?? null, description: product.description ?? null },
              amount: pr.unit_amount ?? null, currency: pr.currency, recurring: !!pr.recurring, interval: pr.recurring?.interval ?? null,
              intervalCount: pr.recurring?.interval_count ?? null, usage: pr.recurring?.usage_type === "metered" ? "metered" : "licensed",
              trialDays: pr.recurring ? (p.setting<number>("TRIAL_DAYS") ?? 0) : 0,
            };
          }),
        };
      } catch (e) { asHttpsError(e); }
    }, { ...signedIn, description: "The prices on offer, with their products, amounts and intervals, for a pricing page (anyone may call it)." }),

    subscription: callable(async (d: any, ctx) => {
      const who = whose(ctx, d);
      try {
        const customer = await customerFor(who, false);
        return customer ? await sync(who.uid, customer) : (multiple ? { plan: null, plans: [], subscription: null, subscriptions: [] } : { plan: null, subscription: null });
      } catch (e) { asHttpsError(e); }
    }, { ...signedIn, description: "The user's subscription (or subscriptions) now, read from Stripe: → { plan, subscription }." }),

    setQuantity: callable(async (d: any, ctx) => {
      if (!ctx.byServer && p.setting<string>("WHO_CAN_CHANGE_SEATS") === "server") throw new HttpsError("permission-denied", "Seats are changed by the project's own code here.");
      const who = whose(ctx, d);
      if (!Number.isInteger(d?.quantity) || d.quantity < 1 || d.quantity > 10000) throw new HttpsError("invalid-argument", "quantity is a whole number from 1 to 10000.");
      try {
        const customer = await customerFor(who, false);
        const current = customer ? pickSubscription(summarizeAll((await stripe().subscriptions(customer)).data ?? [], plans).subscriptions, d.subscription) : null;
        if (!customer || !current?.item) throw new HttpsError("failed-precondition", "There's no subscription to change.");
        await stripe().setQuantity(current.id, current.item, d.quantity);
        return await sync(who.uid, customer);
      } catch (e) { asHttpsError(e); }
    }, {
      ...signedIn, description: "Seats on the user's subscription: { quantity, subscription? } → { plan, subscription }, the change charged or credited for the rest of the period.",
      input: { type: "object", properties: { quantity: { type: "integer" }, subscription: { type: "string" } }, required: ["quantity"] },
    }),

    reportUsage: callable(async (d: any, ctx) => {
      if (!ctx.byServer) throw new HttpsError("permission-denied", "Usage is reported by the project's own code.");
      if (typeof d?.uid !== "string" || !d.uid) throw new HttpsError("invalid-argument", "Give the user's uid.");
      if (typeof d?.meter !== "string" || !/^[A-Za-z0-9_.-]{1,100}$/.test(d.meter)) throw new HttpsError("invalid-argument", "meter is the billing meter's event name in Stripe.");
      if (typeof d?.value !== "number" || !Number.isInteger(d.value) || d.value < 0) throw new HttpsError("invalid-argument", "value is a whole number of units.");
      try {
        const customer = await customerFor({ uid: d.uid, email: null, name: null }, false);
        if (!customer) throw new HttpsError("failed-precondition", "That user has no Stripe customer yet (no checkout).");
        try { await stripe().meterEvent(d.meter, customer, d.value, typeof d.id === "string" ? d.id : undefined); }
        catch (e) {
          // The same id again: Stripe already counted it, so it counts once.
          if (e instanceof StripeError && typeof d.id === "string" && /already exists with identifier/i.test(e.message)) return { reported: true, already: true };
          throw e;
        }
        return { reported: true };
      } catch (e) { asHttpsError(e); }
    }, {
      ...signedIn, description: "Usage for a Stripe billing meter (the project's own code): { uid, meter, value, id? } (id: the same usage reported twice counts once).",
      input: { type: "object", properties: { uid: { type: "string" }, meter: { type: "string" }, value: { type: "integer" }, id: { type: "string" } }, required: ["uid", "meter", "value"] },
    }),

    refund: callable(async (d: any, ctx) => {
      allowed(ctx, "WHO_CAN_REFUND", "REFUND_CLAIM", "Refunds are made");
      if (typeof d?.uid !== "string" || !d.uid || typeof d?.purchase !== "string" || !d.purchase)
        throw new HttpsError("invalid-argument", "Say whose purchase: uid, and purchase (its id under purchases).");
      if (d.amount !== undefined && (!Number.isInteger(d.amount) || d.amount < 1)) throw new HttpsError("invalid-argument", "amount is a whole number in the currency's smallest unit (leave it out for all of it).");
      try {
        const snap = await userDoc(d.uid).collection("purchases").doc(d.purchase).get();
        const pi = snap.exists ? snap.get("paymentIntent") : null;
        if (typeof pi !== "string") throw new HttpsError("not-found", "There's no such purchase (or it has no payment to refund).");
        const r = await stripe().refund(pi, d.amount, { winche_uid: d.uid, purchase: d.purchase, request: typeof d.id === "string" ? d.id : "" });
        await snap.reference.set({ refund: { status: r.status, amount: r.amount, at: new Date() } }, { merge: true });
        return { id: r.id, status: r.status, amount: r.amount, currency: r.currency };
      } catch (e) { asHttpsError(e); }
    }, {
      ...signedIn, description: "Refunds a purchase, all of it or part: { uid, purchase, amount? } → the refund.",
      input: { type: "object", properties: { uid: { type: "string" }, purchase: { type: "string" }, amount: { type: "integer" } }, required: ["uid", "purchase"] },
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

    cancel: callable(async (d: any, ctx) => {
      const who = whose(ctx, d);
      try {
        const customer = await customerFor(who, false);
        const current = customer ? pickSubscription(summarizeAll((await stripe().subscriptions(customer)).data ?? [], plans).subscriptions, d?.subscription) : null;
        if (!customer || !current) throw new HttpsError("failed-precondition", "There's no subscription to cancel.");
        if (d?.resume === true) await stripe().resume(current.id);
        else if (d?.now === true) await stripe().cancelNow(current.id);
        else await stripe().cancelAtPeriodEnd(current.id);
        return await sync(who.uid, customer);
      } catch (e) { asHttpsError(e); }
    }, {
      ...signedIn,
      description: "Cancels the user's subscription at the end of its period ({ now: true }: at once; { resume: true }: undoes a cancellation; subscription: which, when there are several).",
      input: { type: "object", properties: { now: { type: "boolean" }, resume: { type: "boolean" }, subscription: { type: "string" } } },
    }),

    webhook: http.onRequest(async (req) => {
      const payload = await req.text();
      const event = await verifiedEvent(payload, req.headers.get("stripe-signature"), webhookSecret.value());
      if (!event) return new Response("This request isn't Stripe's (or the webhook signing secret isn't this endpoint's).", { status: 400 });
      const o = event.data?.object ?? {};
      const customerOf = (x: any) => (typeof x?.customer === "string" ? x.customer : x?.customer?.id ?? null);
      switch (event.type) {
        case "checkout.session.completed":
        case "checkout.session.async_payment_succeeded": {
          const uid = o.client_reference_id ?? o.metadata?.winche_uid ?? null;
          if (!uid || typeof o.customer !== "string") break;
          if (o.mode === "subscription") { await sync(uid, o.customer); break; }
          if (record && o.payment_status === "paid")
            await userDoc(uid).collection("purchases").doc(o.id).set({
              price: o.metadata?.kind === "amount" ? null : o.metadata?.price ?? null, description: o.metadata?.description ?? null,
              amount: o.amount_total ?? null, currency: o.currency ?? null,
              paymentIntent: o.payment_intent ?? null, at: new Date((event.created ?? Date.now() / 1000) * 1000),
            }, { merge: true });
          break;
        }
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
        case "customer.subscription.paused":
        case "customer.subscription.resumed": {
          const customer = customerOf(o);
          const uid = customer ? await uidOf(customer, o.metadata) : null;
          if (uid) await sync(uid, customer);
          break;
        }
        case "invoice.finalized":
        case "invoice.paid":
        case "invoice.payment_failed":
        case "invoice.voided":
        case "invoice.marked_uncollectible": {
          const customer = customerOf(o);
          if (!customer) break;
          const uid = await uidOf(customer, o.metadata?.winche_uid ? o.metadata : o.subscription_details?.metadata ?? o.parent?.subscription_details?.metadata);
          if (!uid) break;
          if (record && o.id) await userDoc(uid).collection("invoices").doc(o.id).set(invoiceRecord(o), { merge: true });
          if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") await sync(uid, customer);
          break;
        }
        case "charge.refunded":
        case "charge.dispute.created":
        case "charge.dispute.updated":
        case "charge.dispute.closed": {
          const pi = typeof o.payment_intent === "string" ? o.payment_intent : null;
          if (!pi || !record) break;
          // A dispute doesn't say whose payment it was: the payment does (its metadata, else its customer).
          let customer = customerOf(o), uid: string | null = o.metadata?.winche_uid ?? null;
          if (!uid && !customer) { const intent = await stripe().paymentIntent(pi); uid = intent?.metadata?.winche_uid ?? null; customer = customerOf(intent); }
          if (!uid && customer) uid = await uidOf(customer, null);
          if (!uid) break;
          const ref = await purchaseOf(uid, pi);
          if (!ref) break;
          if (event.type === "charge.refunded")
            await ref.set({ refunded: o.amount_refunded ?? null, status: o.refunded ? "refunded" : "partly refunded", updatedAt: new Date() }, { merge: true });
          else await ref.set({ dispute: { status: o.status ?? null, reason: o.reason ?? null, amount: o.amount ?? null, at: new Date() } }, { merge: true });
          break;
        }
      }
      return { received: true };   // anything else: acknowledged, nothing to do
    }, { methods: ["POST"], secrets: [secretKey, webhookSecret], description: "Stripe's events (add it as a webhook endpoint in Stripe): subscriptions kept on users, purchases, refunds, disputes and invoices recorded." }),
  };
});
