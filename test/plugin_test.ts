import { createHmac } from "node:crypto";
import { withSecrets, withServer, testContext } from "@winche-technologies/winche-functions/testing";
import stripePlugin, { encode, endpoints, verifiedEvent, summarize, pairs } from "../dist/index.js";

const eq = (a: unknown, b: unknown, what = "") => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${what} ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`);
};
const rejects = async (p: () => Promise<unknown>, code: string, includes = "") => {
  try { await p(); } catch (e) {
    const err = e as { code?: string; message: string };
    if (err.code !== code || !err.message.includes(includes)) throw new Error(`threw ${err.code}: ${err.message}`);
    return;
  }
  throw new Error(`didn't throw ${code}`);
};

const base = {
  SUCCESS_URL: "https://app.example.com/done", CANCEL_URL: "https://app.example.com/billing", PORTAL_RETURN_URL: "", PRICES: "", PLANS: "price_pro=pro",
  PLAN_CLAIM: "plan", COLLECTION: "billing", RECORD_SUBSCRIPTIONS: true, TRIAL_DAYS: 0, PROMOTION_CODES: false, AUTOMATIC_TAX: false,
};
const copy = (settings: Partial<typeof base> = {}) =>
  stripePlugin.install({ id: "payments", settings: { ...base, ...settings }, secrets: { SECRET_KEY: "PAYMENTS__SECRET_KEY", WEBHOOK_SECRET: "PAYMENTS__WEBHOOK_SECRET" } }).functions;
const secrets = { PAYMENTS__SECRET_KEY: "sk_test_1", PAYMENTS__WEBHOOK_SECRET: "whsec_1" };
const ann = testContext({ caller: { uid: "ann", token: { email: "ann@example.com" } } });

const sub = (status: string, price = "price_pro", extra: Record<string, unknown> = {}) => ({
  id: `sub_${status}`, status, created: 100, current_period_end: 1_900_000_000, cancel_at_period_end: false, trial_end: null, metadata: { winche_uid: "ann" },
  items: { data: [{ quantity: 1, price: { id: price, lookup_key: null, product: "prod_1" } }] }, ...extra,
});

/** Stripe's API, stood in: each request, and what it answers. */
function fakeStripe(answer: (method: string, path: string, form: URLSearchParams) => [number, unknown]) {
  const seen: { method: string; path: string; form: URLSearchParams; headers: Headers }[] = [];
  endpoints.api = "https://stripe.test";
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const form = init?.method === "POST" ? new URLSearchParams(String(init?.body ?? "")) : url.searchParams;
    seen.push({ method: init?.method ?? "GET", path: url.pathname, form, headers: new Headers(init?.headers) });
    const [status, body] = answer(init?.method ?? "GET", url.pathname, form);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return seen;
}

/** The project's data, stood in: documents by path, users' claims, and every call made. */
function fakeServer() {
  const docs: Record<string, Record<string, unknown>> = {};
  const claims: Record<string, Record<string, unknown>> = { ann: { role: "patient" } };
  const calls: { op: string; args: any }[] = [];
  const call = async (op: string, args: any) => {
    calls.push({ op, args });
    if (op === "db.get") return docs[args.path] ? { document: { path: args.path, fields: docs[args.path], createTime: "2026-01-01T00:00:00Z", updateTime: "2026-01-01T00:00:00Z", version: 1 } } : {};
    if (op === "db.write") { for (const w of args.writes) if (w.set) docs[w.set.path] = { ...(docs[w.set.path] ?? {}), ...w.set.fields }; return { writeResults: [] }; }
    if (op === "users.get") return claims[args.uid] ? { uid: args.uid, customClaims: claims[args.uid] } : null;
    if (op === "users.setClaims") { claims[args.uid] = args.claims; return null; }
    return {};
  };
  return { docs, claims, calls, call };
}

Deno.test("Stripe's form encoding and signatures", async () => {
  eq(decodeURIComponent(String(encode({ a: 1, line_items: [{ price: "p", quantity: 2 }], meta: { uid: "u" }, skip: undefined }))),
    "a=1&line_items[0][price]=p&line_items[0][quantity]=2&meta[uid]=u");
  const payload = JSON.stringify({ id: "evt_1", type: "ping" });
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac("sha256", "whsec_1").update(`${t}.${payload}`).digest("hex");
  eq((await verifiedEvent(payload, `t=${t},v1=${v1}`, "whsec_1"))?.id, "evt_1");
  eq(await verifiedEvent(payload, `t=${t},v1=${v1}`, "whsec_other"), null);
  eq(await verifiedEvent(payload + " ", `t=${t},v1=${v1}`, "whsec_1"), null);
  eq(await verifiedEvent(payload, `t=${t - 600},v1=${createHmac("sha256", "whsec_1").update(`${t - 600}.${payload}`).digest("hex")}`, "whsec_1"), null, "too old");
  eq((await verifiedEvent(payload, `t=${t},v1=deadbeef,v1=${v1}`, "whsec_1"))?.id, "evt_1", "any of the v1s");
  eq(await verifiedEvent(payload, null, "whsec_1"), null);
});

Deno.test("the subscription that counts, and its plan", () => {
  eq(summarize([], {}), { plan: null, subscription: null });
  const s = summarize([sub("canceled", "price_old", { created: 300 }), sub("active")], pairs("price_pro=pro"));
  eq([s.plan, s.subscription?.status, s.subscription?.currentPeriodEnd?.getTime()], ["pro", "active", 1_900_000_000_000]);
  eq(summarize([sub("past_due")], {}).plan, "prod_1", "past due keeps the plan; without a name, the product");
  eq(summarize([sub("canceled")], { price_pro: "pro" }).plan, null);
  eq(summarize([{ ...sub("trialing"), items: { data: [{ quantity: 1, price: { id: "price_x", lookup_key: "team", product: "prod_2" } }] } }], {}).plan, "team");
});

Deno.test("checkout: the signed-in user's customer made once, a subscription or a payment, what's on offer", async () => {
  const seen = fakeStripe((method, path, f) => {
    if (path === "/v1/customers") return [200, { id: "cus_1" }];
    if (path === "/v1/prices/price_pro") return [200, { id: "price_pro", active: true, recurring: { interval: "month" } }];
    if (path === "/v1/prices/price_book") return [200, { id: "price_book", active: true, recurring: null }];
    if (path === "/v1/prices/price_gone") return [200, { id: "price_gone", active: false }];
    if (path === "/v1/subscriptions") return [200, { data: f.get("customer") === "cus_subscribed" ? [sub("active")] : [] }];
    if (path === "/v1/checkout/sessions") return [200, { id: "cs_1", url: "https://checkout.stripe.test/cs_1" }];
    return [404, { error: { message: `no ${method} ${path}` } }];
  });
  const db = fakeServer();
  const { checkout } = copy({ TRIAL_DAYS: 14 });
  await withSecrets(secrets, () => withServer(db.call, async () => {
    await rejects(() => checkout.run({ price: "price_pro" }, testContext()), "unauthenticated");
    eq(await checkout.run({ price: "price_pro" }, ann), { url: "https://checkout.stripe.test/cs_1", id: "cs_1" });
    const customer = seen.find((r) => r.path === "/v1/customers")!;
    eq([customer.form.get("email"), customer.form.get("metadata[winche_uid]"), customer.headers.get("idempotency-key")], ["ann@example.com", "ann", "winche-customer-ann"]);
    eq((db.docs["billing/ann"].customerId as any).stringValue, "cus_1");
    const session = seen.find((r) => r.path === "/v1/checkout/sessions")!.form;
    eq([session.get("mode"), session.get("customer"), session.get("client_reference_id"), session.get("line_items[0][price]"), session.get("subscription_data[trial_period_days]"),
      session.get("subscription_data[metadata][winche_uid]"), session.get("success_url")],
      ["subscription", "cus_1", "ann", "price_pro", "14", "ann", "https://app.example.com/done"]);
    eq(seen.at(-1)!.headers.get("authorization"), "Bearer sk_test_1");

    await checkout.run({ price: "price_book", quantity: 2 }, ann);
    eq(seen.filter((r) => r.path === "/v1/customers").length, 1, "the customer is kept");
    const pay = seen.at(-1)!.form;
    eq([pay.get("mode"), pay.get("line_items[0][quantity]"), pay.get("payment_intent_data[metadata][price]"), pay.has("subscription_data[trial_period_days]")], ["payment", "2", "price_book", false]);

    await rejects(() => checkout.run({ price: "price_gone" }, ann), "failed-precondition", "isn't active");
    await rejects(() => checkout.run({ price: "nope" }, ann), "invalid-argument");
    await rejects(() => copy({ PRICES: "price_book" }).checkout.run({ price: "price_pro" }, ann), "invalid-argument", "isn't on offer");
    db.docs["billing/bob"] = { customerId: { stringValue: "cus_subscribed" } };
    await rejects(() => checkout.run({ price: "price_pro" }, testContext({ caller: { uid: "bob", token: {} } })), "already-exists", "portal");
    await rejects(() => checkout.run({ price: "price_pro" }, testContext({ byServer: true })), "invalid-argument", "uid");
    await checkout.run({ price: "price_book", uid: "carol", email: "carol@example.com" }, testContext({ byServer: true }));
  }));
  fakeStripe(() => [401, { error: { type: "invalid_request_error", message: "Invalid API Key provided: sk_test_1" } }]);
  await withSecrets(secrets, () => withServer(fakeServer().call, () => rejects(() => copy().checkout.run({ price: "price_pro" }, ann), "failed-precondition", "secret key")));
});

Deno.test("webhook: Stripe's signed events keep the user's subscription and plan claim; purchases recorded", async () => {
  let subs: any[] = [sub("active")];
  fakeStripe((_m, path) => path === "/v1/subscriptions" ? [200, { data: subs }] : path === "/v1/customers/cus_1" ? [200, { id: "cus_1", metadata: { winche_uid: "ann" } }] : [404, {}]);
  const db = fakeServer();
  const { webhook } = copy();
  const post = (event: unknown, secret = "whsec_1") => {
    const payload = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
    return webhook.run(Object.assign(new Request("http://internal/functions/v1/http/payments.webhook", { method: "POST", body: payload, headers: { "stripe-signature": `t=${t},v1=${sig}` } }), { ip: null }), testContext());
  };
  await withSecrets(secrets, () => withServer(db.call, async () => {
    eq(((await post({ type: "customer.subscription.created", data: { object: { customer: "cus_1", metadata: { winche_uid: "ann" } } } }, "whsec_forged")) as Response).status, 400);
    eq(db.calls.length, 0);

    eq(await post({ type: "customer.subscription.created", data: { object: { customer: "cus_1", metadata: { winche_uid: "ann" } } } }), { received: true });
    eq(db.claims.ann, { role: "patient", plan: "pro" });
    eq(((db.docs["billing/ann"].subscription as any).mapValue.fields.status).stringValue, "active");

    subs = [sub("canceled")];   // ended: no metadata on the event this time, so the customer says whose it is
    await post({ type: "customer.subscription.deleted", data: { object: { customer: "cus_1", metadata: {} } } });
    eq(db.claims.ann, { role: "patient" });
    eq(db.docs["billing/ann"].plan, { nullValue: null });

    await post({ type: "checkout.session.completed", created: 1_800_000_000, data: { object: { id: "cs_9", mode: "payment", payment_status: "paid", customer: "cus_1",
      client_reference_id: "ann", amount_total: 1999, currency: "gbp", metadata: { winche_uid: "ann", price: "price_book" } } } });
    const purchase = db.docs["billing/ann/purchases/cs_9"];
    eq([(purchase.amount as any).integerValue, (purchase.price as any).stringValue], ["1999", "price_book"]);
    eq(await post({ type: "charge.refunded", data: { object: {} } }), { received: true }, "other events acknowledged");
  }));
});

Deno.test("portal, subscription and cancel", async () => {
  let subs: any[] = [sub("active")];
  const seen = fakeStripe((method, path) => {
    if (path === "/v1/billing_portal/sessions") return [200, { url: "https://billing.stripe.test/p1" }];
    if (path === "/v1/subscriptions") return [200, { data: subs }];
    if (path === "/v1/subscriptions/sub_active" && method === "POST") { subs = [sub("active", "price_pro", { cancel_at_period_end: true })]; return [200, {}]; }
    if (path === "/v1/subscriptions/sub_active" && method === "DELETE") { subs = [sub("canceled")]; return [200, {}]; }
    return [404, {}];
  });
  const db = fakeServer();
  const fns = copy();
  await withSecrets(secrets, () => withServer(db.call, async () => {
    await rejects(() => fns.portal.run({}, ann), "failed-precondition", "start a checkout");
    eq(await fns.subscription.run({}, ann), { plan: null, subscription: null });
    db.docs["billing/ann"] = { customerId: { stringValue: "cus_1" } };
    eq(await fns.portal.run({}, ann), { url: "https://billing.stripe.test/p1" });
    eq(seen.at(-1)!.form.get("return_url"), "https://app.example.com/billing");
    eq((await fns.subscription.run({}, ann) as any).plan, "pro");
    const ending = await fns.cancel.run({}, ann) as any;
    eq([ending.plan, ending.subscription.cancelAtPeriodEnd], ["pro", true], "kept until the period ends");
    eq(seen.at(-2)!.form.get("cancel_at_period_end"), "true");
    const gone = await fns.cancel.run({ now: true }, ann) as any;
    eq(gone.plan, null);
    eq(db.claims.ann, { role: "patient" });
    await rejects(() => fns.cancel.run({}, ann), "failed-precondition", "no subscription");
  }));
});
