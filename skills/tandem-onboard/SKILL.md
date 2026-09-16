---
name: tandem-onboard
description: >-
  Guide a user through safe, conversational onboarding of one or more Git repositories into
  Tandem. Trigger when the user asks to onboard a repository or invokes /skill:tandem-onboard.
user-invocable: true
---

# tandem-onboard

Use this as a concise capability reference. Onboarding is read-only; approved global model and project
setting writes and a later launch are separate actions.

## 1. Resolve Tandem without guessing

Locate the Tandem checkout independently of every target repository. Use `TANDEM_ROOT` when
supplied and validate it. Otherwise resolve the real location of this shipped skill and ascend
two levels (`../../`) to its Tandem root. If neither is available, use an explicitly supplied
installation location or existing installation metadata; if that is unavailable, ask where
Tandem is installed. Never hardcode a machine-specific path, fall back to `Coding_Projects` or
another project-folder convention, or invent a global `tandem` executable. Use absolute paths
thereafter and do not run package scripts while locating the checkout.

## 2. Use the CLI for discovery, model setup, approval, and readiness

Resolve Tandem's local home separately: `--home` wins, then `TANDEM_HOME`, then `~/.tandem`.
Use the same home for each command. It owns model preferences, policy records, and durable state;
target repositories are not written and need not check Tandem configuration into Git. Keep `configPath`,
and the exact proposal in structured state; expose them only on request or when needed to resolve
project ambiguity. For the project-setting step, after any required first-time model choice, ask only when
`existingConfig` is false:

> Save Tandem settings for `<project>`? These settings are saved on this computer, outside the project. They do not change the app or start work.
>
> Choose **Save settings** or **Not now**.

Keep default worker/fix limits, script identifiers, hash paths, raw commands, and JSON in structured
details; share them only on request or when the user must choose meaningful custom settings. Capture
each JSON result and project `repoPath`, `modelSettings`, `configPath`, `existingConfig`,
`validationCommands`, and `unresolved` before presenting or acting; retain full details without
dumping raw payloads, repeating discovery, or hiding CLI failures.

```sh
set -o pipefail
bun "<tandem-root>/src/cli.ts" --help
bun "<tandem-root>/src/cli.ts" onboard --repo "<canonical-repo>" --home "<home>" --json |
  jq '{
    repoPath,
    existingConfig,
    modelSettings,
    configPath,
    validationCommands,
    unresolved
  }'
bun "<tandem-root>/src/cli.ts" models --repo "<canonical-repo>" --home "<home>" --json |
  jq '{
    modelSettings,
    availableModels: ((.availableModels // []) | map({
      selector, id, provider, thinking, name, reasoning, contextWindow, cost
    }))
  }'
bun "<tandem-root>/src/cli.ts" configure-models --repo "<canonical-repo>" --home "<home>" --input "<selection-file-outside-project>" --yes
bun "<tandem-root>/src/cli.ts" setup --repo "<canonical-repo>" --home "<home>" --yes
bun "<tandem-root>/src/cli.ts" doctor --repo "<canonical-repo>" --home "<home>"
bun "<tandem-root>/src/cli.ts" launch --repo "<canonical-repo>" --home "<home>"
```

`onboard` discovers package validation surfaces and returns `modelSettings` without writing. If
`modelSettings.configured` is false, run `models` once and project its catalogue to compact choices
using returned selectors, ids, providers, thinking, and optional names, reasoning, context windows,
or cost. Recommend a strong planning model, a cheaper/faster research model, and capable
coding/review/final-check choices, covering all six roles as planning, research, coding, review, final
checks, and presentations. Briefly explain the rationale, let the user use, adjust, or decline, and
never invent model names, promise pricing or latency, parse private config, or silently substitute.
Explain that approved choices apply to future work across projects and do not start work.

After explicit approval, write the complete global choices once with `configure-models`, using a
temporary selection JSON outside the target project and removing it afterward. If `existingConfig` is
true, preserve the existing project settings and skip `setup`; a first-time global model choice may
still be needed. Otherwise, continue with normal project setup, then separately requested launch.
Reuse saved choices for later projects; only re-run selection when the user explicitly asks to change
Tandem models. Changing the main conversation model takes effect on the next Tandem launch, not as a
hot swap of an already-running OMP conversation. Empty or failed discovery stays visible and requires
asking, not fallback.

## 3. Resolve only the repositories the user supplied

For explicit paths, expand `~`, resolve relative paths against the current workspace, and obtain
the canonical Git top-level root. For names, consider supplied paths, workspace roots and
additional directories, workspace configuration, known project indexes, and known central
registrations under `<home>/repositories/*/config.json` (their validated `repoPath` values).
Do not crawl the home directory, clone, or use Tandem's installation as a project registry. The
first basename match is not proof; ask when no confident root or multiple plausible roots remain.

Verify real Git-backed directories, represent nested paths and symlink aliases by canonical root,
and deduplicate aliases. Keep policy records in Tandem home, but keep package, guidance, and
repository-relative `instructionFiles` reads rooted in the target repository. Approval for one
canonical root never applies to another.
