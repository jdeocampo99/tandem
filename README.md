# Tandem

Tandem helps you get coding work done with AI. You describe what you want and approve the plan;
Tandem organizes the coding, testing, review, context management, and worktree management. It remembers what’s finished, what’s still in progress, and what needs your input, so you can return later without starting over.

Tandem runs locally on macOS, using [Oh My Pi (OMP)](https://github.com/can1357/oh-my-pi)
for AI conversations.

## Before you start

From the Tandem folder on macOS, run the commands below. They use the official
[Bun](https://bun.com/docs/installation), [Herdr](https://herdr.dev/docs/install/),
[Treehouse](https://github.com/kunchenguid/treehouse), and [OMP](https://github.com/can1357/oh-my-pi)
installers. These scripts execute locally; inspect the linked instructions before running them.

```sh
# Bun
curl -fsSL https://bun.com/install | bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"

# Herdr and Treehouse
curl -fsSL https://herdr.dev/install.sh | sh
curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh

# OMP
bun install -g @oh-my-pi/pi-coding-agent

# Install Tandem's dependencies from this checkout
bun install
```

If `git` is missing, run `xcode-select --install` and wait for Apple's installer to finish
before continuing. Then follow the [global skill installation](docs/agent-reference.md#install-the-global-skills)
for the three Tandem skills.
Tandem uses your local tools and credentials; it is not a security sandbox.

## Use Tandem conversationally

In a fresh agent session, start with:

> How do I use Tandem?

Then ask for the action you want:

> Onboard `/path/to/repo`.
>
> What is the current state of my Tandem tasks?
>
> Launch Tandem for `/path/to/repo`.
>
> Add password reset to this app. Propose a plan first.

Use `tandem` for help, `tandem-onboard` to set up a project, and `tandem-status` for a short
progress summary. Status uses saved task information; it does not check whether AI assistants
are still running. You can also invoke `/skill:tandem`, `/skill:tandem-onboard`, or
`/skill:tandem-status` directly.
On your first project onboarding, Tandem recommends available models for planning, research, coding,
review, and final checks. After you approve, it saves your choices on this computer and reuses them
for later projects; say “Change Tandem models” any time to update them. A main-model change takes
effect on the next Tandem launch, not in an already-running conversation.

Launching Tandem opens a separate conversation for the project you choose. Asking about Tandem
in an ordinary chat does not start it. Settings and saved progress stay outside your project,
normally in `~/.tandem`.

For an approved task, a clear follow-up direction can be sent with the coordinator's `steer`
action without a redundant generic approval prompt; `steer` queues it for the next safe boundary.
Ask for `messages` when you need a queued, received, or delivered receipt, not as a repeated polling
loop. If the worker asks a decision, the coordinator relays its `Question:` and optional
`Recommendation:`, then sends your answer. A receipt is not proof that implementation is finished.
Before initial approval, its confirmation includes the current revision and effective communication
deltas, so queued scope is visible without replaying superseded messages or full JSON.

## What approval means

Tandem first inspects your project without changing it. Saving settings, starting Tandem,
approving a coding plan, publishing a pull request, merging, and deleting unfinished work each
need your approval. Research can start before you approve code changes; coding waits for your
approved plan, followed by checks and a separate review. Tandem never merges automatically.
Asking how it works does not give it permission to inspect files or take action.

## References

- [Agent/operator reference](docs/agent-reference.md) — CLI, installation, policy, lifecycle,
  storage, worktrees, delivery, presentation, recovery, and operational contracts.
- [`tandem` usage skill](skills/tandem/SKILL.md)
- [`tandem-onboard` skill](skills/tandem-onboard/SKILL.md)
- [`tandem-status` skill](skills/tandem-status/SKILL.md)
