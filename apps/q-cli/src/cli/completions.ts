import chalk from "chalk";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";

// ── Completions command logic ──────────────────────────────────────────

/**
 * `q-cli completions` — Generate shell completions for bash/zsh/fish.
 */
export async function completionsCommand(shell?: string): Promise<void> {
  const targetShell = shell ?? detectShell();

  switch (targetShell) {
    case "bash":
      generateBashCompletions();
      break;
    case "zsh":
      generateZshCompletions();
      break;
    case "fish":
      generateFishCompletions();
      break;
    default:
      console.log(chalk.red(`Unknown shell: ${targetShell}`));
      console.log(chalk.dim("  Supported shells: bash, zsh, fish"));
      process.exit(1);
  }
}

function detectShell(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("fish")) return "fish";
  if (shell.includes("bash")) return "bash";
  return "bash";
}

function generateBashCompletions(): void {
  const scriptLines: string[] = [
    "# q-cli bash completion",
    "_q_cli() {",
    "    local cur prev words cword",
    '    _init_completion || return',
    "",
    '    local commands="init session config doctor migrate update completions daemon profile connect help"',
    '    local global_opts="-S --session -C --continue -y --yolo -m --model -p --prompt --plan --auto --output-format --skills-dir --cwd -h --help -V --version"',
    "",
    "    if [[ $cword -eq 1 ]]; then",
    '        COMPREPLY=($(compgen -W "$commands $global_opts" -- "$cur"))',
    "        return",
    "    fi",
    "",
    '    case "${words[1]}" in',
    "        session)",
    "            if [[ $cword -eq 2 ]]; then",
    '                COMPREPLY=($(compgen -W "list show delete export import" -- "$cur"))',
    "            fi",
    "            ;;",
    "        config)",
    "            if [[ $cword -eq 2 ]]; then",
    '                COMPREPLY=($(compgen -W "show edit set get path" -- "$cur"))',
    "            fi",
    "            ;;",
    "        completions)",
    "            if [[ $cword -eq 2 ]]; then",
    '                COMPREPLY=($(compgen -W "bash zsh fish" -- "$cur"))',
    "            fi",
    "            ;;",
    "        daemon)",
    '            COMPREPLY=($(compgen -W "-p --port --collaborative" -- "$cur"))',
    "            ;;",
    "    esac",
    "} && complete -F _q_cli q-cli",
    "",
  ];
  const completionScript = scriptLines.join("\n");

  const outputPath = resolve(process.cwd(), "q-cli-completion.bash");
  writeFileSync(outputPath, completionScript, "utf-8");
  console.log(chalk.green("✓ Bash completions written"));
  console.log(chalk.dim(`  File: ${outputPath}`));
  console.log(chalk.dim("  Source it: source q-cli-completion.bash"));
  console.log(chalk.dim("  Or install: sudo cp q-cli-completion.bash /etc/bash_completion.d/q-cli"));
}

function generateZshCompletions(): void {
  const scriptLines: string[] = [
    "#compdef q-cli",
    "",
    "_q_cli() {",
    "  local context state state_descr line",
    "  typeset -A opt_args",
    "",
    "  _arguments -C \\",
    "    '-S[Resume a specific session]:session: ' \\",
    "    '--session[Resume a specific session]:session: ' \\",
    "    '-C[Continue the last session]' \\",
    "    '--continue[Continue the last session]' \\",
    "    '-y[Auto-approve all actions]' \\",
    "    '--yolo[Auto-approve all actions]' \\",
    "    '-m[Override the LLM model]:model: ' \\",
    "    '--model[Override the LLM model]:model: ' \\",
    "    '-p[Non-interactive prompt mode]:prompt: ' \\",
    "    '--prompt[Non-interactive prompt mode]:prompt: ' \\",
    "    '--plan[Enter plan mode on startup]' \\",
    "    '--auto[Auto permission mode]' \\",
    "    '--output-format[Output format]:format:(text json stream-json)' \\",
    "    '--skills-dir[Additional skill directory]:dir:_files -/' \\",
    "    '--cwd[Working directory]:dir:_files -/' \\",
    "    '-V[Show version]' \\",
    "    '-h[Show help]' \\",
    "    '1: :->command' \\",
    "    '*:: :->args' \\",
    "  && return 0",
    "",
    "  case $state in",
    "    command)",
    '      local commands; commands=(',
    "        'init:Initialize the project'",
    "        'session:Session management'",
    "        'config:Configuration management'",
    "        'doctor:Environment diagnostics'",
    "        'migrate:Migrate from legacy format'",
    "        'update:Check for updates'",
    "        'completions:Generate completions'",
    "        'daemon:Start server mode'",
    "        'profile:Run benchmarks'",
    "        'connect:Connect to daemon'",
    "      )",
    '      _describe "command" commands',
    "      ;;",
    "    args)",
    "      case $line[1] in",
    "        session)",
    '          _alternative "actions::($(printf \'%s\n\' list show delete export import))"',
    "          ;;",
    "        config)",
    '          _alternative "actions::($(printf \'%s\n\' show edit set get path))"',
    "          ;;",
    "        completions)",
    '          _alternative "shells::($(printf \'%s\n\' bash zsh fish))"',
    "          ;;",
    "      esac",
    "      ;;",
    "  esac",
    "}",
    "",
    "_q_cli",
    "",
  ];
  const completionScript = scriptLines.join("\n");

  const outputPath = resolve(process.cwd(), "q-cli-completion.zsh");
  writeFileSync(outputPath, completionScript, "utf-8");
  console.log(chalk.green("✓ Zsh completions written"));
  console.log(chalk.dim(`  File: ${outputPath}`));
  console.log(chalk.dim("  Source it: source q-cli-completion.zsh"));
  console.log(chalk.dim("  Or install: sudo cp q-cli-completion.zsh /usr/share/zsh/site-functions/_q-cli"));
}

function generateFishCompletions(): void {
  const scriptLines: string[] = [
    "# q-cli fish completion",
    "complete -c q-cli -f",
    "",
    "# Global options",
    "complete -c q-cli -s S -l session -d 'Resume a specific session'",
    "complete -c q-cli -s C -l continue -d 'Continue the last session'",
    "complete -c q-cli -s y -l yolo -d 'Auto-approve all actions'",
    "complete -c q-cli -s m -l model -d 'Override the LLM model'",
    "complete -c q-cli -s p -l prompt -d 'Non-interactive prompt mode'",
    "complete -c q-cli -l plan -d 'Enter plan mode on startup'",
    "complete -c q-cli -l auto -d 'Auto permission mode'",
    "complete -c q-cli -l output-format -d 'Output format' -xa 'text json stream-json'",
    "complete -c q-cli -l skills-dir -d 'Additional skill directory'",
    "complete -c q-cli -l cwd -d 'Working directory'",
    "",
    "# Commands",
    "complete -c q-cli -n '__fish_use_subcommand' -xa init -d 'Initialize project'",
    "complete -c q-cli -n '__fish_use_subcommand' -xa session -d 'Session management'",
    "complete -c q-cli -n '__fish_use_subcommand' -xa config -d 'Configuration management'",
    "complete -c q-cli -n '__fish_use_subcommand' -xa doctor -d 'Environment diagnostics'",
    "complete -c q-cli -n '__fish_use_subcommand' -xa migrate -d 'Migration from legacy format'",
    "complete -c q-cli -n '__fish_use_subcommand' -xa update -d 'Check for updates'",
    "complete -c q-cli -n '__fish_use_subcommand' -xa completions -d 'Generate completions'",
    "complete -c q-cli -n '__fish_use_subcommand' -xa daemon -d 'Start server mode'",
    "complete -c q-cli -n '__fish_use_subcommand' -xa profile -d 'Run benchmarks'",
    "complete -c q-cli -n '__fish_use_subcommand' -xa connect -d 'Connect to daemon'",
    "",
    "# Session subcommands",
    "complete -c q-cli -n '__fish_seen_subcommand_from session' -xa list -d 'List sessions'",
    "complete -c q-cli -n '__fish_seen_subcommand_from session' -xa show -d 'Show session details'",
    "complete -c q-cli -n '__fish_seen_subcommand_from session' -xa delete -d 'Delete a session'",
    "complete -c q-cli -n '__fish_seen_subcommand_from session' -xa export -d 'Export a session'",
    "complete -c q-cli -n '__fish_seen_subcommand_from session' -xa import -d 'Import a session'",
    "",
    "# Config subcommands",
    "complete -c q-cli -n '__fish_seen_subcommand_from config' -xa show -d 'Show configuration'",
    "complete -c q-cli -n '__fish_seen_subcommand_from config' -xa edit -d 'Edit configuration'",
    "complete -c q-cli -n '__fish_seen_subcommand_from config' -xa set -d 'Set a config value'",
    "complete -c q-cli -n '__fish_seen_subcommand_from config' -xa get -d 'Get a config value'",
    "complete -c q-cli -n '__fish_seen_subcommand_from config' -xa path -d 'Show config path'",
    "",
    "# Completions subcommand",
    "complete -c q-cli -n '__fish_seen_subcommand_from completions' -xa bash -d 'Bash completions'",
    "complete -c q-cli -n '__fish_seen_subcommand_from completions' -xa zsh -d 'Zsh completions'",
    "complete -c q-cli -n '__fish_seen_subcommand_from completions' -xa fish -d 'Fish completions'",
    "",
  ];
  const completionScript = scriptLines.join("\n");

  const outputPath = resolve(process.cwd(), "q-cli-completion.fish");
  writeFileSync(outputPath, completionScript, "utf-8");
  console.log(chalk.green("✓ Fish completions written"));
  console.log(chalk.dim(`  File: ${outputPath}`));
  console.log(chalk.dim("  Source it: source q-cli-completion.fish"));
  console.log(chalk.dim("  Or install: cp q-cli-completion.fish ~/.config/fish/completions/q-cli.fish"));
}

// ── Commander registration ────────────────────────────────────────────

/**
 * Register the `q-cli completions` command with Commander.
 */
export function registerCompletionsCommand(prog: Command): void {
  prog
    .command("completions")
    .description("Generate shell completion scripts for bash, zsh, or fish")
    .argument("[shell]", "Shell type: bash, zsh, or fish (default: auto-detect from $SHELL)")
    .action(async (shell?: string) => {
      await completionsCommand(shell).catch((err: Error) => {
        console.error(chalk.red("Completions command error:"), err.message);
        process.exit(1);
      });
    });
}
