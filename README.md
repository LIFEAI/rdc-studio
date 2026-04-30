# rdc-studio

Design tooling skill suite for Claude Code. Houses the `impeccable` skill and future LIFEAI design tools.

## Skills

| Skill | Description |
|-------|-------------|
| `impeccable` | Production-grade frontend UI design — shape, craft, critique, audit, animate, and iterate interfaces |

## Install

```bash
node C:/Dev/rdc-studio/scripts/install-rdc-studio.js
```

Installs to:
- **Claude Code CLI** — `~/.claude/plugins/cache/rdc-studio/rdc-studio/latest/`
- **Claude Desktop (Cowork)** — per-workspace `cowork_plugins/` directory
- **Codex** — `C:/Dev/regen-root/.agents/skills/user/studio-impeccable/`
- **FS MCP symlink** — `C:/Dev/regen-root/.claude/skills/impeccable/` → source

Restart Claude Code after installing to load the updated plugin.

## Relationship to rdc-skills

- `rdc-skills` — workflow and PM skills (`rdc:build`, `rdc:plan`, `rdc:deploy`, etc.)
- `rdc-studio` — design tooling (`impeccable` and future design skills)

Both are independent plugins with separate versioning and install scripts.

## Development

Source lives in `C:/Dev/rdc-studio/`. After editing:

```bash
git add -A
git commit -m "feat: ..."
git tag vX.Y.Z
git push && git push --tags
node scripts/install-rdc-studio.js
```
