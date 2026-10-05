# Security policy

## Reporting a vulnerability

Please **don't open a public issue** for security problems. Report them privately with GitHub's **[Report a vulnerability](https://github.com/shubhamyadav8901/hotels-mcp/security/advisories/new)** form (Security tab → Advisories).

Include what you found, how to reproduce it, and the impact you expect. You'll get an acknowledgement as soon as the maintainers can respond. Please allow reasonable time for a fix before any public disclosure.

## Deployment note

The HTTP mode (`--http`, the Docker image) has **no authentication**. Keep it on localhost or a private network; if you expose it through a tunnel, put your own access control in front of it. By default it binds `127.0.0.1` (`HOST`); the Docker image binds `0.0.0.0` inside the container, and the bundled compose file publishes it only on `127.0.0.1:3001`. DNS-rebinding protection rejects requests whose `Host` hostname is neither a loopback name (`localhost`, `127.0.0.1`, `[::1]`, always accepted) nor listed in `ALLOWED_HOSTS`; the port is ignored. `PROVIDER_DEADLINE_MS` (default 20000) caps how long each source may take per search. The stdio mode is only reachable by the client that starts it.

## Scope

In scope: the MCP server (`src/`), its Docker image and configuration, and the data-build scripts (`scripts/`). Examples:

- bypassing the `Host`-header (DNS-rebinding) check
- reaching a non-allow-listed (for example booking or payment) tool on an upstream MCP server
- prompt injection through upstream text that escapes its labelled data field (instructions, markup or images passed through to the model)
- code execution through crafted upstream responses (parsers must never `eval`)
- secrets (such as `SERPAPI_KEY`) ending up in logs or responses
- server-side request forgery through configurable endpoints or tool arguments
- denial of service through unbounded work (large matrices, unbounded upstream fan-out)

Out of scope: vulnerabilities in third-party services the server queries (report those to the service), the lack of authentication in HTTP mode (documented above), and reports that only show a price, location or distance is wrong (use the Data error issue template).

## Supported versions

Only the latest release on `main` gets security fixes.
