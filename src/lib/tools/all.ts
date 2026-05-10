/**
 * Side-effect import that registers every tool in the registry.
 *
 * Anything that needs the tool registry populated — tests, MCP server
 * factories, Mastra workflow steps, `pnpm prompts:dump`-style scripts —
 * imports this file before calling `listTools()` or `getTool()`. No
 * wildcard re-export: each tool's module runs its `registerTool(...)`
 * call at import time and the registry collects them.
 *
 * Ordered by layer for readability; duplicate-registration is caught at
 * runtime so accidental double-imports fail fast.
 */
import "./arc/get-arc-state";
import "./arc/list-active-seeds";
import "./arc/plant-foreshadowing-seed";
import "./arc/resolve-seed";
// Chronicler write tools (post-turn archivist). Same registry; different
// call sites — KA doesn't call these from its prompt, but they share the
// MCP surface so the authorization gate is the only thing keeping KA
// out of the write path by convention.
import "./chronicler/adjust-spotlight-debt";
import "./chronicler/plant-foreshadowing-candidate";
import "./chronicler/ratify-foreshadowing-seed";
import "./chronicler/record-relationship-event";
import "./chronicler/register-faction";
import "./chronicler/register-location";
import "./chronicler/register-npc";
import "./chronicler/retire-foreshadowing-seed";
import "./chronicler/spawn-transient";
import "./chronicler/trigger-compactor";
import "./chronicler/update-arc-plan";
import "./chronicler/update-context-block";
import "./chronicler/update-npc";
import "./chronicler/update-voice-patterns";
import "./chronicler/write-director-note";
import "./chronicler/write-episodic-summary";
import "./chronicler/write-semantic-memory";
import "./critical/get-critical-memories";
import "./critical/get-overrides";
import "./entities/get-character-sheet";
import "./entities/get-context-block";
import "./entities/get-npc-details";
import "./entities/get-world-state";
import "./entities/list-known-npcs";
import "./episodic/get-recent-episodes";
import "./episodic/get-turn-narrative";
import "./episodic/recall-scene";
import "./semantic/search-memory";
// Session Zero conductor tools (M2 Wave A sub 2). Layer: session_zero —
// not a cognitive memory layer; mounted only by the SessionZeroConductor
// via buildSessionZeroMcpServers, never by KA.
import "./sz/ask-clarifying-question";
import "./sz/commit-field";
import "./sz/finalize-session-zero";
import "./sz/propose-canonicality-mode";
import "./sz/propose-character-option";
import "./sz/search-profile-library";
import "./sz/spawn-subagent";
import "./voice/get-voice-exemplars-by-beat-type";
import "./voice/get-voice-patterns";
