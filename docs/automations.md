# Automations

Saved instructions that run on a schedule, unattended, on their owner's computer, with that person's engine, model, credentials and connectors. Each run is posted in a chat as one of the owner's turns, and lands in the owner's **Automations** inbox to review.

## Using automations

**Automations** in the sidebar shows them; its badge counts finished runs you haven't opened. A chat that automations post in shows a clock button in its header with how many there are.

**New automation** opens the editor:

| Field | What it decides |
| --- | --- |
| Name, Instructions | The instructions are the message each run sends, as typed in the composer: start with a `/command`, or mention a `$skill` for Codex, to use them. Say what to report: nobody can answer the agent while it runs. |
| Where it runs | **A chat of its own** (the default): a private chat named after the automation, working in a folder you pick or a new one in your private chats folder. **An existing chat** you are a member of: each run appears there for everyone in the chat. |
| When | Every few minutes or hours, every day at a time, weekdays, some days of the week, or a custom cron expression. The editor shows the next three runs. |
| Model | A model profile of this computer, an optional model and the reasoning effort, as in the composer. |
| Permissions | **Read-only** (the default), **Edit files** or **No restrictions**; see [Unattended runs](#unattended-runs). |
| Time limit | How long a run may take, 20 minutes by default and up to 4 hours. |
| Runs on | Which of your connected computers runs it, when you have more than one. |
| Start a new agent session on each run | On by default for a chat of its own: each run starts from its instructions alone. Off, a run continues the chat's agent session on your computer with everything said before, as your own messages do. |
| Runs on its schedule | Off pauses it: it then only runs with **Run now**. |

Each automation in the list shows its schedule, chat, instructions, computer, model, permission level, next run and last run. Its owner can **Run now**, pause it with the switch, edit it and delete it (what it posted stays in the chat); **History** lists its last runs with their status, scheduled time, start, duration and a link to the result.

The **Inbox** tab lists your finished runs until you open them, newest first (**Only not seen** off shows them all, including missed and skipped times). Opening a run, or the chat it posted in, marks it seen. When a run finishes, fails or is cut short, the computer that ran it shows a notification (a message inside CooPrompt when it is in front); clicking it opens the chat at that run.

In the chat, a run is labeled **Automation: \<name\>**, with its owner and its instructions, followed by the agent's work like any turn.

## Schedules

- **Every N minutes or hours** counts from when the interval was chosen: every 2 hours, chosen at 10:17, runs at 12:17, 14:17 and so on.
- **Every day**, **weekdays** and **some days of the week** run at a time of day.
- **Custom** takes a five-field cron expression: minute, hour, day of the month, month and day of the week, with ranges (`1-5`), steps (`*/15`), lists (`1,15`), names (`MON`, `JAN`) and the macros `@hourly`, `@daily`, `@weekly`, `@monthly` and `@yearly`. When both day fields are restricted, a day matching either one runs, as in cron.
- Times of day are wall-clock times in the time zone of the computer that saved the automation, kept across daylight saving changes: a time the clocks skip runs right after the jump, and one they repeat runs the first time.
- Runs are at least 15 minutes apart; the server refuses schedules that run more often.

The schedule logic is `nextRun` and `scheduleError` in [`packages/protocol/src/automations.ts`](../packages/protocol/src/automations.ts), shared by the server and the editor's preview.

## Unattended runs

Nobody can answer a run while it works, so requests that would wait for someone are declined at once: permission requests show as **Declined automatically** and questions as not asked. The agent is told that it runs unattended, to work with what its permissions allow and to end with a short report. The permission level decides what it can do without asking:

| Level | Permission mode | What it means |
| --- | --- | --- |
| Read-only | `plan` ("Plan only") | It reads and reports. Actions you always allowed in that chat are declined too. |
| Edit files | `acceptEdits` ("Accept edits") | It edits files in its folder; other actions that need approval are declined, except those you always allowed in that chat. Codex also uses connector tools without asking, as in any Codex turn outside Plan mode. |
| No restrictions | `bypassPermissions` | It runs commands, edits files and uses connectors without asking, with your credentials. |

What each mode means for each engine is in [Permission modes](multiplayer.md#permission-modes). Everyone who sees an automation sees its level.

## When your computer is asleep or CooPrompt is closed

The team server keeps the schedule, so it knows what didn't run even when every app was closed.

- When a scheduled time comes and the computer that runs the automation isn't connected (asleep, offline, CooPrompt quit), the run is recorded as **missed**. A computer whose CooPrompt predates automations counts as not connected.
- When that computer connects again, the latest missed run runs once, marked **caught up**, if less than half the time to the next scheduled run has passed. Otherwise it waits for the next run. However many times were missed, at most one catch-up runs.
- Times that passed while the team server itself wasn't running (an embedded server whose computer slept, for example) count the same way, and only the latest one counts.
- An automation never runs twice at once: a time that comes while its previous run is waiting or running is **skipped**.
- A run still going at its time limit is stopped (**cut short**); one that couldn't start for that long because the chat was full is skipped.

## Sharing a chat with people

A run is a turn of its owner, sent in [multitask](multiplayer.md#multitask) mode when the server and the computer support it: it starts right away beside the turns already running and never waits behind someone's long turn. While it runs, messages sent without multitask in that chat wait for it, as they do for any turn; the time limit bounds how long. On a server with multitask turned off, runs wait in the queue like messages.

## Who sees and does what

- Only its owner edits, runs, pauses or deletes an automation; the server enforces it.
- Members of the chat an automation posts in see it under **Others' in your chats**: its name, owner, schedule, instructions, permission level, computer, next and last run and its history. They see its runs in the chat like any turn, and the chat owner can stop a run as any turn.
- Runs only happen on the owner's chosen computer, with that computer's model profile (or its default profile for the same engine), credentials and connectors, like the owner's own messages: the server sends the turn to that device only.
- An automation pauses itself when its chat is deleted or its owner leaves the chat, and says so in the list.

## Older apps and servers

- With a team server that predates automations, the Automations view says the server needs updating.
- Clients that do not announce automation support cannot run automations: such a device counts as not connected for scheduling.

## How it works

| Piece | Where |
| --- | --- |
| Wire types (`AutomationInfo`, `AutomationRun`, `TurnAutomation`), schedules and cron | [`packages/protocol/src/automations.ts`](../packages/protocol/src/automations.ts) |
| Storage, the scheduler (due runs, missed runs and catch-ups, overlap, time limits) and what members are told | [`apps/server/src/automations.ts`](../apps/server/src/automations.ts) |
| Endpoints, validation and ownership | [`apps/server/src/automation-routes.ts`](../apps/server/src/automation-routes.ts); listed in [Team server](server.md#automations) |
| Declining approvals and questions, the note to the agent, a new session per run | `requestPermission`, `askQuestion` and `execute` in [`runner.ts`](../apps/desktop/src/main/runner/runner.ts), `automationNote` in [`context.ts`](../apps/desktop/src/main/runner/context.ts) |
| IPC methods, the automation's own chat, notifications | [`apps/desktop/src/main/automations.ts`](../apps/desktop/src/main/automations.ts) |
| The view, the editor, the sidebar entry and the transcript label | [`components/automations/`](../apps/desktop/src/renderer/src/components/automations) |

A run starts as follows: the scheduler finds an automation due, checks that its chat and owner still qualify, that no run of it is active and that the owner's computer is connected with `automations` among the features its `hello` announced; it then stores the instructions as the owner's prompt with a label line, creates the turn with `automation` set (and `parallel` when the computer runs multitask turns), and schedules the chat. From there the turn flows as any other ([Architecture](architecture.md#how-a-turn-flows)); the scheduler follows its status into the run's record and tells the owner. The reasons for this design are in [Decisions](decisions.md#29-automations-are-scheduled-by-the-team-server-and-run-as-their-owners-turns).
