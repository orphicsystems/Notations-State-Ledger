# Local corpus maintenance

The production backend can retain an immutable maintenance plan for an
operator-declared correction or withdrawal of a retained acquisition,
normalization, or candidate build. This is the first operational maintenance
increment: it identifies work for review without rewriting the evidence or
promoting candidate data.

`src/production/maintenance.ts` reopens exact production run receipts and derives
only the dependencies those operations actually declared:

- acquisition -> normalization from a completed `NORMALIZE` request;
- normalization -> candidate build from a completed `BUILD_CANDIDATES` request.

References include kind, identifier and full digest. Both run receipts and
upstream artifacts are verified. Failed and quarantined runs are reported as
excluded after verification; corrupted dependencies refuse the plan. The
backend time must not precede the selected runs or artifacts.

A correction marks reached dependents `RESTATED`; a withdrawal marks them
`UNSUPPORTED`. Both produce review actions. The replacement is an operator's
proposal: verifying its retained bytes does not verify that it corrects the
original. The target always receives `REVIEW_TARGET`, including when no
selected run consumes it.

## Operator command

Use the exact artifact and run references returned by the existing production
operations or catalog. Save a request with this shape (replace placeholders
with retained identifiers and full SHA-256 digests):

```json
{
  "schema": "payload.maintenance-request.v1",
  "requestId": "review-carrier-correction-1",
  "kind": "CORRECTION",
  "target": {"kind": "ACQUISITION", "id": "OLD_ACQUISITION_ID", "digest": "sha256:FULL_DIGEST"},
  "replacement": {"kind": "ACQUISITION", "id": "NEW_ACQUISITION_ID", "digest": "sha256:FULL_DIGEST"},
  "reason": "Review downstream candidates after corrected source capture",
  "runs": [
    {"id": "NORMALIZATION_RUN_ID", "digest": "sha256:FULL_DIGEST"},
    {"id": "CANDIDATE_BUILD_RUN_ID", "digest": "sha256:FULL_DIGEST"}
  ]
}
```

For `WITHDRAWAL`, set `replacement` to `null`. Select 1–128 distinct run
references. The planner sorts the selection; changing the order does not create
a different request.

```sh
npm run maintenance -- plan --root .payload/evidence --request request.json
npm run maintenance -- inspect --root .payload/evidence --id review-carrier-correction-1 --digest sha256:PLAN_DIGEST
```

Plans are stored under the operator-selected evidence root in
`maintenance-v1/plans/`. Identical retries reopen the original plan and timestamp;
a changed request requires a new identifier. Reopening recomputes the plan from
its pinned inputs. Missing or modified evidence causes an integrity failure,
not an automatic repair. Publication uses the existing create-only local file
primitive with readback. This retains its trusted-local-filesystem and
process-crash guarantees; it is not a hosted queue or power-loss guarantee.

## Production API

After `npm run production:build`, the existing explicitly enabled local service
supports:

- `POST /api/production/maintenance` with the request above;
- `POST /api/production/maintenance/inspect` with
  `{"schema":"payload.maintenance-inspection-request.v1","reference":{"id":"PLAN_ID","digest":"sha256:PLAN_DIGEST"}}`.

Both use the existing loopback-origin checks, fixed worker, body limits and
server-selected `PAYLOAD_PRODUCTION_DIR`. HTTP callers cannot select storage
paths or supply clocks. The plan response contains exact source identifiers,
review actions and coverage limits, not source bytes or candidate field values.

## Coverage and next increments

The closure includes only the selected completed producer runs. Omitting the
normalization run breaks an acquisition-to-build path even if the build run is
selected. A zero-length result therefore means no reachable dependents in that
selection; untracked dependents remain `UNDETERMINED`. Each reached artifact
retains one shortest predecessor, not every possible provenance path.

Plans do not queue or execute rebuilds, grant current source rights, create
canonical retractions, admit records, activate releases, or send notifications.
A later plan with additional run references uses a new identifier and preserves
the earlier plan. Rebuilds still use new production requests and current source
policy checks; their results remain unadmitted.

The next increments are automatic scoped producer inventory, reviewed rebuild
execution with durable retry records, and a supported Landshark extraction
contract. Current Landshark production can retain IFC artifacts, but Carrier
normalization and candidate assembly remain Caravan-specific. Admitted corpus
correction and downstream delivery require their separate record/release
contracts; this artifact planner does not claim to close those gaps.

Validation exercises real local capture -> normalization -> build -> maintenance
-> reopen paths, independent branches, partial selection, withdrawal, quarantine,
clock ordering, conflicting retries, and tampering. API tests cover transport
validation and the fixed worker dispatch.
