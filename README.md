# OpenScope

**OpenScope: Real-Time Visualization for Monitoring and Steering Open Code Harness**

Web dashboard for **[OpenCode](https://opencode.ai/)**. It connects to a local OpenCode HTTP server (REST + Server-Sent Events) so you can work across directories, inspect live message streams, todos, planner-style subtasks, and agent action-flow diagrams—with cross-links between todos, transcripts, and individual flow glyphs.

---

## What's included

- **Multi-directory sessions** via `x-opencode-directory`, aligned with how OpenCode labels workspaces from the CLI.
- **Realtime harness UI**: streamed assistant turns, todos and `todo_write` batch replay, approve/reject for question tooling.
- **Subtask linkage**: optional connectors from todo rows into a linked card **or into the focused action** when one is selected.
- **Action-flow diagrams**: orthogonal / treemap layout (d3), type-based coloring, fork and deep-dive tooling.
- **Session operations**: rename, fork, SSE with polling fallback, optional outbound harness guidance prefix on user prompts.

---

## Installation & Running

### 1. Install the OpenCode CLI

OpenScope requires the OpenCode CLI running in HTTP headless mode.

Follow the **[upstream installation guide](https://opencode.ai/download), then verify the installation:

```bash
opencode --version
```



---

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

---

### 3. Configure Environment Variables

Create a local environment file:

```bash
cp .env.example .env.local
```

Then set the OpenCode server endpoint:

```env
VITE_OPENCODE_BASE=http://127.0.0.1:4096
```

| Variable | Description |
| --- | --- |
| `VITE_OPENCODE_BASE` | Base URL used for all OpenScope → OpenCode API requests. Must match the running OpenCode server address. |
| `VITE_OPENCODE_DEFAULT_MODEL` *(optional)* | Overrides the default bootstrap model using the format `provider/model`. If omitted, OpenCode's default model will be used. |

---

### 4. Install Dependencies & Start the UI

Install project dependencies:

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

---

## Repository layout

- **`src/App.tsx`** and **`src/components/`** wire sessions, transcripts, todos, connectors, dialogs, fullscreen views.
- **`src/services/opencodeApi.ts`** is the canonical HTTP/SSE client.
- **`src/utils/`** contains folder helpers, todo materialization, SSE parsing, **`MappedAction`** construction, grouping, and forks.
- **`docs/`** stores design/integration notes outside the runtime bundle.
- **`scripts/`** holds tooling such as `smoke-opencode-session.mjs` for probing a live daemon.

Treat the authoritative API contract as the pair **running `opencode serve`** + **`src/services/opencodeApi.ts`**.

---

## Tech stack

React 19 · TypeScript · Vite · Tailwind CSS 4 · d3 · react-tooltip
