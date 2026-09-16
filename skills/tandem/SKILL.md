---
name: tandem
description: >-
  Explain how to use Tandem in plain language, including the difference between a normal agent
  conversation and a separately requested managed coordinator. Trigger for how-to questions or
  /skill:tandem.
user-invocable: true
---

# tandem

Use this as a short, conversational guide. Explain first; a how-to question is not approval to
inspect a repository, find an installation, onboard, launch, edit, test, publish, or merge.

## What Tandem is

Tandem helps you get coding work done with AI. You describe what you want and approve the plan;
Tandem organizes the coding, testing, and review. It remembers what’s finished, what’s still in
progress, and what needs your input, so you can return later without starting over.

An ordinary agent session is just the current conversation. It can explain or research when
asked, but it does not become Tandem because someone mentioned it. A managed coordinator is a
separate Tandem launch that the user has specifically requested.

Each project gets its own coordinator conversation. Tandem keeps its settings and progress in
a local home (normally `~/.tandem`, or a home the user selects), not in the project itself.

## The usual path

1. **Get oriented** — read-only onboarding checks the project and suggests settings. On first
   onboarding, Tandem recommends available models for planning, research, coding, review, and final
   checks; after you approve, it saves those choices on this computer for reuse across projects. Ask
   to “change Tandem models” later to update them; a main-model change takes effect on the next
   Tandem launch, not in an already-running conversation. For an onboarding request, delegate to
   `tandem-onboard`; for a current-state request, delegate to `tandem-status`. Onboarding approval
   does not approve code changes or launch.
2. **Launch** — only after a separate request, start the Tandem-managed coordinator.
3. **Agree on the work** — record what should change, how success will be recognized, and which
   part of the project is involved. Research may start automatically; coding waits for approval.
4. **Code, test, and review** — a worker makes the approved change, Tandem runs the configured
   checks, and a fresh reviewer examines the same change.
5. **Deliver deliberately** — publishing, merging, or destructive cleanup each needs its own
   explicit approval. Tandem never merges automatically.

## Continue an approved task

For a clear follow-up within the approved scope, tell the coordinator the concise delta; it can
forward it with `steer` without a redundant generic approval prompt. `steer` returns queued for
the next safe boundary, so the coordinator should batch independent directions in order and
explicitly supersede obsolete ones. Use `messages` only when you ask for a receipt or before a
dependent decision, never in a repeated model-driven polling loop. Queued/received/delivered are
not completion. If a worker asks a decision, the coordinator relays its `Question:` and optional
`Recommendation:`, sends your answer with the current question id, and checks the receipt when
needed.

Directions sent before initial approval remain visible at the approval boundary: confirmation shows
the current communication revision and every effective, non-superseded communication delta
(including answers that carry implementation direction), without replaying superseded messages or
full communication JSON.

Routine heartbeats, receipts, and passive progress are durable/UI activity, not model turns. A
PR-ready coordinator notice may wake the coordinator for delivery decisions, while elapsed time
alone does not kill a worker; explicit worker limits, cancellation, and existing approval/merge
safeguards still apply.

## Starter requests

- “How do I use Tandem?” — explain this path in plain language without looking at the filesystem.
- “Onboard `/path/to/repo`.” — use `tandem-onboard` (or `/skill:tandem-onboard`).
- “What is the current state of my Tandem tasks?” — use `tandem-status` (or
  `/skill:tandem-status`).
- “Launch Tandem for `/path/to/repo`.” — after the explicit request, discover the target and
  installation, then follow the launch workflow.

When execution is requested, resolve a validated `TANDEM_ROOT` or the real shipped skill path
and ascend two levels (`../../`) to Tandem's root. Use `docs/agent-reference.md`'s launch section or run
`bun "<TANDEM_ROOT>/src/cli.ts" --help`; never invent a global `tandem` binary. Do not resolve
these paths for explanation-only questions.
