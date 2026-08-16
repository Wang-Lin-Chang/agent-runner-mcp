# Security Policy

## Supported versions

Latest tag only. Early public preview — breaking changes may occur.

## Reporting a vulnerability

Private reporting only: https://github.com/Wang-Lin-Chang/agent-runner-mcp/security/advisories/new

Include: affected version, reproduction steps, impact.

## Scope

Reportable when an attacker can:

- Escape the runner sandbox to overwrite evidence files in the task directory
- Forge the lock/exit protocol without detection via the MCP tools
- Make the server write outside its designated directories

## Out of scope

- Capability-based escapes documented in the runner backends (dsh-cross-platform / dsh-macos)
- MCP transport layer attacks outside the stdio process boundary
