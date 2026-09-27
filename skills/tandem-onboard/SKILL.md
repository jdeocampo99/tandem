---
name: tandem-onboard
description: >-
  Walk a user through adding one or more Git repositories to Tandem, in plain English. Trigger when
  the user asks to onboard or set up a repository for Tandem, or invokes /skill:tandem-onboard.
user-invocable: true
---

# tandem-onboard

Onboarding looks at a project and proposes settings without changing anything. Saving model
choices, saving project settings, turning on merging, and launching are separate steps, each needing
its own yes.

## Talk like a teammate

- Say what each step does for the user before asking: "This saves Tandem's settings for `app` on
  this computer. It doesn't change your code or start any work."
- Use the role names **Planning**, **Research**, **Coding**, **Review**, and **Presentations**.
  Show model names exactly as the catalogue lists them, since the user may need to type them.
- Keep file paths, JSON, and internal limits out of the reply unless the user asks or must choose.
- End each step with a clear choice, such as **Save settings** or **Not now**.

## 1. Find Tandem and the project

Use the installed `tandem` command. For exact JSON, use `bun "<tandem-root>/src/cli.ts"`, where
`<tandem-root>` is a validated `TANDEM_ROOT` or this skill's real path plus `../../`. If neither
works, ask the user where Tandem is installed; use only a location they give you.

Tandem's data folder ("home") is, in order: `--home`, `TANDEM_HOME`, the `home` in
`$XDG_CONFIG_HOME/tandem/config.json` (default `~/.config/tandem/config.json`), then `~/.tandem`.
Use the same home for every command, and leave that remembered file as it is.

Resolve each project to its canonical Git top-level path: expand `~`, resolve relative paths, and
collapse symlinks and nested paths to one root. For a project named rather than pathed, look in
paths the user gave, workspace roots, and saved projects under `<home>/repositories/*/settings.toml`
(or older `config.json`). Ask when no single root is clearly right. Approval for one project never
covers another.

## 2. Inspect the project

```sh
set -o pipefail
bun "<tandem-root>/src/cli.ts" onboard --repo "<repo>" --home "<home>" --json |
  jq '{repoPath, existingConfig, modelSettings, configPath, validationCommands, setupCommands, unresolved, merging}'
```
This writes nothing. Tell the user, in a sentence or two, what Tandem found: the checks it would run
(`validationCommands`), the install step for fresh copies (`setupCommands`), and anything
`unresolved` that needs their input. Show errors as they are; don't retry.

## 3. Choose models (skip when `modelSettings.configured` is true and the user keeps them)

Model choices apply to every project and take effect on the next launch.

**First time** (`modelSettings.configured` is false): run the catalogue once.

```sh
bun "<tandem-root>/src/cli.ts" models --repo "<repo>" --home "<home>" --json |
  jq '{modelSettings, availableModels: ((.availableModels // []) | map({selector, provider, thinking, name, cost}))}'
```

For each of the five roles, suggest a model from that catalogue and the thinking levels it supports,
with one line on why. The user must pick or accept a model and thinking level for every role; one
reply may cover all five. Each role needs its own explicit answer, so an unanswered role is asked
again rather than filled in. Offer **Not now**, which ends onboarding with nothing saved.

**Already chosen**: show the five saved choices and offer **Keep all** (save nothing, continue),
**Change roles** (rerun the catalogue and ask role by role; unchanged roles keep their value), or
**Not now** (stop, nothing saved).

Before saving, show all five roles in one recap. After the user approves it, save with
`bun "<tandem-root>/src/cli.ts" configure-models --repo "<repo>" --home "<home>" --input <file> --yes`,
using a temporary JSON file outside the project that you delete afterward. (Users who prefer to
choose in the terminal can run `tandem configure <repo>` instead.) Suggest only models from the
catalogue.

## 4. Save project settings (skip when `existingConfig` is true)

Ask:

> Save Tandem settings for `<project>`? They're kept on this computer, outside the project, and
> don't change the app or start work.
>
> **Save settings** or **Not now**

On yes: `bun "<tandem-root>/src/cli.ts" setup --repo "<repo>" --home "<home>" --yes`. The user can
edit these later with `tandem config <repo>`.

## 5. Merging (optional)

PR watch keeps the user's pull requests moving; merging them is off until they say how this repo
merges. Use `merging` from step 2 (run step 2 again if settings were just saved).

- `merging.readable` is false: pass on `merging.message` in one sentence and skip this step.
- `merging.method` is `aviator` or `auto-merge`: ask, in one or two sentences, for example:

  > This repo merges through Aviator. Tandem can queue your PRs and retry flaky CI.
  >
  > **Turn on** or **Not now**

  (For `auto-merge`: "This repo allows GitHub auto-merge.") If `merging.warnings` has anything,
  add it in one plain sentence.
- `merging.method` is `unknown`: ask `merging.question`, the one question about which label queues
  a pull request or whether to use GitHub auto-merge.

Never ask about retries, how long CI may take, or any other setting; their defaults stay.

Save the answer as a JSON file outside the project that you delete afterward: **Turn on** saves
`merging.proposal`; a label they name saves `{"mergeWith": "queue-label", "queueLabel": "<label>"}`;
auto-merge saves `{"mergeWith": "auto-merge"}`; **Not now** saves `{"mergeWith": "off"}`, so they
are not asked again. Then run
`bun "<tandem-root>/src/cli.ts" configure-merging --repo "<repo>" --home "<home>" --input <file> --yes`.
If it says this project already says how it merges, move on.


## 6. Launch (only when asked)

Onboarding is done. Tell the user they can start Tandem with `tandem <repo>`, and run it only when
they ask. A launch opens a Herdr window with that project's coordinator, where they describe what
they want built.
