import { createHmac } from "node:crypto";
import { withSecrets, withServer, testContext } from "@winche-technologies/winche-functions/testing";
import stripePlugin, { encode, endpoints, verifiedEvent, summarize, summarizeAll, pairs, hasClaim, checkAmount } from "../dist/index.js";

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
  MULTIPLE_SUBSCRIPTIONS: false, WHO_CAN_CHANGE_SEATS: "signed-in", WHO_CAN_CHARGE: "server", CHARGE_CLAIM: "admin", CURRENCIES: "gbp, eur",
  MIN_AMOUNT: 50, MAX_AMOUNT: 100000, INVOICE_DAYS: 14, WHO_CAN_REFUND: "server", REFUND_CLAIM: "admin",
} as Record<string, any>;
const copy = (settings: Record<string, any> = {}) =>
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
    if (op === "db.query") {
      const { collection, where, limit } = args.query;
      const found = Object.entries(docs).filter(([path, fields]) => path.startsWith(collection + "/") && !path.slice(collection.length + 1).includes("/")
        && (!where || JSON.stringify(fields[where.field]) === JSON.stringify(where.value)));
      return { documents: found.slice(0, limit ?? 100).map(([path, fields]) => ({ path, fields, createTime: "2026-01-01T00:00:00Z", updateTime: "2026-01-01T00:00:00Z", version: 1 })) };
    }
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
    eq(await post({ type: "payout.paid", data: { object: {} } }), { received: true }, "other events acknowledged");
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

const server = testContext({ byServer: true });
const office = testContext({ caller: { uid: "olive", token: { role: "office" } } });

Deno.test("claims, amounts and every subscription", () => {
  eq([hasClaim({ token: { admin: true } }, "admin"), hasClaim({ token: { role: "office" } }, "role=office"), hasClaim({ token: { role: ["a", "office"] } }, "role=office"),
    hasClaim({ token: { role: "patient" } }, "role=office"), hasClaim({ token: { admin: false } }, "admin"), hasClaim(null, "admin"), hasClaim({ token: { admin: true } }, "")],
    [true, true, true, false, false, false, false]);
  eq(checkAmount(1999, 50, 100000), 1999);
  for (const bad of [19.99, "1999", 0, 10, 200000]) { try { checkAmount(bad, 50, 100000); throw new Error(`took ${bad}`); } catch (e) { if (!(e as Error).message.includes("amount")) throw e; } }
  const all = summarizeAll([sub("active"), { ...sub("trialing", "price_add"), id: "sub_add" }, sub("canceled", "price_old")], pairs("price_pro=pro, price_add=storage"));
  eq([all.plans, all.subscriptions.map((s) => s.id)], [["pro", "storage"], ["sub_active", "sub_add", "sub_canceled"]]);
});

Deno.test("checkout with several items; several subscriptions when allowed", async () => {
  const seen = fakeStripe((_m, path) => {
    if (path.startsWith("/v1/prices/")) { const id = path.split("/").pop()!; return [200, { id, active: true, recurring: id === "price_book" ? null : { interval: "month" } }]; }
    if (path === "/v1/subscriptions") return [200, { data: [sub("active")] }];
    if (path === "/v1/checkout/sessions") return [200, { id: "cs_2", url: "https://checkout.stripe.test/cs_2" }];
    return [404, {}];
  });
  const db = fakeServer();
  db.docs["billing/ann"] = { customerId: { stringValue: "cus_1" } };
  await withSecrets(secrets, () => withServer(db.call, async () => {
    await rejects(() => copy().checkout.run({ items: [{ price: "price_add" }] }, ann), "already-exists");
    await copy({ MULTIPLE_SUBSCRIPTIONS: true }).checkout.run({ items: [{ price: "price_add", quantity: 3 }, { price: "price_book" }] }, ann);
    const f = seen.at(-1)!.form;
    eq([f.get("mode"), f.get("line_items[0][price]"), f.get("line_items[0][quantity]"), f.get("line_items[1][price]"), f.get("metadata[price]")],
      ["subscription", "price_add", "3", "price_book", "price_add,price_book"]);
    await rejects(() => copy().checkout.run({ items: [] }, ann), "invalid-argument");
    await rejects(() => copy({ PRICES: "price_add" }).checkout.run({ items: [{ price: "price_add" }, { price: "price_book" }] }, ann), "invalid-argument", "price_book");
  }));
});

Deno.test("pay and bill: any amount, only for whom the settings allow", async () => {
  const seen = fakeStripe((method, path, f) => {
    if (path === "/v1/customers" && method === "GET") return [200, { data: f.get("email") === "known@example.com" ? [{ id: "cus_known" }] : [] }];
    if (path === "/v1/customers") return [200, { id: f.get("email") === "pat@example.com" ? "cus_pat" : "cus_new" }];
    if (path === "/v1/checkout/sessions") return [200, { id: "cs_3", url: "https://checkout.stripe.test/cs_3" }];
    if (path === "/v1/invoices") return [200, { id: "in_1" }];
    if (path === "/v1/invoiceitems") return [200, { id: "ii_1" }];
    if (path === "/v1/invoices/in_1/finalize") return [200, { id: "in_1", status: "open" }];
    if (path === "/v1/invoices/in_1/send") return [200, { id: "in_1", number: "A-0001", status: "open", hosted_invoice_url: "https://invoice.stripe.test/i1" }];
    return [404, {}];
  });
  const db = fakeServer();
  await withSecrets(secrets, () => withServer(db.call, async () => {
    const fns = copy();
    await rejects(() => fns.pay.run({ amount: 2500, description: "Deposit" }, ann), "permission-denied", "project's own code");
    await rejects(() => fns.pay.run({ amount: 2500, description: "Deposit" }, testContext()), "unauthenticated");
    eq(await fns.pay.run({ uid: "ann", amount: 2500, description: "Deposit for 12 March" }, server), { url: "https://checkout.stripe.test/cs_3", id: "cs_3" });
    const f = seen.at(-1)!.form;
    eq([f.get("mode"), f.get("line_items[0][price_data][unit_amount]"), f.get("line_items[0][price_data][currency]"), f.get("line_items[0][price_data][product_data][name]"),
      f.get("payment_intent_data[metadata][winche_uid]"), f.get("metadata[kind]")], ["payment", "2500", "gbp", "Deposit for 12 March", "ann", "amount"]);
    await rejects(() => fns.pay.run({ uid: "ann", amount: 2500, currency: "usd", description: "x" }, server), "invalid-argument", "gbp or eur");
    await rejects(() => fns.pay.run({ uid: "ann", amount: 500000, description: "x" }, server), "invalid-argument", "50 to 100000");
    await rejects(() => fns.pay.run({ uid: "ann", amount: 2500 }, server), "invalid-argument", "description");
    await copy({ WHO_CAN_CHARGE: "signed-in" }).pay.run({ amount: 1000, currency: "EUR", description: "Top-up" }, ann);
    eq(seen.at(-1)!.form.get("line_items[0][price_data][currency]"), "eur");
    await rejects(() => copy({ WHO_CAN_CHARGE: "claim", CHARGE_CLAIM: "role=office" }).pay.run({ amount: 1000, description: "x" }, ann), "permission-denied");

    const billed = await copy({ WHO_CAN_CHARGE: "claim", CHARGE_CLAIM: "role=office" }).bill.run({ email: "pat@example.com", amount: 12000, description: "Call-out and repair" }, office);
    eq(billed, { id: "in_1", number: "A-0001", status: "open", hostedUrl: "https://invoice.stripe.test/i1", amount: 12000, currency: "gbp" });
    const inv = seen.find((r) => r.path === "/v1/invoices")!.form;
    eq([inv.get("customer"), inv.get("collection_method"), inv.get("days_until_due")], ["cus_pat", "send_invoice", "14"]);
    const item = seen.find((r) => r.path === "/v1/invoiceitems")!.form;
    eq([item.get("invoice"), item.get("amount"), item.get("currency")], ["in_1", "12000", "gbp"]);
    eq(seen.filter((r) => r.path.startsWith("/v1/invoices/in_1/")).map((r) => r.path), ["/v1/invoices/in_1/finalize", "/v1/invoices/in_1/send"]);
    await fns.bill.run({ email: "known@example.com", amount: 5000, description: "x", dueDays: 30 }, server);
    eq(seen.filter((r) => r.path === "/v1/invoices").at(-1)!.form.get("customer"), "cus_known", "an existing customer by email");
    await fns.bill.run({ uid: "ann", amount: 5000, description: "x" }, server);
    eq(seen.filter((r) => r.path === "/v1/invoices").at(-1)!.form.get("metadata[winche_uid]"), "ann");
    await rejects(() => fns.bill.run({ amount: 5000, description: "x" }, server), "invalid-argument", "who's billed");
    await rejects(() => fns.bill.run({ email: "pat@example.com", amount: 5000, description: "x", dueDays: 0 }, server), "invalid-argument", "dueDays");
  }));
});

Deno.test("prices, seats, usage and refunds", async () => {
  let subs: any[] = [{ ...sub("active"), items: { data: [{ id: "si_1", quantity: 2, price: { id: "price_pro", lookup_key: null, product: "prod_1" } }] } }];
  const seen = fakeStripe((method, path, f) => {
    if (path === "/v1/prices") return [200, { data: [
      { id: "price_pro", unit_amount: 900, currency: "gbp", recurring: { interval: "month", interval_count: 1, usage_type: "licensed" }, product: { id: "prod_1", name: "Pro", description: "Everything" } },
      { id: "price_calls", unit_amount: 5, currency: "gbp", recurring: { interval: "month", interval_count: 1, usage_type: "metered" }, lookup_key: "calls", product: { id: "prod_2", name: "Calls" } },
      { id: "price_book", unit_amount: 1999, currency: "gbp", recurring: null, product: { id: "prod_3", name: "Book" } }] }];
    if (path === "/v1/subscriptions") return [200, { data: subs }];
    if (path === "/v1/subscriptions/sub_active" && method === "POST") { subs = [{ ...subs[0], items: { data: [{ ...subs[0].items.data[0], quantity: Number(f.get("items[0][quantity]")) }] } }]; return [200, {}]; }
    if (path === "/v1/billing/meter_events") return f.get("identifier") === "dup" ? [400, { error: { message: "An event already exists with identifier dup." } }] : [200, { identifier: "x" }];
    if (path === "/v1/refunds") return [200, { id: "re_1", status: "succeeded", amount: Number(f.get("amount") ?? 2500), currency: "gbp" }];
    return [404, {}];
  });
  const db = fakeServer();
  db.docs["billing/ann"] = { customerId: { stringValue: "cus_1" } };
  db.docs["billing/ann/purchases/cs_9"] = { paymentIntent: { stringValue: "pi_9" }, amount: { integerValue: "2500" } };
  await withSecrets(secrets, () => withServer(db.call, async () => {
    const fns = copy();
    const list = (await fns.prices.run({}, testContext()) as any).prices;
    eq(list.map((p: any) => [p.id, p.plan, p.product.name, p.amount, p.interval, p.usage]),
      [["price_pro", "pro", "Pro", 900, "month", "licensed"], ["price_calls", "calls", "Calls", 5, "month", "metered"], ["price_book", "prod_3", "Book", 1999, null, "licensed"]]);
    eq((await copy({ PRICES: "price_book" }).prices.run({}, testContext()) as any).prices.length, 1);

    const changed = await fns.setQuantity.run({ quantity: 5 }, ann) as any;
    eq(changed.subscription.quantity, 5);
    const f = seen.filter((r) => r.path === "/v1/subscriptions/sub_active").at(-1)!.form;
    eq([f.get("items[0][id]"), f.get("items[0][quantity]"), f.get("proration_behavior")], ["si_1", "5", "create_prorations"]);
    await rejects(() => copy({ WHO_CAN_CHANGE_SEATS: "server" }).setQuantity.run({ quantity: 3 }, ann), "permission-denied");
    await rejects(() => fns.setQuantity.run({ quantity: 0 }, ann), "invalid-argument");

    await rejects(() => fns.reportUsage.run({ uid: "ann", meter: "calls", value: 3 }, ann), "permission-denied");
    eq(await fns.reportUsage.run({ uid: "ann", meter: "calls", value: 3, id: "call-77" }, server), { reported: true });
    const m = seen.at(-1)!.form;
    eq([m.get("event_name"), m.get("payload[stripe_customer_id]"), m.get("payload[value]"), m.get("identifier")], ["calls", "cus_1", "3", "call-77"]);
    eq(await fns.reportUsage.run({ uid: "ann", meter: "calls", value: 3, id: "dup" }, server), { reported: true, already: true }, "the same usage again counts once");
    await rejects(() => fns.reportUsage.run({ uid: "nobody", meter: "calls", value: 3 }, server), "failed-precondition", "no Stripe customer");

    await rejects(() => fns.refund.run({ uid: "ann", purchase: "cs_9" }, ann), "permission-denied");
    eq(await copy({ WHO_CAN_REFUND: "claim", REFUND_CLAIM: "role=office" }).refund.run({ uid: "ann", purchase: "cs_9", amount: 1000 }, office),
      { id: "re_1", status: "succeeded", amount: 1000, currency: "gbp" });
    const r = seen.at(-1)!;
    eq([r.form.get("payment_intent"), r.form.get("amount"), r.headers.get("idempotency-key")], ["pi_9", "1000", "winche-refund-pi_9-1000-"]);
    await rejects(() => fns.refund.run({ uid: "ann", purchase: "cs_nope" }, server), "not-found");
  }));
});

Deno.test("webhook: invoices, refunds and disputes recorded; several subscriptions in a list claim", async () => {
  let subs: any[] = [sub("active"), { ...sub("active", "price_add"), id: "sub_add" }];
  fakeStripe((_m, path) => path === "/v1/subscriptions" ? [200, { data: subs }] : path === "/v1/customers/cus_1" ? [200, { id: "cus_1", metadata: { winche_uid: "ann" } }]
    : path === "/v1/payment_intents/pi_5" ? [200, { id: "pi_5", customer: "cus_1", metadata: {} }]
    : path === "/v1/payment_intents/pi_6" ? [200, { id: "pi_6", customer: "cus_1", metadata: { winche_uid: "ann" } }]
    : path === "/v1/checkout/sessions" ? [200, { data: [{ id: "cs_6", client_reference_id: "ann", metadata: { winche_uid: "ann" } }] }] : [404, {}]);
  const db = fakeServer();
  const { webhook } = copy({ MULTIPLE_SUBSCRIPTIONS: true, PLANS: "price_pro=pro, price_add=storage" });
  const post = (event: unknown) => {
    const payload = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac("sha256", "whsec_1").update(`${t}.${payload}`).digest("hex");
    return webhook.run(Object.assign(new Request("http://internal/x", { method: "POST", body: payload, headers: { "stripe-signature": `t=${t},v1=${sig}` } }), { ip: null }), testContext());
  };
  const v = (x: any) => x?.stringValue ?? x?.integerValue ?? x?.nullValue;
  await withSecrets(secrets, () => withServer(db.call, async () => {
    await post({ type: "customer.subscription.updated", data: { object: { customer: "cus_1", metadata: { winche_uid: "ann" } } } });
    eq(db.claims.ann, { role: "patient", plan: ["pro", "storage"] });
    eq((db.docs["billing/ann"].plans as any).arrayValue.values.map(v), ["pro", "storage"]);
    subs = [sub("active")];
    await post({ type: "customer.subscription.deleted", data: { object: { customer: "cus_1", metadata: {} } } });
    eq(db.claims.ann, { role: "patient", plan: ["pro"] });

    await post({ type: "invoice.finalized", data: { object: { id: "in_1", customer: "cus_1", metadata: { winche_uid: "ann" }, number: "A-0001", status: "open",
      amount_due: 12000, amount_paid: 0, currency: "gbp", hosted_invoice_url: "https://invoice.stripe.test/i1", invoice_pdf: "https://invoice.stripe.test/i1.pdf", due_date: 1_800_000_000 } } });
    const inv = db.docs["billing/ann/invoices/in_1"];
    eq([v(inv.number), v(inv.status), v(inv.amountDue), v(inv.hostedUrl)], ["A-0001", "open", "12000", "https://invoice.stripe.test/i1"]);
    await post({ type: "invoice.paid", data: { object: { id: "in_1", customer: "cus_1", metadata: { winche_uid: "ann" }, status: "paid", amount_due: 12000, amount_paid: 12000 } } });
    eq([v(db.docs["billing/ann/invoices/in_1"].status), v(db.docs["billing/ann/invoices/in_1"].amountPaid)], ["paid", "12000"]);

    await post({ type: "checkout.session.completed", data: { object: { id: "cs_5", mode: "payment", payment_status: "paid", customer: "cus_1", client_reference_id: "ann",
      amount_total: 2500, currency: "gbp", payment_intent: "pi_5", metadata: { winche_uid: "ann", kind: "amount", description: "Deposit" } } } });
    eq([v(db.docs["billing/ann/purchases/cs_5"].description), v(db.docs["billing/ann/purchases/cs_5"].price)], ["Deposit", null]);
    await post({ type: "charge.refunded", data: { object: { customer: "cus_1", payment_intent: "pi_5", amount_refunded: 1000, refunded: false, metadata: {} } } });
    eq([v(db.docs["billing/ann/purchases/cs_5"].status), v(db.docs["billing/ann/purchases/cs_5"].refunded)], ["partly refunded", "1000"]);
    await post({ type: "charge.dispute.created", data: { object: { payment_intent: "pi_5", status: "needs_response", reason: "fraudulent", amount: 2500, metadata: {} } } });
    eq(v((db.docs["billing/ann/purchases/cs_5"].dispute as any).mapValue.fields.reason), "fraudulent");

    // Stripe sent the dispute before the checkout's own event: it lands on the purchase-to-be, which then fills in.
    await post({ type: "charge.dispute.created", data: { object: { payment_intent: "pi_6", status: "needs_response", reason: "fraudulent", amount: 7000, metadata: {} } } });
    await post({ type: "checkout.session.completed", data: { object: { id: "cs_6", mode: "payment", payment_status: "paid", customer: "cus_1", client_reference_id: "ann",
      amount_total: 7000, currency: "gbp", payment_intent: "pi_6", metadata: { winche_uid: "ann", price: "price_a,price_b" } } } });
    const six = db.docs["billing/ann/purchases/cs_6"];
    eq([v(six.amount), v((six.dispute as any).mapValue.fields.status), v(six.paymentIntent)], ["7000", "needs_response", "pi_6"]);
  }));
});
