/**
 * Qode Agent Experiment Runner
 *
 * Usage:
 *   PROMPT="Your prompt here" PROJECT_DIR=/path/to/project npx tsx run-experiment.ts
 *
 * Or edit the PROMPT and PROJECT_DIR variables below directly.
 */

import { createAgent } from "@qode-agent/runtime";
import { resolve } from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION — Edit these for each experiment
// ═══════════════════════════════════════════════════════════════

const PROMPT = process.env.PROMPT || "You are building a Qode agent project.";

const PROJECT_DIR = "/Users/akshaylakkur/Projects/V/"; 

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

function timestamp(): string {
  return new Date().toLocaleTimeString("en-US", { hour12: false });
}

function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "...";
}

function listFiles(dir: string, prefix = ""): string[] {
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir)) {
      const full = resolve(dir, entry);
      const rel = prefix ? `${prefix}/${entry}` : entry;
      try {
        const st = statSync(full);
        if (st.isDirectory()) {
          results.push(`📁 ${rel}/`);
          results.push(...listFiles(full, rel));
        } else {
          results.push(`📄 ${rel} (${(st.size / 1024).toFixed(1)} KB)`);
        }
      } catch { results.push(`  ${rel}`); }
    }
  } catch {}
  return results;
}

// ═══════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════

async function main() {
  console.log(`[${timestamp()}] ╔══════════════════════════════════════════════╗`);
  console.log(`[${timestamp()}] ║      Qode Agent Experiment Runner            ║`);
  console.log(`[${timestamp()}] ╚══════════════════════════════════════════════╝`);
  console.log();

  if (!existsSync(PROJECT_DIR)) {
    mkdirSync(PROJECT_DIR, { recursive: true });
    console.log(`[${timestamp()}] ✓ Created project directory: ${PROJECT_DIR}`);
  } else {
    console.log(`[${timestamp()}] ✓ Project directory: ${PROJECT_DIR}`);
  }
  console.log();

  console.log(`[${timestamp()}] 🔧 Creating Qode agent...`);
  const agent = createAgent({ workDir: PROJECT_DIR, yolo: true });

  if (!agent) {
    console.error(`[${timestamp()}] ✗ Failed to create agent — no provider configured.`);
    console.error(`  Check ~/.Q/config.toml has provider/model/apiKey set.`);
    process.exit(1);
  }

  console.log(`[${timestamp()}] ✓ Agent created`);
  console.log(`  Model:     ${agent.config.model}`);
  console.log(`  CWD:       ${agent.config.cwd}`);
  console.log(`  Profile:   ${agent.config.profileName ?? "(none)"}`);
  console.log(`  Thinking:  ${agent.config.thinkingLevel}`);
  console.log();

  console.log(`[${timestamp()}] 📝 Prompt:`);
  console.log(`  ${PROMPT}`);
  console.log();

  console.log(`[${timestamp()}] 🚀 Launching agent turn...`);
  console.log(`  ${"=".repeat(60)}`);
  console.log();

  const startedAt = Date.now();
  let lastMessageCount = 0;
  let stepCount = 0;
  let lastFileCheck = 0;

  const pollInterval = setInterval(() => {
    const messages = agent.context.messages;
    if (messages.length > lastMessageCount) {
      for (let i = lastMessageCount; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg) continue;

        if (msg.role === "assistant") {
          stepCount++;
          const content = typeof msg.content === "string" ? msg.content : "";
          const hasToolCalls = msg.toolCalls && msg.toolCalls.length > 0;

          if (content) {
            console.log(`[${timestamp()}] 🤖 Step ${stepCount}: ${truncate(content, 500)}`);
          }
          if (hasToolCalls && msg.toolCalls) {
            for (const tc of msg.toolCalls) {
              const name = tc.function.name;
              const argsStr = tc.function.arguments || "{}";
              try {
                const parsed = JSON.parse(argsStr);
                if (name === "Bash" && parsed.command) {
                  console.log(`  🛠  ${name}: ${truncate(parsed.command, 500)}`);
                } else if (name === "Write" && parsed.file_path) {
                  const lines = parsed.content ? parsed.content.split("\n").length : 0;
                  console.log(`  ✏️  ${name}: ${parsed.file_path} (${lines} lines)`);
                } else if (name === "Read" && parsed.file_path) {
                  console.log(`  📖 ${name}: ${parsed.file_path}`);
                } else if (name === "StrReplace" && parsed.path) {
                  console.log(`  🔄 ${name}: ${parsed.path}`);
                } else {
                  console.log(`  🛠  ${name}: ${truncate(JSON.stringify(parsed), 300)}`);
                }
              } catch {
                console.log(`  🛠  ${name}: ${truncate(argsStr, 300)}`);
              }
            }
          }
        } else if (msg.role === "tool") {
          const toolContent = String(msg.content);
          const status = msg.isError ? "❌" : "✅";
          if (toolContent.length > 0 && toolContent !== "Tool output is empty." && !toolContent.includes("<system>")) {
            console.log(`  ${status} ${truncate(toolContent, 300)}`);
          }
        }
      }
      lastMessageCount = messages.length;
    }
  }, 200);

  const turnId = agent.turn.prompt(PROMPT);
  if (turnId === null) {
    console.error(`[${timestamp()}] ✗ Could not launch turn`);
    clearInterval(pollInterval);
    process.exit(1);
  }

  console.log(`[${timestamp()}] ℹ  Turn ID: ${turnId}`);
  console.log();

  try {
    await agent.turn.waitForCurrentTurn();
  } catch (err) {
    console.error(`[${timestamp()}] ✗ Turn error:`, err);
  } finally {
    clearInterval(pollInterval);
  }

  const durationMs = Date.now() - startedAt;
  const durationSec = (durationMs / 1000).toFixed(1);

  console.log(`  ${"=".repeat(60)}`);
  console.log();
  console.log(`[${timestamp()}] ✅ Turn completed in ${durationSec}s`);
  console.log();

  const messages = agent.context.messages;
  const assistantMessages = messages.filter((m) => m.role === "assistant");
  const lastAssistant = assistantMessages[assistantMessages.length - 1];

  if (lastAssistant) {
    const content = typeof lastAssistant.content === "string" ? lastAssistant.content : "";
    console.log(`[${timestamp()}] 📋 Final assistant response:`);
    console.log(`  ${"=".repeat(58)}`);
    console.log(`  ${content}`);
    console.log(`  ${"=".repeat(58)}`);
  }

  const totalToolCalls = messages.filter((m) => m.role === "tool").length;

  console.log();
  console.log(`[${timestamp()}] 📊 Summary:`);
  console.log(`  Duration:       ${durationSec}s`);
  console.log(`  Total steps:    ${stepCount}`);
  console.log(`  Tool calls:     ${totalToolCalls}`);
  console.log(`  Assistant msgs: ${assistantMessages.length}`);
  console.log(`  Total messages:  ${messages.length}`);
  console.log();

  console.log(`[${timestamp()}] 🏁 Experiment complete.`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});