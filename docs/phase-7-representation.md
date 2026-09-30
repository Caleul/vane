# Phase 7: executable topology and planning representation

## Normative basis

The [functional v0.1 PRD](https://app.notion.com/p/3ca51cfc265c81b78834d4649a9048fb) requires explicit ownership (FR-ENT-004, FR-SVC-009/012), permits distinct services to identify the same physical database (FR-SVC-011; closed decision §17.7), and preserves future service boundaries in the IR (FR-COMP-004). Sections 6 and 16 exclude productive distributed execution and a public distributed-topology builder from v0.1. These are separate obligations: planning representation is not distributed execution.

## Optional planning metadata

A profile can declare `plannedAllocation`:

```ts
plannedAllocation: [
  { name: "accounts-service", modules: ["Accounts"], database: "shared-db" },
  { name: "commerce-service", modules: ["Commerce"], database: "shared-db" },
]
```

- This is an inspection-only allocation plan, not a topology/provider builder or deployment instruction
- Every compiled Module must occur exactly once, so each Entity has exactly one planned owner
- Each planned service has one nonsecret database identifier; repeated database identifiers deliberately represent a shared physical-database target
- Names are lowercase identifiers; connection strings and credentials do not belong here
- The supported physical materializer remains the selected PostgreSQL provider. Per-planned-service provider/connection overrides are rejected as unknown fields; incompatible database engines cannot be hidden behind one shared label
- The runtime IR preserves the sorted plan and derived qualified Entity ownership in `plannedAllocation`
- Actual runtime ownership remains in `runtime.ownership`, all assigned to the selected monolithic service; generated infrastructure still contains one service
- Metadata participates in the technical input hash, never in the semantic project hash
- Profile inheritance retains the parent plan unless a child replaces the entire allocation array; absence preserves the previous plan/output shape
- Shared labels assert planning intent, not observed connectivity to a remote database

The independent conformance cases check distinct planned service ownership and shared labels, missing/ambiguous ownership rejection, existing semantic Module/import boundaries, and invariant semantic hashes across different technical profiles. No remote infrastructure is created.

## Column materialization scope

FR-COL-006 says physical materialization may be provided by the ServiceConfiguration **or the provider**. The existing public PostgreSQL materializer supplies physical Column names, SQL types, nullability, defaults and constraints; ServiceConfiguration invokes that same materializer. The domain Column declaration is unchanged. Requiring a new user-configurable physical-name override would strengthen the source requirement without evidence. The conformance case therefore tests the existing provider path directly and through ServiceConfiguration, rather than introducing an unnecessary override API.

## Provider/topology variation limit

FR-SVC-003 describes profiles selecting different providers/topologies, while the v0.1 scope supplies one productive Node.js/PostgreSQL monolith combination. Distinct service names or database labels do **not** prove different runtime implementations. A future alternative productive provider must not receive PASS from an allocation-label test. For v0.1, apply FR-SVC-003 within the available providers: FR-SVC-013 explicitly qualifies provider APIs with “when available”, FR-SVC-017 supplies Node.js, §17.13 fixes monolithic execution, and §16 excludes the public distributed builder. The requirement therefore verifies per-profile explicit provider/topology selection, independently resolved supported-provider configuration, and rejection of unsupported/incompatible selections. The conformance case varies actual HTTP authentication, authorization, CORS and rate-limit configuration, verifies selected provider IDs and technical IR, and proves invalid selection in one profile does not change the other profile. Broader productive variation remains future scope; this applicability qualifier does not claim two different productive runtimes work.
