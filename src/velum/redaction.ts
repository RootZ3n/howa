/**
 * Secret redaction. Used by Velum and by receipt writers.
 *
 * Important property: redaction NEVER hides the fact that a leak happened.
 * It rewrites the secret bytes for storage but the redaction event itself
 * is preserved in the receipt as evidence.
 */

export interface SecretMatch {
  kind: string;
  classification: "confirmed_secret" | "possible_sensitive";
  start: number;
  end: number;
  preview: string;
}

const PATTERNS: { kind: string; classification: SecretMatch["classification"]; re: RegExp }[] = [
  { kind: "anthropic_api_key", classification: "confirmed_secret", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai_api_key", classification: "confirmed_secret", re: /sk-[A-Za-z0-9]{20,}/g },
  { kind: "aws_access_key_id", classification: "confirmed_secret", re: /AKIA[0-9A-Z]{16}/g },
  { kind: "aws_secret_access_key", classification: "confirmed_secret", re: /AWS_SECRET_ACCESS_KEY\s*[=:]\s*[A-Za-z0-9/+]{40}/gi },
  { kind: "github_token", classification: "confirmed_secret", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { kind: "google_api_key", classification: "confirmed_secret", re: /AIza[0-9A-Za-z_-]{35}/g },
  { kind: "slack_token", classification: "confirmed_secret", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { kind: "private_key_block", classification: "confirmed_secret", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |)PRIVATE KEY-----[\s\S]*?-----END[^-]*-----/g },
  { kind: "jwt", classification: "confirmed_secret", re: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  { kind: "bare_jwt", classification: "confirmed_secret", re: /\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g },
  { kind: "bearer_authorization", classification: "confirmed_secret", re: /\bBearer\s+[A-Za-z0-9._~+\/-]{12,}/gi },
  { kind: "base64_key_body", classification: "possible_sensitive", re: /(?:^|[\s"':=])(?:[A-Za-z0-9+/]{64,}={0,2})(?=$|[\s"',}])/gm },
  { kind: "json_credential", classification: "confirmed_secret", re: /"(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|password|private[_-]?key|secret)"\s*:\s*"[^"\n]{6,}"/gi },
  { kind: "dotenv_assignment", classification: "confirmed_secret", re: /(?:^|\n)\s*(?:[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD))\s*=\s*[^\n]{6,}/g },
];

export function findSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { kind, classification, re } of PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (kind === "base64_key_body" && /^(?:[\s"':=])*[a-fA-F0-9]+(?:[\s"',}]*)$/.test(m[0])) continue;
      matches.push({
        kind,
        classification,
        start: m.index,
        end: m.index + m[0].length,
        preview: m[0].slice(0, 6) + "…" + m[0].slice(-4),
      });
    }
  }
  return matches;
}

export function redact(text: string): { redacted: string; matches: SecretMatch[] } {
  const matches = findSecrets(text);
  if (matches.length === 0) return { redacted: text, matches: [] };
  // sort and replace from the end so indexes stay valid
  matches.sort((a, b) => b.start - a.start);
  let out = text;
  for (const m of matches) {
    out = out.slice(0, m.start) + `[REDACTED:${m.kind}]` + out.slice(m.end);
  }
  // restore ascending order for callers
  matches.sort((a, b) => a.start - b.start);
  return { redacted: out, matches };
}
