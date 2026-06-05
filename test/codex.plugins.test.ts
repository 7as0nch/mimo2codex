import { describe, expect, it } from "vitest";
import {
  configHasMcpServer,
  mergeMcpServerToml,
  renderMcpServerBlock,
} from "../src/codex/plugins.js";

const serverName = "mimo-computer-use";
const block = `[mcp_servers.mimo-computer-use]
command = "node"
args = ["/tmp/mimo-computer-use/server/index.mjs"]
startup_timeout_sec = 20

[mcp_servers.mimo-computer-use.env]
MIMO2CODEX_ADMIN_URL = "http://127.0.0.1:8788"`;

describe("Codex built-in plugin TOML merge", () => {
  it("adds the MCP server block without touching unrelated config", () => {
    const existing = `model = "mimo-v2.5-pro"

[projects.'/tmp/work']
trust_level = "trusted"

[mcp_servers.linear]
url = "https://mcp.linear.app/mcp"
`;
    const out = mergeMcpServerToml(existing, serverName, true, block);

    expect(out).toContain(`model = "mimo-v2.5-pro"`);
    expect(out).toContain(`[projects.'/tmp/work']`);
    expect(out).toContain(`[mcp_servers.linear]`);
    expect(out).toContain(`[mcp_servers.mimo-computer-use]`);
    expect(out).toContain(`[mcp_servers.mimo-computer-use.env]`);
  });

  it("replaces stale plugin block instead of duplicating it", () => {
    const existing = `${block.replace("/tmp/mimo-computer-use", "/old")}

[mcp_servers.other]
command = "other"
`;
    const out = mergeMcpServerToml(existing, serverName, true, block);
    expect(out.match(/\[mcp_servers\.mimo-computer-use\]/g)?.length).toBe(1);
    expect(out).toContain(`"/tmp/mimo-computer-use/server/index.mjs"`);
    expect(out).not.toContain(`"/old/server/index.mjs"`);
    expect(out).toContain(`[mcp_servers.other]`);
  });

  it("removes only the selected plugin server", () => {
    const existing = `${block}

[mcp_servers.mimo-computer-use-extra]
command = "keep"

[mcp_servers.other]
command = "keep"
`;
    const out = mergeMcpServerToml(existing, serverName, false, block);
    expect(out).not.toContain(`[mcp_servers.mimo-computer-use]`);
    expect(out).not.toContain(`[mcp_servers.mimo-computer-use.env]`);
    expect(out).toContain(`[mcp_servers.mimo-computer-use-extra]`);
    expect(out).toContain(`[mcp_servers.other]`);
  });

  it("detects exact MCP server headers", () => {
    expect(configHasMcpServer(block, serverName)).toBe(true);
    expect(configHasMcpServer(`[mcp_servers.mimo-computer-use-extra]\ncommand = "x"\n`, serverName)).toBe(false);
  });

  it("renders a node command pointing at the plugin server", () => {
    const rendered = renderMcpServerBlock();
    expect(rendered).toContain(`[mcp_servers.mimo-computer-use]`);
    expect(rendered).toContain(`command = "node"`);
    // Path separator differs per-OS (path.join → backslashes on Windows), so
    // assert on the filename rather than a hard-coded "server/index.mjs".
    expect(rendered).toContain(`index.mjs`);
  });
});
