# Wire Team Bot — Goals and Principles

This document is the product statement for the bot. `AGENTS.md` and the plan documents describe
*how* it is built; this one describes *what it is for* and the principles any change must respect.
When a proposal conflicts with this page, the proposal changes, or this page is updated first.

## Purpose

An **administrative assistant for a team, aligned to a Wire group.** It joins the group, keeps
listening and learning, and takes the admin load off the people in it: tracking decisions, actions
and their progress, remembering what was agreed, and answering questions about the team's own
history. Its measure of success is that the team spends less time on administration and loses
fewer decisions and commitments, not that it produces more messages.

## Principles

1. **Material facts, never raw text.** The bot captures decisions, actions, people, projects and
   signals as structured records. It never persists message content. Vectors derived from text are
   kept; the text is discarded. This is the privacy contract with the team and it is not
   negotiable for a feature.

2. **Natural language is the interface.** People talk to the bot the way they talk to a colleague.
   There is no command syntax to learn, no prefixes, no identifiers to quote back, and no regex
   deciding what a sentence means. Whether a message is addressed to the bot is decided by context:
   an @mention or its name is an explicit address; in a one-to-one with the bot every message is
   addressed to it; in a group the bot may also treat a reply to its own question as addressed to
   it. *Open question:* in a group, should an untagged message ever be treated as directed at the
   bot beyond the follow-up case, or does that conflict with quiet listening?

3. **The bot has a name, not a hardcoded identity.** "Jeeves" is the default persona. The name is
   configuration (`BOT_NAME`) and the display name in Wire is set in Wire. Nothing in the code
   should assume a particular name.

4. **The LLM is pluggable, and the destination is air-gapped.** Every model call goes through one
   provider-neutral interface. The production target is a self-hosted, offline deployment with
   local models. Claude is the high-quality model used during development because it shortens the
   loop, not an assumption the product depends on. Any feature must work with a local
   OpenAI-compatible model; if it is materially better on Claude, that is a quality note, not a
   requirement. Where a provider lacks a capability (embeddings, strict JSON), the bot degrades
   gracefully and says so once at startup.

5. **Quiet by default.** The bot listens far more than it speaks. It speaks when addressed, when
   it has captured something the team would want acknowledged, or when a commitment is at risk.
   It does not narrate its own processing.

6. **End-to-end encryption is respected, never worked around.** The bot is a Wire application
   with its own identity and keystore. It does not log message content or user identifiers, and
   it does not weaken any Wire security invariant to make a feature easier.

## What the team should be able to rely on

Grouped by what the team experiences, not by component.

**Capture**
- Decisions, with who decided and when, taken from conversation as it happens or when stated
  directly to the bot.
- Actions, with an owner and a deadline where one was given.
- Reminders, for a person or the group.
- Standing context about the team: people, projects, terminology, standing decisions, whether
  learned from the channel or seeded by an operator.

**Recall**
- Answer questions about the team's own history in plain language, citing what was decided and
  when, without exposing internal identifiers.
- Lists on request: my actions, the team's actions, overdue items, open reminders, recent decisions.
- "Catch me up": what happened while I was away.
- Periodic summaries of what moved.

**Progress and administration**
- Track an action from open to done, including when the team says it's done in passing.
- Notice when something is stuck or overdue and nudge the owner without nagging.
- Keep decisions consistent: when a later decision contradicts an earlier one, reconcile them
  rather than asking an unanswered question.
- Let people correct the record in plain language: "that was Sarah's, not Mike's".

**Control**
- Pause, resume, and a secure mode in which nothing is captured. State survives restarts.
- A channel purpose and context the team sets once so the bot understands what it is listening to.

## How we use this page

- Feature proposals are written against the "rely on" list above: which line do they strengthen,
  and which principle do they touch.
- The `v3.0` branch is evaluated against this page, not the other way round. Parts of it that
  serve principle 2 (natural-language routing), principle 4 (schema-validated, provider-neutral
  model output) and the *Progress* section (deduplication, durable reminders) are aligned. Parts
  that add operational weight without a line in the "rely on" list need a case made first.
