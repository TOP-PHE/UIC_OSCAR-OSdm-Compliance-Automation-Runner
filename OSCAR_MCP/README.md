# OSCAR MCP server

Lets an AI assistant (Claude Desktop, Claude Code, or any client of the
[Model Context Protocol](https://modelcontextprotocol.io)) read OSCAR's test
results: runs, their checks, batches and the queue of **one** company or
provider.

It is a thin layer over OSCAR's read-only API (`/v1/api`, issue #503). It holds
one **API key** and has no more rights than that key: it cannot start, change
or delete anything, it cannot read request or response bodies or logs, and it
only sees the runs of the company or provider the key was made for.

Node 22 or later. Nothing to install: it has no dependency.

## 1. Make a key

In OSCAR, as a Test Manager: menu **API Keys**, choose the company or provider
in **Working on**, give the key a name ("Claude Desktop", for instance) and a
lifetime, and copy the key shown (it is shown once). See the user guide, § 2.3.

## 2. Tell your assistant about it

The server is started by the assistant, with two environment variables:

| Variable | Value |
|---|---|
| `OSCAR_URL` | the OSCAR address, `https://<oscar host>` (`http://` is accepted for `localhost` only) |
| `OSCAR_API_KEY` | the key, `oscar_…` |

**Claude Desktop** (`claude_desktop_config.json`, Settings → Developer → Edit
Config):

```json
{
  "mcpServers": {
    "oscar": {
      "command": "node",
      "args": ["C:\\path\\to\\oscar-monorepo\\OSCAR_MCP\\server.js"],
      "env": { "OSCAR_URL": "https://<oscar host>", "OSCAR_API_KEY": "oscar_…" }
    }
  }
}
```

**Claude Code**:

```bash
claude mcp add oscar --env OSCAR_URL=https://<oscar host> --env OSCAR_API_KEY="$OSCAR_KEY" -- node /path/to/OSCAR_MCP/server.js
```

Then ask, for instance: *"Which OSCAR runs failed today, and which checks
failed in the latest one?"*

## 3. The tools

| Tool | OSCAR route | What it gives |
|---|---|---|
| `oscar_key` | `GET /v1/api/key` | the key: name, company, scopes, expiry |
| `oscar_list_runs` | `GET /v1/api/runs` | the runs, newest first (`limit`, `offset`, `status`, `batch_id`, `scenario_code`) |
| `oscar_get_run` | `GET /v1/api/runs/{id}` | one run and its check counts |
| `oscar_get_run_checks` | `GET /v1/api/runs/{id}/assertions` | its checks by step (`result`: `failed` or `passed`) |
| `oscar_get_batch` | `GET /v1/api/batches/{batchId}` | the runs of a batch, counted by status |
| `oscar_get_queue` | `GET /v1/api/queue` | the runs waiting or running |

## 4. Safety

- **The key stays in the environment variable.** The server sends it to the
  configured OSCAR only, in the `Authorization` header, and never writes it in
  an answer, an error or a log line. Keep the assistant's configuration file
  private, as you would a password.
- **GET to `/v1/api` only, and only to `OSCAR_URL`.** A redirect is not
  followed (it would carry the key elsewhere). Arguments are checked before
  any call: an id with a slash or a dot segment is refused.
- **What the tools return is data.** Check names and error texts come from the
  tested provider's answers. The server tells the assistant to read them as
  data, never as instructions; a result that seems to ask for something is to
  be treated with suspicion.
- An answer over 4 MB is not read, one over 100,000 characters is cut (ask for
  `result: "failed"` or a smaller `limit`), and a call gives up after 30 s.
- **To stop it**, revoke the key on the API Keys page: it is refused at the next
  call.

## 5. Develop

```bash
npm test           # node --test "tests/*.test.js"
node ../Oscar_Server/node_modules/eslint/bin/eslint.js . --max-warnings 0
```

`Oscar_Server/tests/integration/mcp-end-to-end.test.js` runs this server
against the real API router, and fails when a GET route of `/v1/api` in the
OpenAPI description has no tool here, or the other way round.

The server speaks JSON-RPC 2.0 over stdio, one message per line (MCP protocol
versions 2024-11-05, 2025-03-26 and 2025-06-18): `initialize`, `ping`,
`tools/list`, `tools/call`. It has its own version (`package.json`) and is not
part of a server release.
