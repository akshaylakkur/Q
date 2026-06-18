/**
 * Config — Built-in default configuration.
 *
 * Compiled into the bundle as a static TOML string.
 * Provides sensible defaults for all configuration keys.
 */
export const DEFAULT_CONFIG_TOML = `# Qode — Built-in Default Configuration
# These defaults are compiled into the binary. Settings in
# $HOME/.Q/config.toml, .q/config.toml, and .q/session.toml
# override these values with increasing priority.

[orchestrator]
maxParallelAgents = 8
defaultMode = "auto"
convergenceTimeout = 60000
taskTimeout = 300000

[memory]
episodicRecallMaxCount = 500
ltpmEnabled = true
compactionTriggerRatio = 0.75
reservedContextSize = 4096

[loopControl]
maxStepsPerTurn = 50
maxRetriesPerStep = 3
compactionTriggerRatio = 0.75

[background]
maxRunningTasks = 5
keepAliveOnExit = false
agentTaskTimeoutS = 900

[thinking]
mode = "auto"
effort = 50

[permission]
rules = []

[telemetry]
enabled = true
crashReporting = true

[display]
linkPreview = true
imagePreview = true
animations = true

planMode = false
defaultPermissionMode = "ask"
mergeAllAvailableSkills = false
extraSkillDirs = []

[services]

hooks = []

# ── Qollab Collaboration ──────────────────────────────────────────────────
[collaboration]
enabled = false
serverUrl = "wss://collab.qode.sh"
defaultCollabType = "pair"
maxAttendees = 8
snapshotSyncRateLimit = 1
encryption = "AES-256-GCM"

[collaboration.chat]
historyLimit = 10000
colorPalette = ["#22D3EE", "#A78BFA", "#FBBF24", "#4ADE80", "#FB7185", "#38BDF8"]
`;
