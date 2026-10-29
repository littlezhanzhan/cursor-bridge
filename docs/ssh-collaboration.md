# Existing IDE Agents and SSH collaboration — 6.0.9-ssh.7

For an explicitly selected existing local or SSH IDE conversation, see
[existing Agent attachment](existing-agent-attachment.md). Attachment sends no
message and does not create a conversation or open another window. Unknown
historical Agents receive read-only Bridge access; native Cursor permissions
are not changed. This is separate from the new-Agent write policy below.

## New Agent read/write capability

Starting with `6.0.9-ssh.6`, newly created SSH Agents support user-authorized
read/write tasks. No historical session is migrated or upgraded. A saved
historical read-only Agent still defaults to read-only and rejects an explicit
write request. Use `new_session:true` on a named connection, or omit `session_id`
on `cursor_ssh_session`, to create a new write-capable Agent.

`read_only:true` makes the current task observational. It does not remove a new
Agent's ability to perform a later write task. With no flag, a new Agent defaults
to read/write; a continuation inherits the existing Agent's capability. Session
metadata exposes `writeEnabled`; task status exposes the current `readOnly`.

As requested for this preview, SSH writing does not require `allowed_paths`,
and no SSH filesystem scope or file-write conflict scheduling is introduced.
Agent execution can overlap, while the existing UI lock, exact identity checks,
single-session busy gate and result routing remain active. Do not describe UI
coordination as protection from concurrent edits to the same file. Existing
local-task `allowed_paths` behavior is unchanged.

Only perform writes authorized by the user's task. Necessary acceptance for
deployment, deletion, permissions and production configuration remains with
the primary agent. This is not an OS filesystem sandbox or a privilege change.

The internal `ssh-read-only` discovery tag is retained for old-adapter
compatibility; effective capability comes from the new-session write flag.
The flag is absent on historical read-only records and is never added to them.

## Caller isolation and concurrent read-only execution

Named connections share the exact SSH target, not an Agent by default.
`cursor_connection_send` now defaults to `session_scope:"caller"`: each Codex
thread gets an independent dedicated Agent, and only that thread resumes it.
The stable identity comes from the host's MCP `_meta.threadId`, falling back to
`CODEX_THREAD_ID`. If neither is available, each adapter instance remains
isolated but cannot promise persistence across restart. The current identity
and its source are exposed in status and connection metadata.

The existing user-level shared session is retained without automatic migration.
Use `session_scope:"shared"` only when the user explicitly asks to share that
Agent, or supply an exact `session_id` for an explicit handoff. `new_session:true`
creates a new Agent only in the selected scope. Caller mappings are stored in
`caller-connections-v1.json`; the original `connections-v1.json` is preserved.

Different SSH read-only sessions may now run concurrently, including across
MCP processes. One session still admits only one active turn. A process-shared
UI lock serializes creation, selection, input and extraction while background
Agents run independently. Target, composer, session epoch and per-turn reply
checks remain in place. Task IDs contain UUIDs and retained results belong to
their caller/adapter; this is polling by exact task ID, not a cross-chat webhook.
Task results are still process-local. After a restart, recover via the exact
persistent session instead of querying a foreign process's task ID.

Active older senders and uncertain unbound sessions still block new admission.
Owner death is rechecked inside the UI critical section before a queued task
may submit. A live UI-lock owner is never displaced by age. A dead owner can
be recovered; an ownerless/incomplete lock fails closed for inspection.
These locks coordinate Bridge processes on one OS host and local filesystem;
they do not lock a person's mouse/keyboard or provide filesystem write isolation.
The `6.0.9-ssh.5` release supported only SSH read-only tasks; new Agent write
capability is described above. Local parallel writable scopes retain their
existing process-local path-overlap limits; cross-process writable isolation is
not claimed by this SSH release.

`6.0.9-ssh.4` distinguishes CDP enumeration, missing pinned targets, unreadable
window identity, UI classification and actual workspace mismatches. Failures
include structured `sshDiagnostic` evidence; a failed
probe is no longer reported as a missing workspace. Modern prompt CSS alone
does not identify Agents v2. Classic unified services and visible structural
evidence classify the page, with conflicting evidence rejected as unknown.
The exact SSH authority, case-sensitive folder and composer checks still apply.
New Agent controls must also pass a foreground hit test. A known transient
menu may be dismissed once with Escape, followed by a fresh hit test; ordinary
dialogs, ambiguous controls and other blockers cannot authorize a click.

The bundled CCE routing hooks are optional and are not required for SSH named
connections. Keep them disabled for this workflow: their `cursor_context_engine`
route is for local projects, while SSH requests use `cursor_ssh_session` or
`cursor_connection_send`.

`6.0.9-ssh.3` also recognizes Cursor's two host-only SSH authority forms:
`ssh-remote+alias` and hex-encoded JSON containing only `hostName`. The comparison
is limited to an exact, case-sensitive alias match. User names, explicit ports,
SSH options and unknown fields are not discarded or treated as equivalent.
The actual Cursor workspace URI is preserved; this does not move or merge chat
history. A saved session must still resolve to its exact original Agent.

Classic IDE's unified sidebar is supported through the existing workspace-scoped
native header services, so the adapter does not require a visible history button.
Header enumeration omits titles and message text. Existing chats are opened only
by a unique exact header ID; unknown statuses are not reported as completion.
Before sending or extracting a reply, SSH tasks also verify the exact visible
composer. A New Agent click alone cannot authorize sending into an old chat.

## Named connections across Codex chats

`6.0.9-ssh.2` added user-level target names that are independent of Codex thread IDs and
working directories. Since `6.0.9-ssh.5`, the exact SSH URI is shared but each caller's
dedicated Bridge session is separate. Existing names can be listed or inspected without
contacting Cursor:

```json
{"action":"list"}
```

Call `cursor_connection` once to save a target:

```json
{"action":"save","name":"project","uri":"vscode-remote://ssh-remote+dev/srv/project"}
```

An optional `session_id` when saving configures the explicit shared default,
not every caller's default. It must match the exact URI and read-only scope. A saved
name cannot silently move to another target: retargeting needs `replace:true`.
When moving a name without explicitly supplying another session, the old default
session is cleared. Other saved names remain intact.

In a new Codex chat, the caller only needs `cursor_connection_send`:

```json
{
  "name":"project",
  "prompt":"Inspect the entry points in this chat's dedicated Agent.",
  "request_id":"unique-new-turn-id",
  "request_context":{"sender":"model","source":"user"}
}
```

The controller reads the saved URI, verifies the actual SSH IDE window, and
continues only the current caller's stored Agent. It does not ask for the host/path/session again.
The first send creates a dedicated session if the name has no session yet, then
persists its ID. `new_session:true` explicitly requests another dedicated Agent.
Missing, interrupted, closed or mismatched saved sessions never silently fall
back to creating a replacement. Inspect/reconcile the exact session first.

The reply receipt includes `connectionName`, `sessionReused`, `sessionId` and
`taskId`. Poll and collect with `cursor_status` as usual. Request IDs deduplicate
only the latest turn, including retries while the first turn is pending.

Defaults are `%APPDATA%/cursor-bridge/connections-v1.json` for names and
`%APPDATA%/cursor-bridge/sessions-v1.json` for sessions. The default names file is
shared across new chats; `CURSOR_BRIDGE_CONNECTIONS_FILE` can deliberately isolate
it. Adapters must also share their session registry to continue the same Agent.
Thread-specific workspace bindings remain separate and are revalidated by name.
No credentials or chat bodies are stored in the named-connection records.

The names file uses atomic writes, a cross-process lock and revision checks.
If another process changes a mapping after a task was submitted, the controller
returns the original task receipt with `connectionUpdated:false`; it neither
overwrites the changed mapping nor resends the prompt.

This fork adds dedicated, persistent collaboration chats for one already-open
SSH folder in the classic Cursor IDE on Windows. Cursor keeps the SSH connection;
the MCP adapter continues to run locally. The Agent UI is controlled through
local CDP, including DOM/React reads and targeted keyboard/mouse events.

## Scope

- One single-folder `vscode-remote://ssh-remote+alias/absolute/path` workspace.
- Exact SSH authority and case-sensitive POSIX path matching.
- A new dedicated chat on the first turn; subsequent turns reuse its exact Agent.
- Read-only request scope, one active turn per session, caller-isolated defaults and stable request IDs.
- No automatic window opening, closing, project switching, or prompt resubmission.
- Agents Window, multi-root folders and remote write tasks are outside this MVP.

The API rejects write parameters and adds explicit read-only instructions. Cursor
retains its own tool permissions: this is **not an OS filesystem sandbox**.
Window identity verification also does not independently prove SSH liveness;
initialization reports `remoteConnectionState: not-independently-probed`.

## Install this fork

```powershell
codex plugin marketplace add littlezhanzhan/cursor-bridge --ref codex/ssh-collaboration-mvp
codex plugin add cursor-bridge@littlezhanzhan
```

The fork uses the separate `littlezhanzhan` marketplace and disables automatic
Cursor startup in its Codex manifest. Enable only the intended Cursor Bridge
installation in the plugin manager so tools from two installations are not mixed.
Restart/reload the AI client and start a fresh chat to load the new tool schemas.
No additional Grok plugin is required.

## Open the target IDE window

Save work and close Cursor normally once if it was launched without CDP. Start
the Windows desktop with its local debugging port, then open/connect the desired
SSH folder through Cursor's normal Remote SSH UI. For example:

```powershell
& "$env:LOCALAPPDATA\Programs\cursor\Cursor.exe" --remote-debugging-port=9223 --remote-allow-origins=http://localhost:9223 --classic
```

Keep CDP local. Existing SSH configuration, authentication and host-key checks
remain owned by Cursor. Initialization only binds an already-open matching IDE;
it never closes a running editor or changes it to a different project.

## Initialize and create a chat

Call `cursor_ssh_init`:

```json
{"authority":"ssh-remote+dev","remote_path":"/srv/project"}
```

Or use `{"uri":"vscode-remote://ssh-remote+dev/srv/project"}`. Paths must already
be absolute; resolve `~` using the remote host. If two IDE windows show the same
folder, pass the intended exact CDP `target_id`; ambiguous matches are rejected.

Call `cursor_ssh_session` for the first turn:

```json
{
  "prompt":"Read the project entry points without changing any files.",
  "request_id":"unique-first-turn-id",
  "workspace_uri":"vscode-remote://ssh-remote+dev/srv/project",
  "request_context":{"sender":"model","source":"user"}
}
```

It returns a task ID and a Bridge `sessionId`. Use `cursor_status` with `task_id`
to follow progress; retrieve the reply with `detail: "result"`. Collection is
explicit so an unread reply cannot silently disappear.

For the next turn, supply the returned `session_id` and a **new** `request_id`.
Reuse a request ID only to retry that same latest turn. The same exact canonical
workspace URI and Agent ID are checked. A request never adopts an arbitrary
existing user chat. The classic history menu may initially be empty.

Shared registry transactions prevent two adapters using that same registry from
admitting simultaneous tasks to one remote URI. Unknown/interrupted sessions keep
the workspace reserved until reconciled; elapsed time alone does not prove stop.
Different registry files are independent and must not be used to bypass admission.

## Recovery and limitations

- Each new adapter must explicitly initialize and revalidate its saved SSH binding.
- Polling, reply collection and targeted stop recheck the renderer workspace identity.
- A lost/replaced CDP target is not silently substituted. This MVP requires a fresh
  adapter, explicit initialization, then `cursor_session_control` reconciliation
  of the exact saved session. It does not automatically resend the old prompt.
- An uncertain stop remains unconfirmed. Agent cancellation is not a guarantee
  that all previously launched remote shell child processes have exited.
- UI/React selectors are internal Cursor interfaces and require version regression.
- The upstream local-workspace behavior remains available through its original tools.

## Build and verification

```powershell
npm install --ignore-scripts
npm run build:cursor
npm test
npm run smoke:mcp
```

`build:cursor` builds only the Cursor adapter and lifecycle bundle, without requiring
dependencies of the independent Grok plugin. MCP smoke uses isolated state and never
submits a model request.

An explicit live check makes two requests using the signed-in Cursor account:

```powershell
node test/live-ssh-session.mjs --confirm-live --uri vscode-remote://ssh-remote+dev/srv/project --file example.py
```

Review and authorize that payload before running it. The first turn checks only the
named Python file and remembers a random token; the second recalls the token without
being given it again. The script requires the same exact Agent and Bridge session.
If the named file is absent it reports absence, without scanning alternative files.
This proves chat continuity; it does not independently verify all model claims or
guarantee no writes. State and replies are saved under ignored `.artifacts/` by default.

Live validation on Cursor 3.21.18 completed two turns on one SSH workspace, preserving
the same Agent/session and recalling the token. The test file was absent, so this
run verified directory routing and file-existence handling rather than file-content
extraction. No broad remote-write, disconnect or cross-version certification is claimed.
