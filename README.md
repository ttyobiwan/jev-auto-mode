# jev-auto-mode

An OpenCode V2 plugin for automatic permission evaluation with JEV from TypeSafe.

**Shift+Tab**, `/auto`, and the command palette's `auto` entry toggle auto mode.
The prompt status row displays `auto mode on` when enabled, including when the
sidebar is hidden. Auto mode starts on; the setting persists for the root session
and is shared by its descendants, independently of agent selection.

## Installation

Add the repository to `plugins` in `opencode.json`:

```json
{
  "plugins": ["github:ttyobiwan/jev-auto-mode"]
}
```

Or install it with the CLI:

```sh
opencode plugin add github:ttyobiwan/jev-auto-mode
```

OpenCode installs the package and dependencies and loads its TUI automatically.
No manual clone or separate entry in `cli.json` is needed.

## Configuration

Set `TYPESAFE_API_KEY` or `TYPESAFE_AI_API_KEY` in the OpenCode server environment
for JEV evaluation. Without a key, auto mode approves edits only; other asks go
to the human.
Set the general `edit` permission to `ask` so auto mode controls edit approval;
keep protected-path deny rules after it. Explicit edit allows bypass auto mode.

### Keyboard shortcut

To use the default **Shift+Tab** shortcut for auto mode, disable the conflicting
agent-cycle binding in `~/.config/opencode/cli.json`:

```json
{
  "keybinds": { "agent.cycle": false }
}
```

To keep **Shift+Tab** for agent cycling, remap auto mode instead:

```json
{
  "keybinds": { "jev-auto-mode.auto": "<leader>j" }
}
```

`/auto` and the command palette's `auto` entry work without changing keybinds.
Agents remain available through the command palette and `<leader>a`.

## Permissions

OpenCode evaluates its permission rules first. Explicit allows and denies remain
authoritative. With auto mode on, the plugin approves edit requests directly and
JEV evaluates other permission requests, including external-directory access.
With auto mode off, requests go to the human. If JEV is unavailable, non-edit
requests go to the human.

JEV evaluates task relevance, data destruction, secret exposure, project data
transmission, and unauthorized remote or system changes. Each request is evaluated
independently. All harm safety scores must reach 0.80 and relevance must reach
0.35 to allow a request. An uncertain result denies the request with guidance to
choose a narrower or lower-risk action. Denials identify the estimated harm or
irrelevance and its allowed percentage.

Harm requires evidence from the operation. A directory boundary, source file,
cache, or tool state alone does not establish secret exposure. For external-directory
requests, JEV uses tool input and metadata to identify the target; a boundary glob
does not mean the tool accesses every matching file. Necessary scoped installation
and privileged diagnostics are judged by their effects. Publication, messages,
data loss, secret disclosure, and weakening safeguards require developer authorization.

JEV receives the project root, current session directory, and OpenCode's temporary
root (`opencode` under the resolved OS temporary directory) as trusted host context.
Creating local directories and review notes is reversible; loss of existing data
is judged separately. Temporary roots do not exempt destructive operations,
secret access, or remote writes from evaluation.

### Data sent and stored

Judgment requests send bounded, unredacted tool input, permission metadata,
user requests, compaction summary, recent calls, and stated intent to TypeSafe.

The plugin records decisions under `decision/` in plugin storage, including context,
environment, answers, model, reason, and latency. Audit writes are best-effort;
records are not pruned automatically. The remote/system criterion
retains its `irreversible_external_effect` identifier in audit records.

### Context and task authority

User context retains the initial request and up to nine recent requests in order,
within 4,000 characters total and 2,000 per request, including truncation markers.
Long requests retain their beginning and end. Later corrections take precedence.
Necessary implementation, verification, local plans, and progress records count
as task-related work; no user confirmation message is required.

Context also retains up to eight recent public messages with explicit user and
assistant roles, within 1,500 characters per message and 6,000 characters total.

Child judgments carry root requests separately from delegated instructions.
Root restrictions take precedence, and later root corrections apply to the next
judgment. Root context has a separate 4,000-character request budget and a summary
excerpt of about 2,000 characters. Root assistant text, tool calls, and synthetic
messages do not become root requests. This adds at most 6,000 characters of root
task context plus truncation markers per child judgment.

### Latency and failure handling

Requests use a 2.5-second timeout per attempt with one SDK retry. After three
consecutive requests without a judgment, the plugin pauses JEV requests for
60 seconds and sends non-edit permission requests to the human.

Edit approval requires one mode lookup, with no conversation read or model request.
Mode lookup uses at most eight session reads and one storage read. Each JEV
evaluation reads the current session directory and conversation in parallel.
Child requests also read the root conversation in parallel, using the root ID
already resolved for auto mode.

Context extraction is linear in message content. Temporary-root resolution uses
one filesystem lookup at setup. The indicator refreshes on session selection,
reconnection, and mode changes, with no polling or model request. Mode changes
affect subsequent permission evaluations.

## Development

Clone the repository and install dependencies with Bun:

```sh
git clone https://github.com/ttyobiwan/jev-auto-mode.git
cd jev-auto-mode
bun install --frozen-lockfile
```

For local development, use the absolute path to the clone in `plugins` instead
of the GitHub entry, for example `"/absolute/path/to/jev-auto-mode"`.
Restart the TUI after changing the plugin entry.

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
