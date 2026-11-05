<!-- markdownlint-disable MD041 -->
## Summary

MCP Gateway 1.2.1 updates MCPHub and adds versioned Windows releases.

## Features

- Add Fake-IP exceptions scoped to an upstream server and exact hostname.
- Add PostgreSQL replicas, user-group sharing and unified tool access policies.
- Publish a separate self-contained Windows x64 package for each version.
- Include Node.js 24.16.0, persistent catalogs and isolated retained MCP owners.

## Fixes

- Preserve upstream connections when capability or group settings change.
- Improve nullable and union OpenAPI parameters and scalar array inputs.
- Refresh package versions promptly after reinstall or reload.
- Restore Authorization passthrough through administrator opt-in.
- Allow enabled prompts to wake retained owners from a cold catalog.

## 摘要

MCP Gateway 1.2.1 集成 MCPHub 1.2.1，并改为每个版本单独发布 Windows 安装包。

## 功能

- 新增由管理员管理的 Fake-IP 例外，精确限定上游服务器和主机名。
- 引入 MCPHub 1.2.0 的可选 PostgreSQL 多副本部署、用户组共享和统一工具访问策略。
- 为每个版本发布独立的 Windows 安装包，不再覆盖浮动发行版。

## 修复

- 修改工具、提示词、资源或分组配置时保留上游连接。
- 改进 OpenAPI 可空类型和联合类型参数、数组单值输入，以及重新安装或重新加载后的版本刷新。
- 通过管理员显式启用恢复 Authorization 透传，默认关闭。
- 允许已启用的提示词从冷目录唤醒保留的运行时。

## References

<!-- markdownlint-disable MD013 MD034 -->
- feat: scope Fake-IP exceptions to upstream server and hostname by @samanhappy in https://github.com/samanhappy/mcphub/pull/1446
- fix: preserve upstream connections on tool, prompt and resource config changes by @11113127 in https://github.com/samanhappy/mcphub/pull/1449
- fix(openapi): handle nullable and union tool parameters by @OsamaAnsar in https://github.com/samanhappy/mcphub/pull/1447
- fix: refresh package version promptly after reinstall and reload by @samanhappy in https://github.com/samanhappy/mcphub/pull/1451
- fix: restore Authorization passthrough with an admin opt-in by @samanhappy in https://github.com/samanhappy/mcphub/pull/1453
- Full changelog: https://github.com/Afgan0r/mcp-gateway/compare/d0c27eb7a8ebfa55770bfa5ed206d329069f3f64...gateway-native-v1.2.1
<!-- markdownlint-enable MD013 MD034 -->
