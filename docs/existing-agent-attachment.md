# Explicitly attach an existing Cursor IDE Agent

This references a saved conversation already selected in a classic Cursor IDE
window. It supports one local or SSH folder without opening a window, changing
the IDE folder, creating an Agent, or sending a message during attachment.

1. Call `cursor_agent_attach` with `action:"inspect"`. Supply an exact target_id
   when multiple page targets exist; Bridge never guesses by title.
2. Require attachable:true, then call action:"attach" with the returned
   expected_agent_id and target. workspace_path is an optional assertion.
   The selected Agent is checked twice under the cross-process UI lock.
3. action:"get" reads only the current caller's saved attachment. It returns the
   Bridge sessionId together with the unchanged original Cursor Agent ID.
4. For a later authorized task, call `cursor_agent_send`; poll its exact taskId
   and collect cursor_status(task_id, detail:"result") after a terminal state.

Caller references live in agent-attachments-v1.json, configurable with
CURSOR_BRIDGE_AGENT_ATTACHMENTS_FILE. Named SSH targets are not retargeted.
Explicit sharing reuses a canonical session; one Agent admits one active turn,
including when an older alias exists.

Unknown historical Agents receive read-only Bridge access. Cursor's native
permission and mode settings are not changed. Already registered trusted Bridge
policies are preserved. Attachment does not apply global model defaults.

Only selected, saved, idle top-level Agents with recognized empty input are
accepted. Draft text, detected draft attachments, unknown status, selection
changes and visible modal/menu blockers prevent attachment. Draft checks repeat
before filling a later task. Do not type into the same Agent during dispatch:
the UI lock coordinates Bridge processes, not physical mouse/keyboard input.

The folder assertion identifies the existing window. It is not an OS sandbox
or a claim about every tool's working directory. History and execution context
remain in Cursor; Codex receives new task results, not a full history import.
After a window restart or folder change, explicitly inspect and attach again.
