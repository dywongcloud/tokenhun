import { colors, highlightInputLine } from "./ansi";
import { commands, type CommandContext, type ParsedArgs } from "./commands";

/** Minimal surface this module needs from xterm.js's Terminal, kept small
 * and dependency-free so the REPL logic is testable without a real DOM. */
export interface TermLike {
  write(data: string): void;
  clear(): void;
}

export interface ReplOptions {
  term: TermLike;
  getProxyKey: () => string | null;
  setProxyKey: (key: string | null) => void;
  copyToClipboard: (text: string) => Promise<boolean>;
}

/** Splits a command line into tokens, respecting single/double quotes. */
export function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let sawAny = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && line[i + 1] === quote) {
        cur += quote;
        i++;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      sawAny = true;
      continue;
    }
    if (ch === " " || ch === "\t") {
      if (sawAny || cur.length) {
        tokens.push(cur);
        cur = "";
        sawAny = false;
      }
      continue;
    }
    cur += ch;
    sawAny = true;
  }
  if (sawAny || cur.length) tokens.push(cur);
  return tokens;
}

/** Splits tokens (after the command name) into positional args and --flags. */
export function parseArgs(tokens: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("--") && t.length > 2) {
      const eq = t.indexOf("=");
      if (eq !== -1) {
        flags[t.slice(2, eq)] = t.slice(eq + 1);
        continue;
      }
      const next = tokens[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[t.slice(2)] = next;
        i++;
      } else {
        flags[t.slice(2)] = true;
      }
      continue;
    }
    positional.push(t);
  }
  return { positional, flags };
}

function longestCommonPrefix(strs: string[]): string {
  if (strs.length === 0) return "";
  let prefix = strs[0];
  for (const s of strs.slice(1)) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  }
  return prefix;
}

const BANNER = [
  `${colors.heading("tokenhub-proxy")} interactive console — type ${colors.command("help")} to list commands.`,
  `Run ${colors.command("auth set")} first to set the proxy API key used for requests (stored in this browser only).`,
  "",
].join("\n");

export class TerminalRepl {
  private buffer = "";
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private pendingLines: string[] = [];
  private pendingTypeAhead = "";
  private busy = false;
  private abortController: AbortController | null = null;
  private lastResponse = "";
  private readonly prompt = `${colors.heading("tokenhub")} ${colors.muted("❯")} `;
  private secretResolve: ((value: string) => void) | null = null;
  private secretLabel = "";

  constructor(private opts: ReplOptions) {}

  start(): void {
    this.opts.term.write(BANNER + "\n");
    this.render();
  }

  /** Feed raw data from xterm.js's onData event. Call while not disposed. */
  handleData(data: string): void {
    if (this.secretResolve) {
      this.handleSecretData(data);
      return;
    }
    if (this.busy) {
      if (data === "\x03") {
        this.abortController?.abort();
        return;
      }
      // Type-ahead: don't silently drop keystrokes typed while a command is
      // running. Only plain printable/pasted text is queued (not control
      // sequences like arrow keys, whose meaning depends on a buffer state
      // that doesn't exist yet); it's spliced into the input once idle.
      if (data.length >= 1 && !data.startsWith("\x1b") && data !== "\r" && data !== "\x7f") {
        this.pendingTypeAhead += data;
      }
      return;
    }
    if (data.length > 1 && !data.startsWith("\x1b")) {
      this.insertText(data);
      return;
    }
    switch (data) {
      case "\r":
        this.submit();
        return;
      case "\x7f":
        this.backspace();
        return;
      case "\x03":
        this.handleCtrlC();
        return;
      case "\f": // Ctrl+L
        this.opts.term.clear();
        this.render();
        return;
      case "\x01": // Ctrl+A
        this.cursor = 0;
        this.render();
        return;
      case "\x05": // Ctrl+E
        this.cursor = this.buffer.length;
        this.render();
        return;
      case "\v": // Ctrl+K
        this.buffer = this.buffer.slice(0, this.cursor);
        this.render();
        return;
      case "\x15": // Ctrl+U
        this.buffer = this.buffer.slice(this.cursor);
        this.cursor = 0;
        this.render();
        return;
      case "\t":
        this.completeTab();
        return;
      case "\x1b[A":
        this.historyMove(-1);
        return;
      case "\x1b[B":
        this.historyMove(1);
        return;
      case "\x1b[C":
        if (this.cursor < this.buffer.length) {
          this.cursor++;
          this.render();
        }
        return;
      case "\x1b[D":
        if (this.cursor > 0) {
          this.cursor--;
          this.render();
        }
        return;
      case "\x1b[H":
      case "\x1b[1~":
        this.cursor = 0;
        this.render();
        return;
      case "\x1b[F":
      case "\x1b[4~":
        this.cursor = this.buffer.length;
        this.render();
        return;
      case "\x1b[3~":
        if (this.cursor < this.buffer.length) {
          this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
          this.render();
        }
        return;
      default:
        if (data.length === 1 && data >= " ") this.insertText(data);
        return;
    }
  }

  private insertText(text: string): void {
    const parts = text.split(/\r\n|\r|\n/);
    this.buffer = this.buffer.slice(0, this.cursor) + parts[0] + this.buffer.slice(this.cursor);
    this.cursor += parts[0].length;
    if (parts.length > 1) {
      // A multi-line paste: queue the remaining lines to run sequentially,
      // each after the previous command finishes, mirroring how a real
      // terminal executes a pasted block of commands one at a time.
      this.pendingLines.push(...parts.slice(1));
      this.submit();
      return;
    }
    this.render();
  }

  private backspace(): void {
    if (this.cursor === 0) return;
    this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
    this.cursor--;
    this.render();
  }

  private handleCtrlC(): void {
    this.opts.term.write("^C\n");
    this.buffer = "";
    this.cursor = 0;
    this.pendingLines = [];
    this.render();
  }

  private historyMove(delta: number): void {
    if (this.history.length === 0) return;
    const next = this.historyIndex + delta;
    if (next < 0) return;
    if (next >= this.history.length) {
      this.historyIndex = this.history.length;
      this.buffer = "";
      this.cursor = 0;
      this.render();
      return;
    }
    this.historyIndex = next;
    this.buffer = this.history[next];
    this.cursor = this.buffer.length;
    this.render();
  }

  private completeTab(): void {
    const before = this.buffer.slice(0, this.cursor);
    if (before.includes(" ")) return;
    const matches = commands.map((c) => c.name).filter((n) => n.startsWith(before));
    if (matches.length === 0) return;
    const lcp = longestCommonPrefix(matches);
    if (lcp.length > before.length) {
      // Complete as far as unambiguous (bash-style); only append a trailing
      // space once a single exact command is identified.
      const completion = matches.length === 1 ? lcp + " " : lcp;
      this.buffer = completion + this.buffer.slice(this.cursor);
      this.cursor = completion.length;
      this.render();
      return;
    }
    if (matches.length > 1) {
      this.opts.term.write("\n" + matches.join("  ") + "\n");
      this.render();
    }
  }

  private async submit(): Promise<void> {
    const line = this.buffer;
    this.buffer = "";
    this.cursor = 0;
    this.opts.term.write("\n");
    if (line.trim().length > 0) {
      this.history.push(line);
      this.historyIndex = this.history.length;
      await this.execute(line);
    }
    const next = this.pendingLines.shift();
    if (next !== undefined) {
      this.buffer = next;
      this.cursor = next.length;
      await this.submit();
      return;
    }
    this.render();
  }

  private async execute(line: string): Promise<void> {
    const tokens = tokenize(line);
    const name = tokens[0];
    const cmd = commands.find((c) => c.name === name);
    if (!cmd) {
      this.opts.term.write(
        colors.error(`Unknown command: ${name}. `) + `Type ${colors.command("help")} for a list.\n`,
      );
      return;
    }
    const args = parseArgs(tokens.slice(1));
    this.busy = true;
    this.abortController = new AbortController();
    const ctx: CommandContext = {
      write: (t) => this.opts.term.write(t),
      writeln: (t) => this.opts.term.write(t + "\n"),
      getProxyKey: this.opts.getProxyKey,
      setProxyKey: this.opts.setProxyKey,
      signal: this.abortController.signal,
      clearScreen: () => this.opts.term.clear(),
      getLastResponse: () => this.lastResponse,
      setLastResponse: (t) => {
        this.lastResponse = t;
      },
      copyToClipboard: this.opts.copyToClipboard,
      promptSecret: (label) => this.promptSecret(label),
    };
    try {
      await cmd.run(args, ctx);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        this.opts.term.write(colors.muted("(aborted)") + "\n");
      } else {
        const message = err instanceof Error ? err.message : String(err);
        this.opts.term.write(colors.error(`Error: ${message}`) + "\n");
      }
    } finally {
      this.busy = false;
      this.abortController = null;
      if (this.pendingTypeAhead) {
        this.buffer = this.pendingTypeAhead;
        this.cursor = this.buffer.length;
        this.pendingTypeAhead = "";
      }
    }
  }

  /** Switches to a masked single-line prompt; resolves with the entered
   * text on Enter (never recorded in history), or "" on Ctrl+C. */
  promptSecret(label: string): Promise<string> {
    return new Promise((resolve) => {
      this.secretLabel = `${label}: `;
      this.opts.term.write(this.secretLabel);
      this.secretResolve = resolve;
      this.buffer = "";
      this.cursor = 0;
    });
  }

  private handleSecretData(data: string): void {
    if (data === "\r") {
      const value = this.buffer;
      this.buffer = "";
      this.cursor = 0;
      this.opts.term.write("\n");
      const resolve = this.secretResolve!;
      this.secretResolve = null;
      resolve(value);
      return;
    }
    if (data === "\x03") {
      this.buffer = "";
      this.cursor = 0;
      this.opts.term.write("^C\n");
      const resolve = this.secretResolve!;
      this.secretResolve = null;
      resolve("");
      return;
    }
    if (data === "\x7f") {
      if (this.buffer.length > 0) {
        this.buffer = this.buffer.slice(0, -1);
        this.renderSecret();
      }
      return;
    }
    if (data.length >= 1 && !data.startsWith("\x1b")) {
      this.buffer += data.replace(/[\r\n]/g, "");
      this.renderSecret();
    }
  }

  private renderSecret(): void {
    this.opts.term.write("\x1b[2K\r" + this.secretLabel + "•".repeat(this.buffer.length));
  }

  private render(): void {
    this.opts.term.write("\x1b[2K\r" + this.prompt + highlightInputLine(this.buffer));
    const trailing = this.buffer.length - this.cursor;
    if (trailing > 0) this.opts.term.write(`\x1b[${trailing}D`);
  }
}
