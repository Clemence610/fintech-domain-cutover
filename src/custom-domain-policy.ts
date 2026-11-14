export type CutoverDecision =
  | { state: "ready"; customerMessage: string }
  | { state: "awaiting_dns"; customerMessage: string };

export function decideCutover(verified: boolean): CutoverDecision {
  return verified
    ? { state: "ready", customerMessage: "Custom domain verified; payment links may use it." }
    : { state: "awaiting_dns", customerMessage: "DNS verification is still pending." };
}
