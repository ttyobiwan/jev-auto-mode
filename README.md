# jev-auto-mode

An OpenCode V2 plugin for automatic permission evaluation with JEV from TypeSafe.

**Shift+Tab**, `/auto`, and the command palette's `auto` entry toggle auto mode.
The prompt status row displays `auto mode on` when enabled, including when the
sidebar is hidden. Auto mode starts on; the setting persists for the root session
and is shared by its descendants, independently of agent selection.

## Permissions

OpenCode evaluates its permission rules first. Explicit allows and denies remain
authoritative. When auto mode is on, edit asks are approved directly and JEV
judges other asks, including external-directory access. When auto mode is off,
asks go to the human. If JEV is unavailable, non-edit asks go to the human.

The key comes from `TYPESAFE_API_KEY` or `TYPESAFE_AI_API_KEY` at setup.
The toggle and automatic edit approval work without a key. Edit approval requires
one mode lookup, with no conversation read or model request.
The server keeps its `jev-arbiter`
ID to retain existing session modes and audit records in plugin storage.

JEV evaluates task relevance, data destruction, secret exposure, project data
transmission, and unauthorized remote or system changes. All harm safety scores must
reach 0.80 and relevance must reach 0.35 to allow. Uncertainty denies with guidance
to use a narrower or lower-risk action. Each non-edit ask is judged independently.
Denials label the estimated harm (or irrelevance) and its allowed percentage.
Harm requires evidence from the actual operation. A directory boundary, ordinary
source file, cache, or tool state is not itself evidence of secret exposure.
For external-directory asks, the judge uses the tool input and metadata to identify
the actual target; a boundary glob does not mean the tool accesses every matching file.
Necessary scoped installation and privileged diagnostics are judged by their effects.
Publication, messages, data loss, secret disclosure, and weakening safeguards still
require developer authorization. Audit records retain the existing
`irreversible_external_effect` identifier for the remote/system criterion.

The judge receives the project root, current session directory, and OpenCode's
temporary root (`opencode` under the resolved OS temporary directory) as trusted
host context. Creating local directories and review notes is reversible; loss of
existing data is judged separately. Temporary roots do not exempt destructive
operations, secret access, or remote writes from evaluation.

Requests use a 2.5-second per-attempt timeout with one SDK retry. Three consecutive
abstentions open the circuit for 60 seconds. JEV decisions are recorded under
`decision/` with context, environment, answers, model, reason, and latency. Audit writes are
best-effort; records are not pruned automatically.

Judgment requests send bounded, unredacted tool input, permission metadata,
user requests, compaction summary, recent calls, and stated intent to TypeSafe.
Context extraction is linear in message content. Mode lookup uses at most eight
session reads and one storage read. The indicator refreshes on session selection,
reconnection, and mode changes, with no polling or model request. Mode changes
affect subsequent permission evaluations.
Each judged ask adds one session read for its current directory, parallel with
the conversation read. Child asks also read the root conversation in parallel,
using the root ID already resolved for auto mode. Root asks do not add a read.
Temporary-root resolution uses one filesystem lookup at
plugin setup. The added context requires no additional model requests.

User context retains the initial request and up to nine recent requests in order,
within 4,000 characters total and 2,000 per request, including truncation markers.
Long requests retain their beginning and end. Later corrections take precedence;
necessary implementation and verification steps count as task-relevant. These
changes add no model requests and keep the user-context size bounded.
Context also retains recent public dialogue with explicit user and assistant
roles. It includes up to eight messages, 1,500 characters per message and 6,000
characters total. No reply or confirmation message is required.
Extraction remains linear in message content and adds no model requests.
Task-related local plans, checklists, and verification records count as supporting work.
Child judgments carry root requests separately from delegated instructions. Root
restrictions take precedence, and later root corrections apply to the next judgment.
Root context retains requests within the same 4,000-character budget and a summary
excerpt of about 2,000 characters, independently of the child context. Root assistant text,
tool calls, and synthetic messages do not become root requests. This adds at most
6,000 characters of root task context plus truncation markers per child judgment.

## Installation

Clone the repository and install dependencies with Bun:

```sh
git clone https://github.com/ttyobiwan/jev-auto-mode.git
cd jev-auto-mode
bun install --frozen-lockfile
```

## Configuration

Add the absolute path to the clone to `plugins` in `opencode.json`:

```json
{
  "plugins": ["/absolute/path/to/jev-auto-mode"]
}
```

Set the general `edit` permission to `ask` so auto mode controls edit approval;
keep protected-path deny rules after it. Explicit edit allows bypass auto mode.
In `cli.json`, disable the conflicting agent-cycle binding:

```json
"keybinds": { "agent.cycle": false }
```

The package's `./tui` export loads the prompt indicator and keyboard command.
Restart the TUI after changing the plugin entry. Agents remain available through
the command palette and `<leader>a`.

## Development

Run `bun install`, `bun test`, and `bun run typecheck`.
The suite covers permission evaluation, session modes, context extraction,
the keyboard binding, and terminal rendering of the prompt indicator.
Run `bun run test/temporary-files.eval.ts` with TypeSafe credentials for live
rubric checks. It sends synthetic tool descriptions to JEV and never executes
them. The cases cover temporary notes, worktrees, data loss, compound commands,
and remote writes; any unexpected verdict or unavailable response fails the run.
Run `bun run test/authentication.eval.ts` for live checks of authenticated
queries, secret disclosure, and unrequested uploads. These cases also send only
synthetic descriptions and never execute the described commands.
Run `bun run test/task-relevance.eval.ts` for task work without confirmation, local progress
records, unrelated checklists, and developer restrictions. It also uses only
synthetic descriptions.
Run `bun run test/permission-policy.eval.ts` for precise targets behind broad directory
boundaries, tool installation, root authorization, and destructive-action controls.
Run `bun run test/audit-replay.eval.ts <labeled-records.json>` to replay inspected audit
records. Supply an array of `{ "name": "case", "expected": "allow", "record": ... }`,
where `record` contains the stored `call`, `context`, and `environment`.
Label each expected verdict independently of the stored verdict. Replays send the
stored descriptions to TypeSafe and never execute the recorded operations.
The cutoffs were calibrated on 39 synthetic cases and seven inspected false-denial
records with JEV 1.13.0; the policy suite includes six additional validation cases.
This sample does not establish a production false-positive or false-negative rate.
