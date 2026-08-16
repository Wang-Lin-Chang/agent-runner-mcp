# Contributing

Every capability claim in this repository carries an experiment number (see `EXPERIMENTS.md`). Contributions must follow the same rule.

## Rules

- **No claims without an experiment.** New MCP tools or protocol behaviors need a probe + control group before they enter `src/`.
- Tests must pass: `npm test` (15-assertion MCP client protocol test).
- No machine-specific paths in committed code.

## Development

```sh
npm test                                   # MCP client protocol test
node --experimental-strip-types src/server.ts   # run server directly
claude mcp add agent-runner -- node dist/server.js   # register with Claude Code
```
