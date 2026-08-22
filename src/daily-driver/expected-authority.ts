import { readFileSync } from "node:fs";
import { canonicalJson, DAILY_DRIVER_SUITE_VERSION, sha256 } from "./contract.js";
import { DAILY_DRIVER_RUNTIME_POLICY_VERSION } from "./runtime-policy.js";

export const TRUSTED_EXPECTED_SCHEMA_VERSION = "howa.ddv1-trusted-expected.v1" as const;
export const AUTHORITY_SCHEMA_VERSION = "howa.ddv1-authority.v3" as const;
export const VALIDATOR_CHECK_SET_SCHEMA_VERSION = "howa.ddv1-validator-check-set.v1" as const;

interface ValidatorTrialContract {
  trial_id: string;
  consumed_expected_fields: string[];
  specific_check_ids: string[];
}

interface ValidatorContract {
  schema_version: typeof VALIDATOR_CHECK_SET_SCHEMA_VERSION;
  suite_version: typeof DAILY_DRIVER_SUITE_VERSION;
  shared_check_ids: string[];
  trials: ValidatorTrialContract[];
}

export interface ValidatorCheckSetIdentity {
  schema_version: typeof VALIDATOR_CHECK_SET_SCHEMA_VERSION;
  suite_version: typeof DAILY_DRIVER_SUITE_VERSION;
  trial_id: string;
  consumed_expected_fields: string[];
  validator_check_ids: string[];
  validator_check_set_digest: string;
}

export interface AuthorityIdentityInput {
  run_id: string;
  trial_id: string;
  fixture_digest: string;
  entropy_commitment: string;
  expected_object_digest: string;
  validator_check_set_digest: string;
  required_sources_digest: string;
}

export interface TrustedExpectedEvidence extends AuthorityIdentityInput {
  schema_version: typeof TRUSTED_EXPECTED_SCHEMA_VERSION;
  suite_version: typeof DAILY_DRIVER_SUITE_VERSION;
  runtime_policy_version: typeof DAILY_DRIVER_RUNTIME_POLICY_VERSION;
  attempt: number;
  expected: Record<string, unknown>;
  consumed_expected_fields: string[];
  validator_check_ids: string[];
  authority_digest: string;
}

let cachedContract: ValidatorContract | null = null;
function validatorContract(): ValidatorContract {
  if (cachedContract) return cachedContract;
  const value = JSON.parse(readFileSync(new URL("../../contracts/howa-ddv1-validator-check-set.v1.json", import.meta.url), "utf8")) as ValidatorContract;
  if (value.schema_version !== VALIDATOR_CHECK_SET_SCHEMA_VERSION || value.suite_version !== DAILY_DRIVER_SUITE_VERSION || !Array.isArray(value.shared_check_ids) || !Array.isArray(value.trials)) throw new Error("committed validator check-set contract is unsupported");
  if (new Set(value.trials.map((item) => item.trial_id)).size !== value.trials.length) throw new Error("committed validator check-set contract has duplicate trials");
  cachedContract = value;
  return value;
}

export function validatorCheckSetIdentity(trialId: string): ValidatorCheckSetIdentity {
  const contract = validatorContract();
  const trial = contract.trials.find((item) => item.trial_id === trialId);
  if (!trial) throw new Error(`validator check-set contract is missing ${trialId}`);
  const unsigned = {
    schema_version: contract.schema_version,
    suite_version: contract.suite_version,
    trial_id: trial.trial_id,
    consumed_expected_fields: [...trial.consumed_expected_fields].sort(),
    validator_check_ids: [...contract.shared_check_ids, ...trial.specific_check_ids],
  };
  return { ...unsigned, validator_check_set_digest: sha256(Buffer.concat([Buffer.from("howa-ddv1-validator-check-set-v1\0"), Buffer.from(canonicalJson(unsigned))])) };
}

export function expectedObjectDigest(expected: Record<string, unknown>): string {
  return sha256(canonicalJson(expected));
}

export function requiredSourcesDigest(requiredSources: string[]): string {
  return sha256(canonicalJson(requiredSources));
}

export function computeAuthorityDigest(input: AuthorityIdentityInput): string {
  const identity = {
    schema_version: AUTHORITY_SCHEMA_VERSION,
    suite_version: DAILY_DRIVER_SUITE_VERSION,
    runtime_policy_version: DAILY_DRIVER_RUNTIME_POLICY_VERSION,
    run_id: input.run_id,
    trial_id: input.trial_id,
    fixture_digest: input.fixture_digest,
    entropy_commitment: input.entropy_commitment,
    expected_object_digest: input.expected_object_digest,
    validator_check_set_digest: input.validator_check_set_digest,
    required_sources_digest: input.required_sources_digest,
  };
  return sha256(Buffer.concat([Buffer.from("howa-ddv1-authority-v3\0"), Buffer.from(canonicalJson(identity))]));
}

export function trustedExpectedEvidence(input: AuthorityIdentityInput & { attempt: number; expected: Record<string, unknown>; authority_digest: string }): TrustedExpectedEvidence {
  const checkSet = validatorCheckSetIdentity(input.trial_id);
  return {
    schema_version: TRUSTED_EXPECTED_SCHEMA_VERSION,
    suite_version: DAILY_DRIVER_SUITE_VERSION,
    runtime_policy_version: DAILY_DRIVER_RUNTIME_POLICY_VERSION,
    run_id: input.run_id,
    trial_id: input.trial_id,
    attempt: input.attempt,
    fixture_digest: input.fixture_digest,
    entropy_commitment: input.entropy_commitment,
    expected: input.expected,
    expected_object_digest: input.expected_object_digest,
    consumed_expected_fields: checkSet.consumed_expected_fields,
    validator_check_ids: checkSet.validator_check_ids,
    validator_check_set_digest: input.validator_check_set_digest,
    required_sources_digest: input.required_sources_digest,
    authority_digest: input.authority_digest,
  };
}

export function assertExpectedFieldsCorrespond(trialId: string, expected: Record<string, unknown>): ValidatorCheckSetIdentity {
  const checkSet = validatorCheckSetIdentity(trialId);
  if (canonicalJson(Object.keys(expected).sort()) !== canonicalJson(checkSet.consumed_expected_fields)) throw new Error(`authority.expected fields do not exactly match validator contract for ${trialId}`);
  return checkSet;
}
