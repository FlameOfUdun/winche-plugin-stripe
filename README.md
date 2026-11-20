# Stripe for Winche (`@winche-technologies/winche-plugin-stripe`)

A [Winche](https://github.com/FlameOfUdun/winche-server) plugin: payments and subscriptions with
[Stripe](https://stripe.com). Apps call its functions to open Stripe Checkout (for prices, or any amount) and the
customer portal; your own code bills any amount by emailed invoice, changes seats, reports usage and refunds. Stripe's
webhook keeps each user's subscriptions on them, as a plan claim your rules can check and a read-only record apps can
show, with their purchases, refunds, disputes and invoices. Nothing to write or deploy yourself.

## Install

In the console: **Plugins → Browse**, then this package, and **Install**: a few steps (its settings, its secrets). Its
page then lists what's left to do outside Winche, with this copy's own addresses. Or with the CLI:

```sh
winche plugins:install @winche-technologies/winche-plugin-stripe --id payments \
  --set SUCCESS_URL=https://app.example.com/billing/done --set CANCEL_URL=https://app.example.com/billing \
  --set PLANS=price_123=pro,price_456=team
winche secrets:set PAYMENTS__SECRET_KEY        # sk_live_… or sk_test_… (typed unseen, or --ref aws-sm:…)
winche secrets:set PAYMENTS__WEBHOOK_SECRET    # whsec_… of the endpoint below
```

Then add a webhook endpoint in Stripe (Developers → Webhooks) at
`<the project's address>/functions/v1/http/payments.webhook`, e.g.
`https://api.example.com/projects/clinic/functions/v1/http/payments.webhook`, with the events
`checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`,
`customer.subscription.resumed`, `invoice.finalized`, `invoice.paid`, `invoice.payment_failed`, `invoice.voided`,
`invoice.marked_uncollectible`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated` and
`charge.dispute.closed`. Its signing secret is `WEBHOOK_SECRET`.

Or in `winche.json`, installed by `winche functions deploy`:

```json
"plugins": {
  "payments": {
    "package": "@winche-technologies/winche-plugin-stripe", "version": "1.1.0",
    "settings": { "SUCCESS_URL": "https://app.example.com/billing/done", "CANCEL_URL": "https://app.example.com/billing", "PLANS": "price_123=pro" }
  }
}
```

## Settings

| Setting | | Default |
| --- | --- | --- |
| `SUCCESS_URL` | Where Checkout sends the user once they've paid (`{CHECKOUT_SESSION_ID}` is filled in by Stripe). | needed |
| `CANCEL_URL` | Where Checkout sends the user when they go back without paying. | needed |
| `PORTAL_RETURN_URL` | Where the customer portal's back link goes. Empty: `CANCEL_URL`. | |
| `PRICES` | The price IDs apps may check out, separated by commas. Empty: any active price. | |
| `PLANS` | Each price's plan name: `price_123=pro,price_456=team`. Without one: the price's lookup key, else its product's ID. | |
| `PLAN_CLAIM` | The claim the plan goes in. Empty: no claim. | `plan` |
| `COLLECTION` | One document per user (`billing/{uid}`): their Stripe customer, and their subscription with the record on. | `billing` |
| `RECORD_SUBSCRIPTIONS` | Keep each user's subscription and purchases on their document. | `true` |
| `TRIAL_DAYS` | A free trial for new subscriptions (0: none). | `0` |
| `PROMOTION_CODES` | Let customers enter promotion codes in Checkout. | `false` |
| `AUTOMATIC_TAX` | Stripe Tax works out the tax (turn it on in Stripe first). | `false` |
| `MULTIPLE_SUBSCRIPTIONS` | Let a user have more than one subscription (add-ons): the record lists them all, the claim holds a list. | `false` |
| `WHO_CAN_CHANGE_SEATS` | `server` (only the project's own code) or `signed-in` (subscribers change their own seats). | `signed-in` |
| `WHO_CAN_CHARGE` | Who may call `pay` and `bill` (an amount they choose): `server`, `signed-in` (`pay` for themselves) or `claim`. | `server` |
| `CHARGE_CLAIM` | With `claim`: the claim that may, `admin` or `role=office`. | `admin` |
| `CURRENCIES` | The currencies amounts may be in; the first when a call doesn't say. | `gbp` |
| `MIN_AMOUNT`, `MAX_AMOUNT` | The amounts `pay` and `bill` take, in the currency's smallest unit (`1999` is £19.99). | `50`, `100000` |
| `INVOICE_DAYS` | Days to pay a bill when the call doesn't say. | `14` |
| `WHO_CAN_REFUND` | `server` or `claim` (and the project's own code). | `server` |
| `REFUND_CLAIM` | With `claim`: the claim that may refund. | `admin` |

Secrets: `SECRET_KEY` (or a restricted key with customers, prices, Checkout sessions, billing portal, subscriptions,
invoices, refunds and billing meters, for what you use) and
`WEBHOOK_SECRET`, as the project secrets `PAYMENTS__SECRET_KEY` and `PAYMENTS__WEBHOOK_SECRET` for the copy installed as
`payments`.

## Apps

```dart
// Subscribe, or buy something once (a recurring price is a subscription, any other a payment).
final r = await functions.call("payments.checkout", { "price": "price_123" });   // { url, id }
await launchUrl(Uri.parse(r["url"]));

// Cards, invoices, changing or cancelling the plan: Stripe's own page.
final portal = await functions.call("payments.portal", {});                     // { url }

// The subscription now, from Stripe (also brings the record and the claim up to date).
final s = await functions.call("payments.subscription", {});                   // { plan, subscription }

// Cancel at the end of the period ({ "now": true }: at once; { "resume": true }: undo it).
await functions.call("payments.cancel", {});

// Several prices in one checkout (one recurring: a subscription, the others on its first invoice).
await functions.call("payments.checkout", { "items": [{ "price": "price_team", "quantity": 5 }, { "price": "price_setup" }] });

// A pricing page: the prices on offer, with products, amounts, intervals, trial days.
final prices = await functions.call("payments.prices", {});                    // { prices: [...] }

// Seats: charged or credited for the rest of the period.
await functions.call("payments.setQuantity", { "quantity": 8 });
```

Your own functions (and whoever the settings allow) charge any amount, bill by invoice, report usage and refund:

```ts
import { functions } from "@winche-technologies/winche-admin";

// Pay now, any amount (in the smallest unit: 2500 is £25.00): a Checkout page for that user.
const { url } = await functions.call("payments.pay", { uid, amount: 2500, currency: "gbp", description: "Deposit for 12 March" });

// Pay later: Stripe emails an invoice with its own page to pay it, to a user or any email.
await functions.call("payments.bill", { email: "pat@example.com", amount: 12000, description: "Call-out and repair", dueDays: 14 });

// Usage-based prices: report to a Stripe billing meter (its event name); id makes a repeat count once.
await functions.call("payments.reportUsage", { uid, meter: "api_calls", value: 3, id: requestId });

// Refund a purchase, all of it or part.
await functions.call("payments.refund", { uid, purchase: "cs_…", amount: 1000 });
```

The callables act for the signed-in user; signed-out callers are refused. The project's own code (other functions, the
console) calls them for a user by giving `uid` (and `email` for a new customer).

A user's first checkout makes their Stripe customer (with their uid and email), kept on their document; later ones
reuse it. Starting a subscription when one is already going is refused (plans change in the portal), unless
`MULTIPLE_SUBSCRIPTIONS` is on; then `setQuantity` and `cancel` take `subscription` (its id) when there are several.

## What apps and rules see

After Stripe's events, the user's document (`billing/{uid}`) has:

```json
{
  "customerId": "cus_…",
  "plan": "pro",
  "subscription": { "id": "sub_…", "status": "active", "plan": "pro", "price": "price_123", "product": "prod_…",
                    "quantity": 1, "currentPeriodEnd": "2026-12-19T…", "cancelAtPeriodEnd": false, "trialEnd": null },
  "updatedAt": "…"
}
```

(with `MULTIPLE_SUBSCRIPTIONS`, also `plans` and `subscriptions`, every one), one-off purchases under
`billing/{uid}/purchases/{checkout session id}`: `{ price, description, amount, currency, paymentIntent, at }`, with
`refunded` and `status` after a refund and `dispute` when the payment is disputed, and invoices under
`billing/{uid}/invoices/{invoice id}`: `{ number, status, description, amountDue, amountPaid, currency, hostedUrl, pdf,
dueDate }`.

The plan claim (`plan: "pro"`) is on the user while their subscription is `active`, `trialing` or `past_due` (Stripe is
still retrying the payment), and taken off when it ends. It's in their next token:

```text
match reports/{id} {
  allow read: if request.auth.token.plan in ["pro", "team"];
}
match billing/{uid} {
  allow read: if request.auth.uid == uid;
  allow write: if false;            // only the plugin writes here
  match purchases/{id} { allow read: if request.auth.uid == uid; }
  match invoices/{id} { allow read: if request.auth.uid == uid; }
}
```

Each event makes the plugin read the customer's subscriptions from Stripe again, so events arriving late or out of
order can't leave an old state behind. Events whose signature isn't Stripe's (with `WEBHOOK_SECRET`), or more than
five minutes old, are refused with 400; a failure on the way answers 500, and Stripe sends the event again.

## What it does with your data

- Creates a Stripe customer for each user who starts a checkout or is billed, with their uid and email.
- Starts Checkout and portal sessions; changes seats and cancels subscriptions when users ask.
- Charges and bills amounts, reports usage and makes refunds when your code (or whom you allow) asks.
- Writes each user's customer, subscriptions, purchases and invoices to their document in the customers collection.
- Sets the plan claim on subscribers, and takes it off when their subscription ends.

Its functions act with the server's rights, as any function does. It speaks Stripe API version 2024-06-20.

## Develop

```sh
npm install
npm test        # builds, then runs the tests with Deno (Stripe and the project's data stood in)
```

Publishing: push a tag `v<version>` (the version in package.json); the workflow tests it and publishes to npm with
trusted publishing.

## License

MIT (`LICENSE`).
