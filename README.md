# VibeTrace: See how your agents think

**Visualizing Agent Runtime Behavior for Human Intervention in Vibe Coding**

A web dashboard for **[OpenCode](https://opencode.ai/)** that connects to a local OpenCode HTTP server (REST + Server-Sent Events), enabling developers to work across multiple directories while inspecting live message streams, todos, subtasks, and visualized agent execution flows. The system provides rich cross-linking between todos, transcripts, and individual action-flow blocks, supporting real-time monitoring, navigation, and intervention during agent runtime execution.

---

## UI preview

<p align="center">
<img src="./fig/timeline-view.png" alt="VibeTrace action-flow view" width="100%" />
</p>

---

## What's included

- **Action-flow visualization** — Orthogonal layout of mapped tool/agent steps, branching forks, contextual tooltips, and click-to-focus that ties the flow to todos and transcripts. **`Actions duration`** toggles between fixed step spacing and horizontally scaled blocks keyed to measured duration. **`Actions color`** switches the palette between **tokens** and **tool type** lenses. Toolbar **`timeline` / `summary`** changes how planner subtasks are arranged in the rail; fullscreen is available for the flow view.
- **Multi-directory sessions** via `x-opencode-directory`, aligned with how OpenCode labels workspaces from the CLI.
- **Realtime harness UI** — Streamed assistant turns, todos and `todo_write` batch replay, approve/reject for question tooling.
- **Subtask linkage** — Optional connectors from todo rows into a linked card **or into the focused action** when one is selected.
- **Session operations** — Rename, fork, SSE with polling fallback, optional outbound harness guidance prefix on user prompts.

---

## Installation & Running

Clone the repository and install UI dependencies first:

```bash
git clone <this-repo-url>
cd cockpit-ui
npm install
```

You also need **Python 3** on your machine for the memory-worker (`python` on Windows, `python3` on macOS/Linux).

### 1. Install the OpenCode CLI

VibeTrace requires the OpenCode CLI running in HTTP headless mode.

Follow the [upstream installation guide](https://opencode.ai/download), then verify the installation:

```bash
opencode --version
```

### 2. Start the OpenCode HTTP Server

Launch the server with:

```bash
opencode serve
```

By default, the server listens on an address similar to:

```txt
http://127.0.0.1:4096
```

If the port changes, make sure to update it in `.env.local` as well.

You can also specify a fixed port explicitly:

```bash
opencode serve --port 4096
```

### 3. Deploy OpenCode Tools

Copy the custom tool from this repo into OpenCode’s tools directory so agents can route to accumulated skills via `skill_router`:

| OS | Global tools directory |
| --- | --- |
| **Windows** | `%APPDATA%\opencode\tools\` |
| **macOS / Linux** | `~/.config/opencode/tools/` |

```bash
# macOS / Linux
mkdir -p ~/.config/opencode/tools
cp tools/skill_router.ts ~/.config/opencode/tools/skill_router.ts

# Windows PowerShell
New-Item -ItemType Directory -Force -Path "$env:APPDATA\opencode\tools" | Out-Null
Copy-Item tools\skill_router.ts "$env:APPDATA\opencode\tools\skill_router.ts"
```

When you work inside this repo, you can instead place the file at `<repo>/.opencode/tools/skill_router.ts` for project-scoped loading. No `npm install` is required under `plugins/` or `tools/` — OpenCode loads the `.ts` files directly.

### 4. Configure Environment Variables

Create a local environment file:

```bash
cp .env.example .env.local
```

Then set the OpenCode server endpoint (either name works; use one line):

```env
VITE_OPENCODE_BASE=http://127.0.0.1:4096
```

or the same value for the memory-worker:

```env
OPENCODE_BASE=http://127.0.0.1:4096
OPENCODE_PROXY_TARGET=http://127.0.0.1:4096
```

| Variable | Description |
| --- | --- |
| `VITE_OPENCODE_BASE` **or** `OPENCODE_BASE` | Base URL for all VibeTrace → OpenCode API calls. Vite merges **`VITE_OPENCODE_BASE` first**, then falls back to **`OPENCODE_BASE`**, then `http://127.0.0.1:4096`. Set both only if you intentionally want the UI to override the worker-only variable. |
| `VITE_MEMORY_WORKER_BASE` *(optional)* | Base URL for the Python memory-worker. Leave empty to use the Vite proxy to `http://127.0.0.1:8714`. |
| `VITE_OPENCODE_DEFAULT_MODEL` *(optional)* | Overrides the default bootstrap model using the format `provider/model`. If omitted, OpenCode's default model will be used. |
| `SKILL_WRITE_ROOT` *(optional)* | Where the memory-worker writes generated skills; see [Skills](#skills-where-they-are-read-and-written) below. |

Full field reference: [`.env.example`](./.env.example).

### 5. Install Dependencies & Start the UI

Install project dependencies (if you have not already):

```bash
npm install
```

Start the development server:

```bash
npm run dev
```

The frontend development server runs at:

```txt
http://localhost:5173
```

(See `vite.config.ts` for configuration details.)

Make sure the `opencode serve` process remains running while using the UI.

### 6. Start the memory-worker

In a **second terminal**, from the repo root:

```bash
npm run worker:py
```

The worker listens on **`http://127.0.0.1:8714`** by default. Trace ingest and the analyzer/writer pipeline require this process alongside the UI and `opencode serve`.

---

## One-shot startup (OpenCode plugin)

After you have completed [Installation & Running](#installation--running) (OpenCode CLI, Python 3, and `npm install`), you can switch to plugin mode so you no longer need separate terminals for `opencode serve`, `npm run dev`, and `npm run worker:py`.

> On first setup, configure the plugin once. After that, **launch OpenCode** and the plugin will start the UI (`:5173`), memory-worker (`:8714`), update `.env.local` proxies, and open the browser.

### Register the plugin

OpenCode loads plugins from **`opencode.json`**. Global config locations:

| OS | Global config path |
| --- | --- |
| **Windows** | `%APPDATA%\opencode\opencode.json` |
| **macOS / Linux** | `~/.config/opencode/opencode.json` |

Add a **`plugin`** entry pointing at this repo (use your **absolute path**):

**Windows example:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "D:/projects/cockpit-ui/plugins/agent-cockpit.ts"
  ]
}
```

**macOS example:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "/Users/you/projects/cockpit-ui/plugins/agent-cockpit.ts"
  ]
}
```

This repo’s root [`opencode.json`](./opencode.json) already registers `plugins/agent-cockpit.ts` with a **relative** path. If you start the OpenCode CLI from the **`cockpit-ui`** directory, that project-level config is enough and you may skip editing the global file.

**Fully quit and restart OpenCode.** You should see log lines similar to:

```txt
[VibeTrace] OpenCode API → http://127.0.0.1:xxxx
[VibeTrace] memory-worker ready
[VibeTrace] ready → http://127.0.0.1:5173
[VibeTrace] opening → http://127.0.0.1:5173
```

Open http://127.0.0.1:5173 if the browser does not open automatically.

### Deploy tools (plugin users)

Plugin mode does not replace the tools step: copy [`tools/skill_router.ts`](./tools/skill_router.ts) into the global tools directory as in [§3. Deploy OpenCode Tools](#3-deploy-opencode-tools), unless you only use this repo with a project-local `.opencode/tools/` copy.

### Environment variables (plugin mode)

Copy [`.env.example`](./.env.example) to `.env.local` if you have not already. The plugin **rewrites** OpenCode proxy targets, ports, and desktop auth fields automatically. You may still want to set:

| Variable | When to set |
| --- | --- |
| `SKILL_WRITE_ROOT` | Control where analyzed skills are written |
| `VITE_OPENCODE_DEFAULT_MODEL` | Default model when sending from VibeTrace (`provider/model`) |
| `VITE_TRACE_SESSION_TURN_LIMIT` | More history turns per ingest (default `5`) |
| `VIBETRACE_NO_BROWSER=1` | Do not auto-open the browser |
| `PYTHON` | Non-default Python executable name |

### Daily use (plugin mode)

1. Start the **OpenCode desktop app** (any project) or run `opencode` from `cockpit-ui`.
2. Use VibeTrace in the browser; trace ingest and skill evolution run in the background.
3. Do **not** run `npm run dev` or `npm run worker:py` manually.

---

## Skills: where they are read and written

**OpenCode reads skills** (loaded into sessions):

| Scope | Path |
| --- | --- |
| Current project | `<project-root>/.opencode/skills/` |
| User global | `~/.config/opencode/skills/` (Windows: `%USERPROFILE%\.config\opencode\skills\`) |

**Memory-worker writes skills** (after trace analysis):

| OS | Default (`SKILL_WRITE_ROOT` empty) |
| --- | --- |
| macOS / Linux | `~/.claude/skills/` |
| Windows | `%USERPROFILE%\.claude\skills\` |

To align writes with OpenCode’s global skill directory:

```env
# macOS
SKILL_WRITE_ROOT=/Users/you/.config/opencode/skills

# Windows
SKILL_WRITE_ROOT=C:\Users\you\.config\opencode\skills
```

---

## Consuming generated traces

Traces are produced automatically while you use OpenCode; no extra command is required.

**1. Live UI (primary)** — Open http://127.0.0.1:5173 (or http://localhost:5173 in manual mode). Pick a session to inspect messages, todos, and the action flow. After each assistant turn finishes with `finish: stop`, the UI builds **`trace.v1`** / **`trace.session.v1`** and POSTs to `/ingest-trace` (check the browser console for `[VibeTrace][memory-worker ingest ok]` and `runDir`).

**2. Analysis & skills** — The worker persists the trace, runs **Analyzer** against the skill pool, then **Writer** creates or updates files under **`SKILL_WRITE_ROOT`**. Later OpenCode sessions load those skills from the paths above (and via `skill_router` when deployed).

**3. On-disk run logs (debug / replay)** — Each ingest creates a folder under `memory_worker/logs/<runId>/` (gitignored), for example:

```txt
memory_worker/logs/<runId>/
  01-trace.json
  02-pool-summary.json
  05-skill-suggestions.json
  07-writer-result.json
  00-run.log
```

Pipeline details: [docs/memory-worker.md](./docs/memory-worker.md).

---

## Repository layout

- **`src/App.tsx`** and **`src/components/`** wire sessions, transcripts, todos, connectors, dialogs, fullscreen views.
- **`src/services/opencodeApi.ts`** is the canonical HTTP/SSE client.
- **`src/utils/`** contains folder helpers, todo materialization, SSE parsing, **`MappedAction`** construction, grouping, and forks.
- **`memory_worker/`** — Python ingest pipeline (auto-started in plugin mode); runtime logs in `memory_worker/logs/`.
- **`plugins/agent-cockpit.ts`** — OpenCode plugin for one-shot VibeTrace + worker startup.
- **`tools/skill_router.ts`** — Optional custom tool for skill routing.
- **`docs/`** stores design/integration notes outside the runtime bundle.
- **`fig/`** holds README imagery.

Treat the authoritative API contract as the pair **running `opencode serve`** + **`src/services/opencodeApi.ts`**.

| Component | Separate install? |
| --- | --- |
| Plugin + tools (`plugins/`, `tools/`) | No — OpenCode loads `.ts` directly |
| VibeTrace UI (`src/`) | Yes — `npm install` at repo root |
| memory-worker | Python 3 only |

---

## Tech stack

React 19 · TypeScript · Vite · Tailwind CSS 4 · d3 · react-tooltip

---

## License

[MIT](./LICENSE)
