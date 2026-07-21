// 256-color ANSI SGR helpers for terminal output, plus a JSON pretty-printer
// that colorizes via JSON.stringify-escaped text. Using JSON.stringify as the
// base for every string leaf is a safety property, not just a formatting
// choice: it escapes all control characters (including a raw ESC byte)
// into literal `\u00xx` text, so upstream/model-controlled content can never
// smuggle a live terminal escape sequence through highlightJson().
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

function fg(code: number) {
  return (text: string) => `\x1b[38;5;${code}m${text}${RESET}`;
}

export const colors = {
  key: fg(75), // soft blue
  string: fg(114), // green
  number: fg(215), // amber
  boolean: fg(176), // magenta
  null: fg(244), // grey
  punct: (text: string) => `${DIM}${text}${RESET}`,
  error: fg(203), // red
  success: fg(120), // bright green
  heading: fg(81), // cyan
  muted: fg(240), // dim grey
  command: fg(51), // bright cyan (input-line command word)
  flag: fg(208), // orange (input-line --flag)
};

const MAX_ARRAY_ITEMS = 8;
const INDENT = "  ";

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean";
}

function renderValue(value: unknown, depth: number): string {
  if (value === null) return colors.null("null");
  if (typeof value === "boolean") return colors.boolean(String(value));
  if (typeof value === "number") return colors.number(String(value));
  if (typeof value === "string") return colors.string(JSON.stringify(value));
  if (Array.isArray(value)) return renderArray(value, depth);
  if (typeof value === "object") return renderObject(value as Record<string, unknown>, depth);
  return colors.muted(JSON.stringify(String(value)));
}

function renderArray(arr: unknown[], depth: number): string {
  if (arr.length === 0) return colors.punct("[]");
  const pad = INDENT.repeat(depth + 1);
  const closePad = INDENT.repeat(depth);
  const truncate = arr.every(isPrimitive) && arr.length > MAX_ARRAY_ITEMS;
  const items = truncate ? arr.slice(0, MAX_ARRAY_ITEMS) : arr;
  const lines = items.map((v) => pad + renderValue(v, depth + 1));
  if (truncate) lines.push(pad + colors.muted(`… ${arr.length - MAX_ARRAY_ITEMS} more`));
  return (
    colors.punct("[") +
    "\n" +
    lines.join(colors.punct(",") + "\n") +
    "\n" +
    closePad +
    colors.punct("]")
  );
}

function renderObject(obj: Record<string, unknown>, depth: number): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return colors.punct("{}");
  const pad = INDENT.repeat(depth + 1);
  const closePad = INDENT.repeat(depth);
  const lines = keys.map(
    (k) => `${pad}${colors.key(JSON.stringify(k))}${colors.punct(":")} ${renderValue(obj[k], depth + 1)}`,
  );
  return (
    colors.punct("{") +
    "\n" +
    lines.join(colors.punct(",") + "\n") +
    "\n" +
    closePad +
    colors.punct("}")
  );
}

/** Pretty-print + colorize a JSON-decoded value for terminal display. */
export function highlightJson(value: unknown): string {
  return renderValue(value, 0);
}

/**
 * Escape raw control characters (including a literal ESC byte) in text that
 * is written to the terminal WITHOUT going through highlightJson's
 * JSON.stringify escaping — e.g. progressively streamed model output. \n,
 * \r, \t are left intact since they render safely and are expected in
 * multi-line streamed text.
 */
export function sanitizeRawText(text: string): string {
  return text.replace(
    /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g,
    (ch) => `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

/** Lightweight command-line syntax highlighting applied while the user types. */
export function highlightInputLine(line: string): string {
  let result = "";
  let firstWordSeen = false;
  const re = /(--[A-Za-z0-9-]+)|("(?:[^"\\]|\\.)*"?)|('(?:[^'\\]|\\.)*'?)|(\S+)|(\s+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    const [full, flag, dquote, squote, , ws] = m;
    if (ws !== undefined) {
      result += ws;
      continue;
    }
    if (flag) {
      result += colors.flag(full);
      continue;
    }
    if (dquote || squote) {
      result += colors.string(full);
      continue;
    }
    if (!firstWordSeen) {
      result += colors.command(full);
      firstWordSeen = true;
      continue;
    }
    result += full;
  }
  return result;
}
