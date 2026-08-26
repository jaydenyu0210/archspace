# Security Policy

Archspace is a desktop application that runs user-authored workflows, spawns
plugin processes, and talks to MCP servers and AI providers on the user's
behalf. Several of its security properties are deliberate design decisions with
written trade-offs. This file states them plainly, so that a reporter can tell
a vulnerability from a documented boundary — and so that the ones that *are*
vulnerabilities get reported to the right place.

## Reporting a vulnerability

**Report privately. Do not open a public issue, discussion, or pull request.**

Use GitHub private vulnerability reporting:

**https://github.com/archspace/archspace/security/advisories/new**

Reports there stay private to the maintainers until an advisory is published. If you cannot use it — for example, you do not have a
GitHub account — say so in a Discussion **without any detail about the issue**
and a maintainer will arrange another channel.

### What to include

The more of this you can give, the faster it moves:

- What an attacker gains, and what they need in order to get it (a downloaded
  workflow file? an installed plugin? a network position? local user access?).
- Steps to reproduce, ideally headless: `pnpm cli run <workflow>` reproduces
  most engine, document, node, MCP, and plugin behaviour with no Electron in
  the way, and prints the run event stream.
- The workflow document if one is involved. By design it contains no filesystem
  paths, no URLs, and no credentials (ADR-0009 §1), so it is normally safe to
  attach as-is — check anyway.
- Affected version or commit, and your macOS version.
- Any proof-of-concept, and whether you have disclosed it anywhere.

Please do **not** include real credentials, API keys, or client project data in
a report. Redact them; we do not need them to reproduce.

### What to expect

Archspace is a small project, so these are honest targets rather than a
contractual SLA:

| Stage | Target |
|---|---|
| Acknowledgement that a human has read it | 3 business days |
| An initial assessment — in scope or not, and severity | 10 business days |
| Fix or a dated plan for one | depends on severity; you will be told which |

We will keep you updated as the work progresses, tell you plainly if we decide
something is not a vulnerability (with the reasoning), and credit you in the
advisory unless you ask us not to. We ask that you give us a reasonable window
to ship a fix before disclosing publicly, and we will not take legal action
against good-faith research that follows this policy.

## Supported versions

Archspace is pre-1.0. **Only the latest release and `main` are supported.**
Fixes land on `main` and ship in the next release; there are no backports to
earlier 0.x releases. Releases are distributed through GitHub Releases, signed
with a Developer ID certificate and notarized by Apple (ADR-0012) — a build that Gatekeeper rejects did not come from us, and that
itself is worth reporting.

## Scope

**In scope:** the contents of this repository — the Electron shell (main,
preload, renderer), the engine, the document format and its parser, the node
registry and built-in nodes, the AI gateway, the MCP host, the plugin host and
its capability mediation, the CLI, the first-party plugin, and the packaging
and update path.

Specifically wanted:

- Anything that escapes the renderer sandbox or reaches main outside the
  preload bridge's typed surface.
- Anything that makes an **opened document or project** cause code execution,
  a network call, or a filesystem write without the consent flow that is
  supposed to gate it.
- Any path by which a **secret** reaches a workflow document, a wire value, a
  log, an event stream, a crash report, or a plugin that did not declare and
  receive it.
- A plugin obtaining a capability it did not declare and the user did not
  grant, or reaching another plugin, the project tree, or the raw MCP client.
- Anything in the update path that would let a non-Archspace artifact be
  installed as an update.
- Parser and deserialization flaws in the workflow document, plugin manifests,
  MCP tool schemas, or settings files.

**Out of scope:** vulnerabilities in third-party dependencies with no
demonstrated impact on Archspace (report those upstream; tell us if we ship a
vulnerable version); findings that require an attacker who already has code
execution as the user; social-engineering a user into installing a malicious
plugin or configuring a malicious MCP server (see below — that is the
documented model, not a bypass); missing hardening flags with no exploit path;
and automated-scanner output with no analysis attached.

## Known and intentional security properties

These are decisions with recorded reasoning. They are stated here so a reporter
knows they are *known* — not so that a real bypass of them is dismissed.

### The plugin boundary is fault isolation, not a sandbox

This is the honesty clause from
[ADR-0008 §3](docs/adr/0008-plugin-boundary.md), and it is the single most
important thing to understand before reporting:

> v1 is **fault isolation + permission mediation**, not a hardened sandbox — a
> malicious native dependency can do what the user can do.

Concretely: each plugin package runs as its own OS child process of the engine
host, and its `NodeContext` calls are mediated — declared inputs and params,
content-addressed asset reads with engine-committed writes, only the secrets it
declared and was granted, `ctx.ai`, `fetch` only if it declared `net` **and**
was granted it, plus logs, progress, and a temp directory. It cannot reach the
project tree, arbitrary filesystem, the renderer, Electron, other plugins, or
the raw MCP client. Permissions are declared in `archspace-plugin.json` and
consented to at install time, in front of a real window; installing is not the
same as granting, and a plugin containing native binaries says so on the
consent sheet.

But that mediation is the Archspace API surface, not an OS boundary. **A plugin
process runs with the user's own authority.** Native code inside a plugin — or
any dependency it pulls in — can read the user's files and open sockets
regardless of what its manifest declares. Install plugins only from sources you
trust. OS-level sandboxing (seatbelt profiles) is a planned hardening
milestone, made possible by plugins already being out of process; it is not
shipped.

So: "a plugin can do bad things" is the documented model. **"A plugin can do
something the consent sheet said it could not, without native code" is a
vulnerability** — please report it.

### A configured MCP server is code the user chose to run

Workflows reference MCP servers by **logical name** (`revit`, `formats`). The
binding — the command, the URL, the credentials — lives only in the user's own
machine settings, never in the workflow document
([ADR-0009 §1](docs/adr/0009-mcp-integration.md)). That split is a security
boundary: a cloned repository can *request* a server named `revit`, but only
your settings decide what `revit` runs, and a project that suggests bindings
triggers an explicit consent flow rather than being auto-trusted.

Downstream of that consent, an MCP server is an ordinary program the user
launched (stdio) or a remote service they authorized (Streamable HTTP with
OAuth 2.1/PKCE, tokens held in the OS keychain). Archspace does not sandbox it
and cannot vouch for it: its `tools/list` output becomes nodes, and its tool
implementations run with whatever authority the user gave them. Tool
annotations such as `readOnlyHint` are treated as untrusted advisory hints —
they never affect cache correctness.

**A document, a project file, or a remote server causing a binding to be
created, changed, or used without that consent flow is a vulnerability.**

### The renderer is fully sandboxed

The window runs with `contextIsolation: true`, `sandbox: true`, and
`nodeIntegration: false`, and reaches the main process only through the preload
bridge (`window.archspace`, typed by
`packages/app/src/shared/protocol.ts`). Main owns the filesystem and the
keychain. Anything that gets Node or Electron capability into renderer context,
or reaches main outside that typed surface, is in scope and wanted.

### Workflows are data

There is no `eval` and there are no expressions in v1 (ARCHITECTURE §12); the
lint config enforces `no-eval` / `no-implied-eval` / `no-new-func` repo-wide to
keep that promise honest. Any way to get a workflow document to evaluate code
is a vulnerability.

### Secrets

Secrets live in the OS keychain via Electron's `safeStorage`, in the main
process only, and are write-only from the renderer's point of view. They are
**never** written into workflow documents and never travel on wires. If the
keychain is unavailable, secrets are refused rather than stored in the clear.
Any leak of a secret into a document, wire value, log line, event stream, or an
undeclared plugin is in scope.

### macOS packaging

The shipped app runs with the **hardened runtime on and the App Sandbox off**,
signed with a Developer ID certificate and notarized
([ADR-0012](docs/adr/0012-macos-packaging.md)). The App Sandbox is off because
it would forbid the things the product is: spawning stdio MCP servers, running
one child process per plugin, and opening user-chosen project directories. This
is a documented trade-off, not an oversight; the security story is the process
and permission architecture above, stated honestly rather than as a checkbox.

### Telemetry

There is none by default, and none is added silently. If you find Archspace
sending data anywhere the user did not configure — a provider, an MCP server,
or the update endpoint — that is a vulnerability, and an urgent one.

## After a report

Confirmed issues are fixed on `main`, released, and published as a GitHub
Security Advisory naming the affected versions, the impact, and the reporter
(unless anonymity is requested). If a fix changes a decision recorded in
`docs/adr/`, it ships with a new ADR explaining what changed and why — the
decision record is expected to stay true, including about security.
