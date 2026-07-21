import { colors, highlightJson, sanitizeRawText } from "./ansi";

export interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

export interface CommandContext {
  write: (text: string) => void;
  writeln: (text: string) => void;
  getProxyKey: () => string | null;
  setProxyKey: (key: string | null) => void;
  signal: AbortSignal;
  clearScreen: () => void;
  getLastResponse: () => string;
  setLastResponse: (text: string) => void;
  copyToClipboard: (text: string) => Promise<boolean>;
  /** Switches to a masked prompt; resolves with the entered text on Enter
   * (never shown or recorded in history), or "" if cancelled with Ctrl+C. */
  promptSecret: (label: string) => Promise<string>;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  run(args: ParsedArgs, ctx: CommandContext): Promise<void>;
}

const DEFAULT_MODEL = "deepseek-v4-flash";

function textArg(args: ParsedArgs, fallback: string): string {
  return args.positional.join(" ") || fallback;
}

function buildBody(args: ParsedArgs, preset: Record<string, unknown>): unknown {
  if (typeof args.flags.raw === "string") {
    try {
      return JSON.parse(args.flags.raw);
    } catch (err) {
      throw new Error(`--raw is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return preset;
}

function maskKey(key: string): string {
  return key.length <= 4 ? "*".repeat(key.length) : `…${key.slice(-4)}`;
}

function requireAuth(ctx: CommandContext): boolean {
  if (ctx.getProxyKey()) return true;
  ctx.writeln(colors.error("No proxy API key set. Run: ") + colors.command("auth <your-proxy-api-key>"));
  return false;
}

async function callProxy(ctx: CommandContext, path: string, init: RequestInit = {}): Promise<Response> {
  const key = ctx.getProxyKey();
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json");
  if (key) headers.set("Authorization", `Bearer ${key}`);
  return fetch(path, { ...init, headers, signal: ctx.signal });
}

async function printJsonResponse(ctx: CommandContext, res: Response): Promise<void> {
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Non-JSON body (e.g. a bare "404 page not found"); display as raw text.
  }
  const pretty = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
  ctx.setLastResponse(pretty);
  ctx.writeln(
    res.ok ? colors.success(`✓ ${res.status} ${res.statusText}`) : colors.error(`✗ ${res.status} ${res.statusText}`),
  );
  ctx.writeln(typeof parsed === "string" ? sanitizeRawText(parsed) : highlightJson(parsed));
}

/** Reads a fetch Response body as newline-delimited SSE text, line by line. */
async function readSseLines(res: Response, onLine: (line: string) => void, signal: AbortSignal): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const flush = () => {
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      onLine(buf.slice(0, idx).replace(/\r$/, ""));
      buf = buf.slice(idx + 1);
    }
  };
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel();
        return;
      }
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      flush();
    }
    buf += decoder.decode();
    flush();
    if (buf.length) onLine(buf);
  } finally {
    reader.releaseLock();
  }
}

export const commands: Command[] = [
  {
    name: "chat",
    summary: "Chat completion — OpenAI-compatible, non-streaming",
    usage: 'chat ["message"] [--model NAME] [--max-tokens N] [--raw \'{...}\']',
    async run(args, ctx) {
      if (!requireAuth(ctx)) return;
      const preset = {
        model: (args.flags.model as string) || DEFAULT_MODEL,
        messages: [{ role: "user", content: textArg(args, "Say hello in one short sentence.") }],
        max_tokens: Number(args.flags["max-tokens"] ?? 60),
      };
      ctx.writeln(colors.muted("POST /v1/chat/completions"));
      const res = await callProxy(ctx, "/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(buildBody(args, preset)),
      });
      await printJsonResponse(ctx, res);
    },
  },
  {
    name: "chat.stream",
    summary: "Chat completion — OpenAI-compatible, streamed live token by token",
    usage: 'chat.stream ["message"] [--model NAME] [--max-tokens N]',
    async run(args, ctx) {
      if (!requireAuth(ctx)) return;
      const preset = {
        model: (args.flags.model as string) || DEFAULT_MODEL,
        messages: [{ role: "user", content: textArg(args, "Count from 1 to 3.") }],
        max_tokens: Number(args.flags["max-tokens"] ?? 80),
        stream: true,
      };
      ctx.writeln(colors.muted("POST /v1/chat/completions (stream)"));
      const res = await callProxy(ctx, "/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify(buildBody(args, preset)),
      });
      if (!res.ok) {
        await printJsonResponse(ctx, res);
        return;
      }
      ctx.writeln(colors.success(`✓ ${res.status} streaming…`));
      let full = "";
      await readSseLines(
        res,
        (line) => {
          if (!line.startsWith("data: ")) return;
          const payload = line.slice(6);
          if (payload === "[DONE]") return;
          try {
            const chunk = JSON.parse(payload);
            const delta = chunk.choices?.[0]?.delta?.content;
            if (typeof delta === "string" && delta.length) {
              full += delta;
              ctx.write(sanitizeRawText(delta));
            }
          } catch {
            // Ignore non-JSON keep-alive/partial lines.
          }
        },
        ctx.signal,
      );
      ctx.write("\n");
      ctx.setLastResponse(full);
    },
  },
  {
    name: "messages",
    summary: "Messages — Anthropic-compatible, non-streaming",
    usage: 'messages ["message"] [--model NAME] [--max-tokens N] [--raw \'{...}\']',
    async run(args, ctx) {
      if (!requireAuth(ctx)) return;
      const preset = {
        model: (args.flags.model as string) || DEFAULT_MODEL,
        max_tokens: Number(args.flags["max-tokens"] ?? 60),
        messages: [{ role: "user", content: textArg(args, "Say hello in one short sentence.") }],
      };
      ctx.writeln(colors.muted("POST /v1/messages"));
      const res = await callProxy(ctx, "/v1/messages", {
        method: "POST",
        body: JSON.stringify(buildBody(args, preset)),
      });
      await printJsonResponse(ctx, res);
    },
  },
  {
    name: "messages.stream",
    summary: "Messages — Anthropic-compatible, streamed live token by token",
    usage: 'messages.stream ["message"] [--model NAME] [--max-tokens N]',
    async run(args, ctx) {
      if (!requireAuth(ctx)) return;
      const preset = {
        model: (args.flags.model as string) || DEFAULT_MODEL,
        max_tokens: Number(args.flags["max-tokens"] ?? 80),
        stream: true,
        messages: [{ role: "user", content: textArg(args, "Count from 1 to 3.") }],
      };
      ctx.writeln(colors.muted("POST /v1/messages (stream)"));
      const res = await callProxy(ctx, "/v1/messages", {
        method: "POST",
        body: JSON.stringify(buildBody(args, preset)),
      });
      if (!res.ok) {
        await printJsonResponse(ctx, res);
        return;
      }
      ctx.writeln(colors.success(`✓ ${res.status} streaming…`));
      let full = "";
      let currentEvent = "";
      await readSseLines(
        res,
        (line) => {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7);
            return;
          }
          if (!line.startsWith("data: ")) return;
          try {
            const payload = JSON.parse(line.slice(6));
            if (currentEvent === "content_block_delta" && payload?.delta?.type === "text_delta") {
              const text = String(payload.delta.text ?? "");
              full += text;
              ctx.write(sanitizeRawText(text));
            }
          } catch {
            // Ignore non-JSON lines (e.g. ping events with no data payload).
          }
        },
        ctx.signal,
      );
      ctx.write("\n");
      ctx.setLastResponse(full);
    },
  },
  {
    name: "embeddings",
    summary: "Text embedding",
    usage: 'embeddings ["text"] [--model NAME] [--raw \'{...}\']',
    async run(args, ctx) {
      if (!requireAuth(ctx)) return;
      const preset = {
        model: (args.flags.model as string) || "kinfra-text-embedding-0.6b",
        input: textArg(args, "hello world"),
      };
      ctx.writeln(colors.muted("POST /v1/embeddings"));
      const res = await callProxy(ctx, "/v1/embeddings", {
        method: "POST",
        body: JSON.stringify(buildBody(args, preset)),
      });
      await printJsonResponse(ctx, res);
    },
  },
  {
    name: "embeddings.multimodal",
    summary: "Multimodal (text/image/video) embedding — text-only preset",
    usage: 'embeddings.multimodal ["text"] [--model NAME] [--raw \'{...}\']',
    async run(args, ctx) {
      if (!requireAuth(ctx)) return;
      const preset = {
        model: (args.flags.model as string) || "kinfra-vl-embedding-2b",
        input: [{ type: "text", text: textArg(args, "hello world") }],
      };
      ctx.writeln(colors.muted("POST /v1/embeddings/multimodal"));
      const res = await callProxy(ctx, "/v1/embeddings/multimodal", {
        method: "POST",
        body: JSON.stringify(buildBody(args, preset)),
      });
      await printJsonResponse(ctx, res);
    },
  },
  {
    name: "translate",
    summary: "Machine translation",
    usage: 'translate ["text"] [--source xx] [--target yy] [--raw \'{...}\']',
    async run(args, ctx) {
      if (!requireAuth(ctx)) return;
      const preset = {
        model: (args.flags.model as string) || "hy-mt2-plus",
        text: textArg(args, "你好世界"),
        source: (args.flags.source as string) || "zh",
        target: (args.flags.target as string) || "en",
      };
      ctx.writeln(colors.muted("POST /v1/api/translations"));
      const res = await callProxy(ctx, "/v1/api/translations", {
        method: "POST",
        body: JSON.stringify(buildBody(args, preset)),
      });
      await printJsonResponse(ctx, res);
    },
  },
  {
    name: "models",
    summary: "List models/services visible to the proxy key",
    usage: "models",
    async run(_args, ctx) {
      if (!requireAuth(ctx)) return;
      ctx.writeln(colors.muted("GET /v1/models"));
      const res = await callProxy(ctx, "/v1/models", { method: "GET" });
      await printJsonResponse(ctx, res);
    },
  },
  {
    name: "batches.list",
    summary: "List batch jobs",
    usage: "batches.list",
    async run(_args, ctx) {
      if (!requireAuth(ctx)) return;
      ctx.writeln(colors.muted("GET /v1/batches"));
      const res = await callProxy(ctx, "/v1/batches", { method: "GET" });
      await printJsonResponse(ctx, res);
    },
  },
  {
    name: "batches.create",
    summary: "Create a batch job (⚠ request schema is not publicly documented)",
    usage: "batches.create [--raw '{...}']",
    async run(args, ctx) {
      if (!requireAuth(ctx)) return;
      ctx.writeln(colors.error("⚠ TokenHub does not publicly document this endpoint's request schema."));
      ctx.writeln(colors.muted("Sending a best-effort guess modeled on the OpenAI Batch API shape — it may fail."));
      const preset = { endpoint: "/v1/chat/completions", completion_window: "24h", input_file_id: "REPLACE_ME" };
      ctx.writeln(colors.muted("POST /v1/batches"));
      const res = await callProxy(ctx, "/v1/batches", {
        method: "POST",
        body: JSON.stringify(buildBody(args, preset)),
      });
      await printJsonResponse(ctx, res);
    },
  },
  {
    name: "batches.get",
    summary: "Retrieve a batch job by id",
    usage: "batches.get <id>",
    async run(args, ctx) {
      if (!requireAuth(ctx)) return;
      const id = args.positional[0];
      if (!id) {
        ctx.writeln(colors.error("Usage: batches.get <id>"));
        return;
      }
      ctx.writeln(colors.muted(`GET /v1/batches/${id}`));
      const res = await callProxy(ctx, `/v1/batches/${encodeURIComponent(id)}`, { method: "GET" });
      await printJsonResponse(ctx, res);
    },
  },
  {
    name: "plan.messages",
    summary: "Messages via the TokenPlan surface (needs TOKENHUB_PLAN_API_KEY server-side)",
    usage: 'plan.messages ["message"] [--model NAME] [--max-tokens N]',
    async run(args, ctx) {
      if (!requireAuth(ctx)) return;
      const preset = {
        model: (args.flags.model as string) || DEFAULT_MODEL,
        max_tokens: Number(args.flags["max-tokens"] ?? 60),
        messages: [{ role: "user", content: textArg(args, "Say hello in one short sentence.") }],
      };
      ctx.writeln(colors.muted("POST /plan/anthropic/v1/messages"));
      const res = await callProxy(ctx, "/plan/anthropic/v1/messages", {
        method: "POST",
        body: JSON.stringify(buildBody(args, preset)),
      });
      await printJsonResponse(ctx, res);
    },
  },
  {
    name: "endpoints",
    summary: "List every mapped TokenHub endpoint (no auth required)",
    usage: "endpoints",
    async run(_args, ctx) {
      const res = await fetch("/api/endpoints");
      const data = await res.json();
      ctx.writeln(highlightJson(data));
    },
  },
  {
    name: "auth",
    summary: "Set, clear, or check the proxy API key used for requests",
    usage: "auth set (hidden prompt) | auth <key> (visible) | auth clear | auth",
    async run(args, ctx) {
      const sub = args.positional[0];
      if (!sub) {
        const key = ctx.getProxyKey();
        ctx.writeln(
          key
            ? colors.success(`Authenticated (key ending "${maskKey(key)}")`)
            : colors.error("Not authenticated. Run: auth set"),
        );
        return;
      }
      if (sub === "clear") {
        ctx.setProxyKey(null);
        ctx.writeln(colors.muted("Proxy key cleared."));
        return;
      }
      if (sub === "set") {
        const key = await ctx.promptSecret("Proxy API key (hidden)");
        if (!key) {
          ctx.writeln(colors.muted("Cancelled."));
          return;
        }
        ctx.setProxyKey(key);
        ctx.writeln(colors.success(`Proxy key set (ending "${maskKey(key)}"). Stored in this browser only.`));
        return;
      }
      // Inline form: convenient, but the key is visible in the terminal
      // transcript/scrollback as it's typed — same tradeoff as any CLI tool
      // that accepts a secret as a plain argument.
      ctx.setProxyKey(sub);
      ctx.writeln(colors.success(`Proxy key set (ending "${maskKey(sub)}"). Stored in this browser only.`));
      ctx.writeln(colors.muted('Tip: "auth set" prompts for the key without echoing it to the screen.'));
    },
  },
  {
    name: "copy",
    summary: "Copy the last response body to the OS clipboard",
    usage: "copy",
    async run(_args, ctx) {
      const last = ctx.getLastResponse();
      if (!last) {
        ctx.writeln(colors.error("Nothing to copy yet."));
        return;
      }
      const ok = await ctx.copyToClipboard(last);
      ctx.writeln(
        ok ? colors.success("Copied last response to clipboard.") : colors.error("Clipboard write failed."),
      );
    },
  },
  {
    name: "clear",
    summary: "Clear the screen",
    usage: "clear",
    async run(_args, ctx) {
      ctx.clearScreen();
    },
  },
  {
    name: "help",
    summary: "List commands, or show usage for one",
    usage: "help [command]",
    async run(args, ctx) {
      const target = args.positional[0];
      if (target) {
        const cmd = commands.find((c) => c.name === target);
        if (!cmd) {
          ctx.writeln(colors.error(`Unknown command: ${target}`));
          return;
        }
        ctx.writeln(`${colors.heading(cmd.name)}  ${cmd.summary}`);
        ctx.writeln(colors.muted(cmd.usage));
        return;
      }
      ctx.writeln(
        colors.heading("tokenhub-proxy console") +
          " — every command maps 1:1 to a proxy endpoint, with editable preset params.",
      );
      ctx.writeln("");
      const width = Math.max(...commands.map((c) => c.name.length)) + 2;
      for (const cmd of commands) {
        ctx.writeln(`  ${colors.command(cmd.name.padEnd(width))} ${cmd.summary}`);
      }
      ctx.writeln("");
      ctx.writeln(colors.muted("Every command accepts --raw '<json>' to fully override the preset body."));
      ctx.writeln(
        colors.muted("Keys: ↑/↓ history · Tab complete · Ctrl+C cancel/abort · Ctrl+C on a selection copies it"),
      );
      ctx.writeln(colors.muted("      Ctrl+V / ⌘V pastes · drag-select then Ctrl/⌘+C copies to the OS clipboard"));
    },
  },
];
