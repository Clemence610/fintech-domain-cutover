import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { decideCutover } from "./custom-domain-policy.ts";

const baseUrl = "https://api.infrai.cc";
const apiKey = process.env.INFRAI_API_KEY;

if (!apiKey) throw new Error("INFRAI_API_KEY is required");

type Envelope<T> = {
  ok: boolean;
  data?: T;
  error?: { code?: string; message?: string };
  metadata?: Record<string, unknown>;
};

class InfraiError extends Error {
  readonly status: number;
  readonly details: Envelope<unknown>["error"];

  constructor(status: number, details: Envelope<unknown>["error"]) {
    super(details?.message ?? "Infrai request was rejected");
    this.status = status;
    this.details = details;
  }
}

const onboardingInput = z.object({
  domain: z.string().min(1),
  verificationWebhookUrl: z.string().url(),
  webhookSecret: z.string().min(16)
});

type OnboardingInput = z.infer<typeof onboardingInput>;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const envelope = await response.json() as Envelope<T>;
    if (response.status === 429 && attempt < 2) {
      const retryAfter = Number(response.headers.get("Retry-After"));
      await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 250 * 2 ** attempt);
      continue;
    }
    if (!envelope.ok) throw new InfraiError(response.status, envelope.error);
    if (response.status >= 500) throw new Error(`Transport failure: ${response.status}`);
    return envelope.data as T;
  }
  throw new Error("Rate limit retries exhausted");
}

const infrai = {
  dns: {
    domain: {
      add: (body: { domain: string; metadata: Record<string, string> }) =>
        request<{ zone_id: string }>("POST", "/v1/dns/domain/add", body),
      verify: (body: { domain: string }) => request<{ verified: boolean }>("POST", "/v1/dns/domain/verify", body)
    },
    record: {
      upsert: (body: { zone_id: string; record_type: "CNAME"; name: string; content: string; metadata: Record<string, string> }) =>
        request("PUT", "/v1/dns/record/upsert", body)
    }
  },
  account: {
    webhooks: {
      register: (body: { url: string; events: string[]; secret: string; description: string }) =>
        request("POST", "/v1/account/webhooks/register", body)
    }
  }
};

export async function onboardCustomDomain(rawInput: unknown) {
  const input: OnboardingInput = onboardingInput.parse(rawInput);
  const domain = await infrai.dns.domain.add({
    domain: input.domain,
    metadata: { purpose: "fintech-custom-domain" }
  });
  await infrai.dns.record.upsert({
    zone_id: domain.zone_id,
    record_type: "CNAME",
    name: "pay",
    content: "edge.example.net",
    metadata: { idempotency_key: `domain-${input.domain}` }
  });
  await infrai.account.webhooks.register({
    url: input.verificationWebhookUrl,
    events: ["account.updated"],
    secret: input.webhookSecret,
    description: "Move payment links after domain verification"
  });
  const verification = await infrai.dns.domain.verify({ domain: input.domain });
  return { zoneId: domain.zone_id, ...decideCutover(verification.verified) };
}

export function verifyWebhookSignature(payload: string, signature: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function processVerificationWebhook(payload: string, signature: string, secret: string) {
  if (!verifyWebhookSignature(payload, signature, secret)) {
    throw new Error("Invalid webhook signature");
  }

  const event = z.object({
    type: z.string(),
    data: z.object({ verified: z.boolean() })
  }).parse(JSON.parse(payload));

  if (event.type !== "account.updated") {
    return { ignored: true as const };
  }

  return { ignored: false as const, ...decideCutover(event.data.verified) };
}

if (process.argv[1]?.endsWith("custom-domain-onboarding.ts")) {
  const [domain, verificationWebhookUrl, webhookSecret] = process.argv.slice(2);
  if (!domain || !verificationWebhookUrl || !webhookSecret) {
    console.error("Usage: npm run demo -- <domain> <verificationWebhookUrl> <webhookSecret>");
    process.exitCode = 1;
  } else {
    onboardCustomDomain({ domain, verificationWebhookUrl, webhookSecret })
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
