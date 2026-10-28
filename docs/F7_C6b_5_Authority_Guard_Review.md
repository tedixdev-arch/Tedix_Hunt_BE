# PR #87 — Local authority guard review and hardening

Review target: migration 027 and matching fresh-schema SQL. This updates the existing
undeployed Draft PR in place; it introduces no migration 028, API change, backfill,
workflow change, merge or deployment.

## Findings reproduced against the original PR

Four initial PostgreSQL regression tests failed before the fix:

1. A historical compatibility capture could be followed by changing the approved
   candidate pin while leaving the pointer unchanged. The immediate guard checked
   candidate/pointer agreement only on a status transition; the deferred compatibility
   exception skipped final candidate agreement.
2. An already established pointer likewise allowed approved-pin drift without a status
   change. Pointer-unchanged deferred events returned without inspecting final authority.
3. New approved reviews could be inserted directly into evidence-less historical
   approvals; only transaction-ID inference prevented their capture.
4. **A savepoint defeated that inference.** A review inserted under a savepoint has a
   subtransaction `xmin`, which differs from the top-level transaction ID. Inserting an
   independent non-Admin review in a savepoint, releasing it, then capturing the historical
   pointer actually **committed successfully** against the original guards. The compatibility
   branch treated manufactured evidence as historical and bypassed active Admin validation.

The before-fix test run was **0 passed / 4 failed**. Disposable test databases were
created and dropped by the suite; no historical or production records were repaired.

## Durable rules replacing transaction-ID inference

No executable `xmin`, `txid_current`, transaction-ID arithmetic, transaction-local marker,
new audit table or compatibility flag remains in the implementation.

- **New promotion:** an immediate pointer change requires the exact submitted candidate,
  transitions it to approved with the same pin, and requires **no existing decision** for
  that version. An old approved review cannot be promoted through draft/submitted state
  changes, even if it belongs to the same Template.
- **Review insertion:** `bind_local_approval_review` permits a new Local approved review
  only when the identity is already in the exact approving state: approved status, pointer
  and submitted pin all identify that review's version. This preserves the existing model's
  order (identity/pointer update, then review insertion). The guard locks only Local approved
  review identities; Universal, legacy and request-changes insertions retain their behavior.
- **Historical capture:** the immediate guard still requires the old approved submitted pin
  and an existing independent approved review. Historical NULL-pointer approvals cannot
  acquire new approved evidence under the insertion rule. Their status/pin cannot be changed
  before capture, and new NULL-pointer approved identities cannot be inserted or manufactured
  by lifecycle updates. Thus capture evidence must already have existed; savepoints and
  previous metadata updates cannot change that fact.
- **Retention:** pointer clearing/regression, category/ownership changes, cross-Template
  references and classified review mutation/deletion remain prohibited. Retained historical
  evidence need not have a reviewer who is still active: later retirement/capability loss
  does not withdraw an existing approval.
- **Final authority:** every deferred identity event reloads the current identity and checks
  its **final** pointer's exact independent approved review. When the final candidate is
  approved, its submitted pin must equal that pointer. Neither a pointer-unchanged event nor
  a historical capture skips this invariant. New promotions also require the exact final
  approved candidate and active, non-guest, independent Admin evidence when deferred
  constraints are checked, as in existing API transactions.

These rules close the insertion/promotion cycle: new evidence cannot precede promotion;
normal promotion cannot reuse evidence; historical capture cannot obtain new evidence.
A tentative new pointer therefore either gains a valid exact independent Admin review
and passes final validation, or the transaction fails. Subsequent writes cannot clear,
regress or relabel the pointer, mutate its immutable evidence or disguise an invalid
new approval as compatibility. The final reload ensures an intermediate valid event
image is never accepted in place of invalid committed authority.

This integrity argument concerns ordinary guarded INSERT/UPDATE/DELETE with the schema's
constraints and triggers enabled. Two tests deliberately replace and restore the immediate
function inside a disposable transaction to isolate the deferred guard; they demonstrate
independent final-state validation, not authorization to alter database guards operationally.
Their failed COMMIT rolls back both DML and test DDL and leaves the original function intact.

## Adversarial PostgreSQL evidence

`src/db/localTemplateAuthorityGuards.integration.test.ts`: **29 passed / 0 failed / 0 skipped**.
It exercises:

- Compatibility capture followed by pin drift; established pointer with unchanged-status
  pin drift; older historical target and attempted pin rewriting; regression after v2 approval.
- Manufactured historical evidence at top level and inside savepoints, including the exact
  previously committing non-Admin savepoint attack; insertion before ordinary promotion.
- Existing old reviews with draft/submitted candidate states; self-reviewed historical capture.
- Self/non-Admin/missing-role/blocked/retired/guest/missing-review evidence after repeated
  identity updates, all rejected at COMMIT with the original pointer, candidate and reviews
  restored. A nonexistent reviewer fails its restrictive FK without retaining the pointer.
- Admin membership removed after an initially valid review, rejected at COMMIT; the failed
  transaction restores membership as well as candidate/pointer/review state.
- An intermediate valid new approval followed by a final draft, submitted or changes-requested
  candidate, rejected at COMMIT under normal deferred validation. A review undone by savepoint
  rollback cannot leave the tentative pointer behind.
- Final-state checks isolated from the immediate guard, covering both compatibility and
  pointer-unchanged events; complete rollback includes temporary function replacement.
- Valid approval with savepoints/repeated updates when the final candidate is exact;
  historical capture after metadata updates and with a retired reviewer; retained approval
  after later Admin capability removal and retirement.

`src/db/localTemplateApproval.integration.test.ts` retains its **61** model/HTTP/SQL
acceptance tests and now compares the new insertion function and trigger in fresh-schema
parity. Tests that previously manufactured out-of-lifecycle reviews now assert rejection
at insertion; old committed-review promotion is covered using actual pre-027 fixtures
in the new adversarial suite.

## Validation and preservation

Disposable PostgreSQL **17.10** with `TEST_DATABASE_URL`:

- Focused Local approval/guard suites: **90 passed / 0 failed / 0 skipped**.
- Full suite: **1,166 passed / 0 failed / 0 skipped**, 59 files.
- TypeScript typecheck, build and diff checks: pass.

The approved Local revision/suspension contract and all current API behavior remain
unchanged. No Universal publication function/constraint is modified; existing Universal,
legacy, Signal, Organizer-gate and historical Hunt tests remain enabled. Historical
independent evidence is captured without new reviews, self/evidence-less approvals stay
compatible and revision-blocked, and missing pins are never repaired or resolved to latest.
Production inventory remains unavailable and uninspected. Stop for re-review.
