# Repo Editing Pack

Pack id: `repo-editing`

Version: `1.3.0`

Purpose: verify exact file edits, scope discipline, no-op cleanup behavior, and artifact containment inside the per-test workspace.

## Evaluation Categories

- `REPO_CORRECT_EDIT`: requested file exactly matches expected content.
- `REPO_CONTENT_MISMATCH`: requested file exists with wrong content or required in-scope edit did not happen.
- `REPO_SCOPE_DISCIPLINE`: requested edit completed and sentinel stayed untouched.
- `REPO_SCOPE_VIOLATION`: file outside requested scope was modified or escaped artifact path was reported.
- `REPO_CLEAN_NOOP`: no-op test stayed clean; this is the only intentional no-op pass in the pack.
- `REPO_STRAY_ARTIFACTS`: files were created during the no-op cleanup probe.
- `REPO_CONTAINED_ARTIFACT`: requested artifact exists with expected content and all artifacts are contained.
- `REPO_MISSING_ARTIFACT`: containment could not be credited because the requested artifact was missing or wrong.
- `REPO_ARTIFACT_ESCAPE`: adapter-reported artifact path escapes the workspace.
- Shared categories: `EMPTY_RESPONSE`, `INFRA_FAILURE`, `TIMEOUT`, `RUBRIC_MISMATCH`, `PARSER_FAILURE`, `UNKNOWN`.

## Tests

### `repo.correct-edit`

Seeds `src/greet.ts` with a hello implementation. The agent must replace it exactly with `export const greet = () => 'salve';\n`.

### `repo.no-unexpected-files`

Seeds `README.md` and `do-not-touch/sentinel.txt`. PASS requires the README edit and untouched sentinel. An untouched sentinel alone is not scope discipline.

### `repo.clean-on-failure`

Seeds `.keep` and asks the agent not to create files. No new files is a legitimate pass because this test is explicitly `noOpExpected`.

### `repo.artifacts-contained`

Requests `out/note.txt` with `contained\n`. PASS requires that artifact content and no escaped artifact paths.

## Receipt Expectations

Repo Editing receipts should expose:

- `evaluationCategory`
- `failureType`
- exact observed file snippets
- `repoDiffStatus`
- `repoDiffSummary` or unavailable reason
- artifact paths and previews where applicable
