# Changelog

## [0.1.0] - 2026-08-17

### Added

- Zero-dependency MCP server (stdio JSON-RPC, LSP + newline framing, protocol 2024-11-05).
- Six tools: task_run / task_wait / task_output / task_autopsy / task_kill / task_adopt.
- Three platform runners vendored (Windows ACL / Linux bwrap / macOS sandbox-exec).
- MCP client test: 15 assertions covering handshake, sandbox full-chain, crash adoption, death semantics.
- Claude Code registration verified (✓ Connected health check).

### Fixed

- Observer artifacts (autopsy report) written outside the protected task directory — Windows runner ACL persists after task end (EPERM measured).
