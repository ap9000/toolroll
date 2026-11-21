# Quarantined Git Objects as the Canonical Candidate Transport

Proposed code changes submitted from a Local Checkout (Candidates) will standardize on quarantined Git bundles/objects as the canonical transport format rather than unified `.patch` diffs. Unified `.patch` uploads remain only a temporary text-only MVP stepping stone while Git-object quarantine and validation are built out.

## Considered Options

- **Standardize permanently on unified `.patch` diffs**: Simpler server-side secret scanning and `git apply --check` validation, but loses binary assets, exact tree/commit fidelity, rename metadata, and clean three-way merging when the central Task branch advances.
- **Direct `git push` into the central repository**: Familiar to developers, but mixes untrusted external objects directly into the authoritative repository before validation and bypasses Candidate quarantine and Promotion boundaries.

## Consequences

- Submitting a Candidate must quarantine incoming Git objects outside the authoritative repository, validate safety/secret/size bounds, and require explicit Promotion into a central Run before any code enters verified history.
- Current `.patch`-based Candidate endpoints (`cand-*`) are explicitly interim and will be superseded or bridged once Git-object Candidate transfer lands.
