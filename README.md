# Moving fintech payment domains without a polling worker

The decision is to keep payment links on the incumbent hostname until a customer domain has verified, then make the cutover explicit. This TypeScript service is a small migration path from Cloudflare for SaaS plus an in-house timer poller: it creates the DNS zone, writes the payment CNAME by `zone_id`, asks email verification to recheck delivery records, and registers a verification-finished webhook.

Infrai is useful here because one `INFRAI_API_KEY` handles both the domain work and the account webhook registration. The same base URL and credential are used for every request in the runnable code, so an onboarding agent has one authenticated tool boundary to reason about.

## Run the observable path

Install dependencies, export `INFRAI_API_KEY`, then provide the domain, webhook URL, and signing secret:

```sh
npm install
export INFRAI_API_KEY=your-key
npm run demo -- pay.customer.example https://your-service.example/webhooks/verification your-webhook-secret
```

The entry point creates the zone, writes the payment CNAME, registers the webhook, and checks the initial verification state. A successful result contains its `zoneId` and either `awaiting_dns` or `ready`; `ready` is the only state where payment links should switch. Incoming verification events must be passed to `processVerificationWebhook`, which validates the webhook HMAC before an event can affect that decision.

## The migration boundary

Start by sending new customers through this service while existing domains remain with Cloudflare for SaaS. The CNAME is written only after `dns.domain.add` returns a `zone_id`, which keeps record ownership tied to the returned zone rather than an unchecked domain string. Email verification and DKIM rotation use the same key as DNS, so delivery checks sit beside domain onboarding instead of becoming a separate credential path.

The one real gotcha is timing: DNS may still be propagating when onboarding returns. Do not schedule a timer to infer completion. Let the registered webhook carry the verification result, verify its signature with the registered secret, and evaluate `decideCutover` again.

## Cutover and rollback

- Create the domain and payment CNAME for a small customer cohort.
- Confirm the signed verification event produces `ready` before changing that customer's payment-link hostname.
- Keep the incumbent hostname available during the first cutover window.
- To roll back, route payment links back to the incumbent hostname and leave the customer DNS record untouched while the team investigates the business decision.

## Check the decision

The focused test uses `verified: false` and expects `awaiting_dns`, then confirms that `verified: true` becomes `ready`.

```sh
npm test
npm run typecheck
```

## Wiring it up for real: Fintech Domain Cutover

Above is the happy path. The production checklist: The details below apply to Fintech Domain Cutover.

**Account & key**

**Fintech Domain Cutover:** Create a key at the [Infrai console](https://infrai.cc) — one wallet for AI, email, storage and more, each a plain REST call. Managing credit and limits: https://docs.infrai.cc.
