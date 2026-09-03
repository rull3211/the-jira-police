# SSX Jira components — reference & mapping

The skill assigns a Jira **component** from the SSX project's existing set — never an invented one.

> 🔒 **Tech-lead policy (2026-08-28): only FOUR components are assignable —**
> `SSX Advisor` · `EDH` · `SSX Partner` · `SSX Nettsalg` (the four team streams). Nothing else.
> They are 1:1 with the vault `ssx_component` values. Every other component in the live set is
> **context only**: read it if a human already set it, but the skill **never auto-assigns** it. When
> none of the four clears a medium bar, emit `comp:uncertain` and suggest — never reach past the four.

> ⚠️ **Fetch the live list at runtime.** Components change. Before assigning, pull the current set
> from create-metadata (`getJiraProjectIssueTypesMetadata` → an issue type id →
> `getJiraIssueTypeMetaWithFields` with `requiredFieldsOnly:false`, read `fields[].components.allowedValues`).
> Validate that the four policy components still exist; the snapshot below is the **mapping guide**
> for the full set (reference only — NOT an assign list).

## Snapshot (SSX, captured 2026-08-27 — 36 components)

> **Only the four rows tagged ✅ are assignable** (tech-lead policy). The rest are listed so the
> skill can _recognise_ a human-set component and read context — never to auto-assign it.

| id    | Component                    | Category                    | Map from (signal)                                         |
| ----- | ---------------------------- | --------------------------- | --------------------------------------------------------- |
| 11409 | App Commerce                 | app/service                 | commerce web / `insurance-commerce-*` repo; surface `buy` |
| 11410 | App insurance-price-rest-api | app/service                 | repo `insurance-price-rest-api`; pricing capability       |
| 11407 | App Buy Insurance            | app/service                 | buy/nettsalg web; surface `buy`                           |
| 11408 | App Buy Insurance Advisor    | app/service                 | advisor buy flow; surface `advisor` + `buy`               |
| 11411 | App Lisa                     | app/service                 | repo/app "Lisa"                                           |
| 11413 | App SSX1 Checkout            | app/service (legacy)        | legacy SSX1 checkout                                      |
| 11412 | App SSX1 Check Price         | app/service (legacy)        | legacy SSX1 price                                         |
| 11418 | Commerce Explorer            | app/service                 | commerce-explorer tool                                    |
| 11435 | Service Price Calculation    | app/service                 | pricing/premium calculation logic                         |
| 11419 | Core                         | app/service                 | core/shared backend, cross-cutting platform               |
| 11420 | Customer                     | app/service                 | customer data/domain; customer-master flows               |
| 11424 | EDH                          | ✅ team stream (assignable) | EDH data platform                                         |
| 11417 | BOSS                         | app/service                 | BOSS system                                               |
| 11434 | Salesforce                   | external                    | `route:other-team` when the chain hits salesforce         |
| 11430 | Product Category Motor       | product line                | domain `insurance`, motor/bil (car)                       |
| 11431 | Product Category Personal    | product line                | domain `insurance`, person/personal                       |
| 11432 | Product Category Risk        | product line                | domain `insurance`, risk products                         |
| 12304 | Helse                        | product line                | health insurance (`helse`)                                |
| 12326 | Firmabil                     | product line                | company car (`firmabil`)                                  |
| 12329 | Arbeidsmaskin                | product line                | work machine (`arbeidsmaskin`)                            |
| 12337 | Borettslag                   | product line                | housing cooperative (`borettslag`)                        |
| 12331 | Eiendeler                    | product line                | contents/belongings (`eiendeler`, `innbo`)                |
| 11428 | Person                       | product line                | person line (`personforsikring`)                          |
| 11416 | BM                           | product line/segment        | business market (`bedrift`, BM)                           |
| 11427 | Partner                      | channel/segment             | partner channel                                           |
| 11415 | Biltema                      | channel/partner             | Biltema partner                                           |
| 11406 | Advisor                      | channel/stream              | advisor channel; surface `advisor`                        |
| 12644 | SSX Advisor                  | ✅ team stream (assignable) | advisor value stream/board                                |
| 12643 | SSX Nettsalg                 | ✅ team stream (assignable) | nettsalg (online sales) stream; surface `buy`             |
| 15544 | SSX Partner                  | ✅ team stream (assignable) | partner stream                                            |
| 11422 | Design/UX                    | cross-cutting               | UI/UX-only work; designer lens                            |
| 11429 | PM                           | cross-cutting               | product-management task                                   |
| 11421 | Customer Feedback            | cross-cutting               | customer feedback / VoC                                   |
| 12342 | Compliance - BM              | cross-cutting               | compliance in the business market                         |
| 11426 | Old stuff                    | **do not auto-assign**      | legacy catch-all — human only                             |
| 12645 | SMÅOPPGAVER                  | **do not auto-assign**      | small-tasks catch-all — human only                        |

> ⚠️ **`price` capability & component are SSX, never POPS.** `App insurance-price-rest-api` (id 11410)
> is the SSX buy-flow price/discount module — a **sub_service of `insurance-ssx-mono-repo`** (not a
> top-level vault entry of its own). Its capability lookup `openapi/insurance-price-rest-api.md`
> carries **no `owning_team` in frontmatter** — attribute it to **SSX**, NEVER Insurance Price /
> `POPS`. The separate `insurance-price-mono-repo` (Prismotor price-**engine**) is POPS-owned — seed
> **no** SSX component for it (`route:other-team` ⇒ `⚪ n/a`).

## Matching algorithm (four components only)

Run after candidate-repo match (step 3), routing (step 6), and surface detection (step 1). The
component axis is SSX-only AND limited to the four team streams. Decide in this precedence:

0. **Vault `ssx_component` (deterministic — strongest).** If the matched repo is SSX-owned
   (`owning_team == SSX`) and its `index.yaml` entry carries an `ssx_component` that is not
   `multiple`, **seed that component directly** — it is already one of the four (`EDH`,
   `SSX Advisor`, `SSX Nettsalg`, `SSX Partner`) and 1:1 with the live name. Validate against the
   live create-metadata set, then apply at HIGH. Never seed a component for a non-SSX repo — the
   component axis is SSX-only (`route:other-team` ⇒ `⚪ n/a`).
1. **Surface → stream fallback** — only when `ssx_component` is `multiple`/absent. Map the surface
   to a stream: `buy` / nettsalg → `SSX Nettsalg` · `advisor` → `SSX Advisor` · partner channel →
   `SSX Partner` · EDH data-platform signal → `EDH`. Take the stream the strongest signal supports.
2. **Nothing else maps.** Product lines, apps, cross-cutting, external systems are **NOT assignable**
   (tech-lead policy). If the ask looks like one of those, resolve it to the owning stream among the
   four, or — if no stream clears a medium bar — emit `comp:uncertain` and suggest. Never assign a
   fifth component.

## Rules

- **Four only.** Assign a component ONLY from `SSX Advisor` · `EDH` · `SSX Partner` · `SSX Nettsalg`
  (tech-lead policy, 2026-08-28). Never invent one; never auto-assign any other live component — not
  a product line, not an app, not `Old stuff`, not `SMÅOPPGAVER`.
- **One is the norm.** A ticket maps to exactly one team stream. Cap auto-apply at 1; only if the
  work genuinely spans two streams, SUGGEST the second for the Trio rather than applying it.
- **Uncertain → suggest, don't apply.** If none of the four clears a medium bar, emit
  `comp:uncertain` and suggest the closest one or two — never apply past the four.
- **Confidence + evidence.** Emit the chosen component with H/M/L and the signal that chose it
  (vault `ssx_component`, or the surface/stream). Apply on write-back only at high confidence.
- **Read, don't clobber.** If a human already set a non-policy component, leave it — merge, never
  replace. The skill only ADDS one of the four; it never removes a human's component.
- **Drift.** If the live set no longer contains one of the four, trust live, do not assign, and note
  the drift in the report's accuracy bounds.
