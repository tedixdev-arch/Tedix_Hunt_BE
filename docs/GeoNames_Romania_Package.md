# G4c-5 Romania-only package evidence

Draft — STOP for ChatGPT review. Base: latest main at
`85991fb38eb8f1125b13c01a97702031c478cf8b` (PR #106 merged).

## Implemented

The manual `geonames-pgadmin-package.yml` workflow defaults to **Romania only**;
**Worldwide** is an explicit alternative. The generator's `--romania-only` flag
selects RO source records before SQL generation through the same validated reader
and importer. The SQL header, import dataset, manifest, artifact name and summary
identify the Romanian cities500 subset. All four unmodified inputs remain hashed.
No migration, API status contract or importer transaction semantics were changed.

The workflow publishes only after first/repeat restricted-role execution and
acceptance on disposable PostgreSQL 17 with baseline + migrations 001–034.
Romania acceptance compares every source city's ID, labels, codes, coordinates,
population, revision and all normalized aliases; asserts zero non-RO cities and
aliases; checks provenance/completed metadata; and compares repeat fingerprints.
SQL bytes and city count are recorded in the manifest, summary and evidence.

## Actual validation on 2026-11-01

- `npm run build`: passed.
- Importer, SQL package and catalog integration suites: **51 passed** on a fresh
  disposable PostgreSQL 17 container. Package tests apply all 34 migrations and
  use a restricted non-superuser role without schema CREATE.
- New mixed-country package test: direct-importer equivalence, one RO fixture
  retained, non-RO fixtures excluded before metadata/coordinate validation,
  first/repeat semantics and completed provenance, late-error rollback, and
  empty RO selection refusing publication. Existing stale-source,
  reconciliation, delimiter and permission-failure tests also passed.
- Acceptance/execution helpers: initial, first and repeat passed end to end on
  a separate synthetic Cluj/foreign fixture in the same disposable service.
  These fixtures are not official-source count/size measurements.
- JavaScript syntax and `git diff --check`: passed.

## Official-data package: blocked, not published

| Requested measurement | Actual result |
| --- | --- |
| Official Romanian city count | Not measured; official inputs unavailable |
| Actual official Romanian SQL bytes | Not measured; no official package generated |
| Official first/repeat acceptance | Not executed |
| Downloadable Actions artifact | Not published; workflow dispatch blocked |

The official source request through the inherited proxy returned
`curl: (56) CONNECT tunnel failed, response 403`, HTTP `403 Forbidden`,
`server: envoy`, at 09:23:03 UTC. The enforced restricted network policy does
not include `download.geonames.org`. No alternative source or proxy bypass was
used.

After pushing the branch, both dispatch attempts failed with `Forbidden`:

```text
gh workflow run geonames-pgadmin-package.yml --repo tedixdev-arch/Tedix_Hunt_BE --ref codex/g4c-5-romania-geonames -f 'scope=Romania only'
GET https://api.github.com/repos/tedixdev-arch/Tedix_Hunt_BE/actions/workflows/geonames-pgadmin-package.yml: Forbidden

POST https://api.github.com/repos/tedixdev-arch/Tedix_Hunt_BE/actions/workflows/geonames-pgadmin-package.yml/dispatches: Forbidden
```

The available GitHub connector has no workflow-dispatch tool. To obtain the
remaining evidence, an authorized owner can manually run the existing package
workflow on this branch with **Romania only**. A successful run will publish
`geonames-pgadmin-romania-only-<run>-<attempt>` for seven days. Download it from
that run and record the manifest's actual `rows` and `bytes`; do not substitute
fixture counts, estimates or ordinary backend CI for this evidence.

No existing development or production database was accessed or modified. No
backend deployment occurred. pgAdmin Web compatibility remains untested.
