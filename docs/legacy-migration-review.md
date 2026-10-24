# Legacy migration: diagnostics and safety contract

Baseline: GitHub main `9b327da3627ad1a20cd03a61a770f5aa204b1a8b` (fetched before development). This change is not deployed. Production account identifiers, positions, balances and transaction evidence belong in private audit reports, never in this repository.

## Read-only review

Authenticated `GET /api/v4/legacy-diagnostics?id=...` returns a checklist with each field's value, status, reason and advice. `all=true` inventories old accounts. `verifyExchange=true` explicitly requests native read-only verification. The settings page prioritizes blockers, folds passed/history checks, exports the private report and disables migration until checks pass. Submission revalidates under the account trade lock; delayed responses for another account cannot enable the button.

- FILLED records are executions, not working orders. Proven balanced historical executions are logically archived; original records are neither deleted nor rewritten.
- Quantity scopes include symbol, position direction, platform and quote currency. Legacy eight-decimal rounding has a bounded tolerance.
- Residual quantities mean a reconciliation discrepancy, not proof of the actual current position. Unknown states, missing fields, duplicate IDs, partial terminal executions, truncated history and missing/corrupt account ledger sources remain blocking.
- Signed short quantities, placingOrder, active risk locks, exit confirmations, cooldowns and occupied companion books block migration. Historical recovered errors alone do not.
- Current Paper equity must be valid and reconcile with complete historical net results. Missing net PnL, capped history or balance discrepancies require evidence review; migration does not substitute an initial balance or fabricate net profit.
- Native Live verification checks all markets, not just the selected symbol. Missing arrays, unknown quantities, any nonzero position and unresolved native orders fail closed. Native checks do not use trading methods.

## Explicit migration and rollback

Only proven flat, stopped, settled, conflict-free old Paper accounts can explicitly migrate to Trend V3 Paper. The account ID, instrument, capital basis, historical records and orders remain intact; current equity transfers, risk history survives and the account stays stopped.

`terminal/migration-audit.js` is the shared permission service. `/api/v4/migrate` invokes its formal permission, full ledger/equity diagnosis and audit preparation. `/api/config`, `/api/trend-only/config` and `/api/v4/config` invoke the same permission service **before** configuration writes or state clearing. All legacy configuration writes are rejected with `LEGACY_MIGRATION_REQUIRED`, pointing to Settings. A caller-supplied `confirm` or `entryPoint` cannot impersonate the formal route. There is no Classic→V1/V2 default, Smart→Classic reset, intermediate legacy-strategy hop or compatibility Live→Paper conversion. Already migrated V3 accounts retain normal stopped/flat configuration access, but cannot downgrade to old engines, enable Live, replace their ID or reset their initial equity through these writers. Recovery, reduce-only protection and exit code paths are separate and retained.

Old Live accounts retain their original permissions and are not automatically converted into Paper accounts or moved between venues. Native flatness is a point-in-time observation, not an automatic migration approval.

Migration writes a private PREPARED/COMPLETED audit, including before snapshots and evidence. Rollback verifies history/order fingerprints, inactivity, current risk and unchanged financial state. Failed writes restore the complete old runtime instead of leaving newly introduced engine fields behind.

## Manual reconciliation — no force unlock

1. Export the diagnostic report; retain its evidence hash, timestamp and account ID privately.
2. Match original open/add/close fills by original IDs, instrument scope, direction, quantity and time; include cancellations and partial execution receipts. Recover truncated records only from genuine backups/receipts.
3. Reconcile original capital, complete realized net profit/loss, fees, funding and documented capital adjustments. Do not substitute gross PnL for missing net PnL or infer a capital reset.
4. Record operator/reviewer identity, evidence references, discrepancies and their resolution in the private review ticket. Unprovable cases remain restricted. There is no `flat=true` override or force-unlock endpoint.
5. Re-run the checklist against evidence-backed original state. Eligible Paper accounts still require explicit migration confirmation. Never auto-start.

## Verification and scope

Regression tests cover flat migration, historical execution archive, residual/unknown/duplicate/missing-field orders, bounded rounding, quote isolation, source corruption, signed exposure, active risk/cooldowns, capital reconciliation, native all-market checks, rollback and failed-write restoration, authentication and UI stale-response protection.

Pre-deployment compatibility patch based on `d67e7fd0f180b5f662718f29a72521b8f87e74a0`: full test-script result **336 passed, 0 failed**, plus the smart-strategy, trade-accounting, trading-safety and instrument-catalog script checks. The package's test command was executed verbatim through Node (npm.cmd is not available on the local shell PATH). The server API suite contains 69 passing top-level cases, including a 48-combination legacy/config-route/target rejection matrix and network-free native reduce-only exit mocks for all four old engines. Retired upgrade expectations were replaced with formal migration or directly seeded historical fixtures; V1/V2 computation/recovery coverage remains.

Browser fixture: `node tests/legacy_ui_fixture.js`, port 39125. Every mutation is rejected. `synthetic-2` displays a ledger blocker and disables migration; `synthetic-5` has balanced executions and enables explicit confirmation. Screenshots and DOM measurements were inspected with synthetic data, not production mutations.

No strategy parameters, entry/exit calculations or trading runtimes are changed. Trend V3 / 4H remain Paper-only; Short-Term remains Shadow. Production audit details are retained only in the ignored local `.audit/` directory and the private task handoff.
