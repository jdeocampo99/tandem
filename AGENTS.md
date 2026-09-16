# Tandem agent guidance

Read [README.md](README.md) for the user-facing overview and the
[agent reference](docs/agent-reference.md) for installation, CLI commands, configuration, and operational contracts.

## Workflow

- Tandem is a local, OMP-first agent distro. Keep the lifecycle core small and durable; put policy, prompts, and configuration at its boundary.
- Use command-based adapters for Treehouse, Herdr, OMP, Lavish, and GitHub. The coordinating service and CLI own orchestration; the OMP extension owns OMP integration.
- Main conversation orchestration is authoritative. Scout and reviewer/implementer workers use isolated workspaces as configured by the runtime. Reviewers are fresh OMP instances or panes in the task worktree, and the writer is paused during review.
- Research is automatic; implementation requires approved scope. Merge, deploy, and destructive actions require specific human approval. Never merge automatically.
- Preserve reports and unmerged work. Do not create remote fleets, other harness integrations, terminal backends, or social relays.
- Child workers must not run tests, builds, formatters, linters, or other project-wide gates. Put tests in `tests/`; the parent workflow runs validation once after changes land.
- Keep implementation, validation, and review instruction channels appendable and preserve source references. Pin the resolved policy on each task.
- Use OMP-native compaction together with a durable digest. Keep default worker/fix limits from policy; do not silently broaden them.

## Parent-owned toolchain

- `bun run check` runs `tsc --noEmit`.
- `bun run test` runs `bun test`.
- `bun run lint` runs `biome check`.
- `bun run format` runs `biome format --write`.
- `bun run start` launches `bun src/cli.ts`.
- Only the parent workflow runs these gates after child work lands; child workers must not run them.

## Code standards

- TypeScript is strict and Bun is the runtime. Keep source-of-truth public types in `src/contracts.ts`.
- Prefer honest dependencies: pass clocks, ID factories, command runners, adapters, and policy explicitly. Do not hide shell, filesystem, process, or session state behind globals.
- Prefer empathic signatures: group coherent arguments in named records, use precise names and units, and make optional fields represent a real lifecycle state only.
- Keep each abstraction layer cohesive. Separate pure lifecycle and policy decisions from effectful command and workspace adapters.
- Keep declarations reader-oriented: public contracts first, supporting types next, then implementations and effect boundaries.
- Keep comments only when they explain a non-obvious invariant, external constraint, or edge-case rationale. Prefer clear names and structure over narration.
- Do not add `any`, stubs, placeholder fallbacks, no-op implementations, suppressions, or compatibility aliases. Remove obsolete paths during a clean cutover.
- Keep changes focused, preserve observable behavior, and update every caller when a contract changes.
