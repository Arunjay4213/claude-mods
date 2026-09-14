# claude-mods

Three session trackers for Claude Code, built as mods.
A mod is a Claude Code plugin whose behaviour is TypeScript running inside Claude Code's engine (the feature Anthropic calls function hooks).
Each one keeps a figure on screen that you otherwise have to run a command to see.

| Mod | Pinned line under the prompt | Pane command |
| --- | --- | --- |
| [`context-lens`](plugins/context-lens) | context window used, growth per turn, turns left before compaction | `/context-lens` |
| [`quota-meter`](plugins/quota-meter) | 5-hour and 7-day plan limits, reset countdown, projected time until the limit | `/quota` |
| [`token-ledger`](plugins/token-ledger) | session cost, last turn's cost, tokens in and out, cache hit ratio | `/ledger` |

## Install

Mods are early access.
They only load when function hooks are switched on, so add this to `~/.claude/settings.json` first:

```json
{
  "env": {
    "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"
  }
}
```

Then add the marketplace and install the ones you want:

```
claude plugin marketplace add Arunjay4213/claude-mods
claude plugin install context-lens@claude-mods
claude plugin install quota-meter@claude-mods
claude plugin install token-ledger@claude-mods
```

Restart Claude Code.
The pinned lines appear after the first answer of the session.

## Requirements

- Claude Code 2.1.269 or newer, in an interactive terminal.
- `quota-meter` needs a Claude subscription (Pro, Max, Team or Enterprise). API-key sessions report no plan limits, so it shows a short note instead.
- The pane docks beside the transcript from 110 columns wide and opens above the prompt on narrower terminals.

## Try one from source

```
git clone https://github.com/Arunjay4213/claude-mods
cd claude-mods
CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir plugins/token-ledger
```

## Development

Each plugin is `.claude-plugin/plugin.json`, `hooks/hooks.json` naming the module, and TypeScript under `hooks/`.
The type declarations in `.claude/types/claude-code.d.ts` come from the `/plugin-types` command inside Claude Code; regenerate them after an update rather than editing them.

```
npm install
npx tsc -p tsconfig.json                 # typecheck every mod
claude plugin validate plugins/quota-meter
```

The function hooks API is early access and may change between Claude Code releases.
Anthropic's own mods, which these copy their structure from, live at https://github.com/anthropics/claude-code/tree/main/mods.

## License

MIT
