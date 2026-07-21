"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { TerminalRepl } from "@/lib/terminal/repl";

const STORAGE_KEY = "tokenhub-proxy:proxy-api-key";

function getStoredKey(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null; // localStorage can throw in private-browsing/sandboxed contexts.
  }
}

function setStoredKey(key: string | null): void {
  try {
    if (key) window.localStorage.setItem(STORAGE_KEY, key);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Best-effort persistence; the session still works without it.
  }
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export default function TerminalConsole() {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: "'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
      fontSize: 14,
      theme: {
        background: "#0b0f14",
        foreground: "#e6edf3",
        cursor: "#58a6ff",
        selectionBackground: "#264f78",
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    fitAddon.fit();
    term.focus();

    const repl = new TerminalRepl({
      term,
      getProxyKey: getStoredKey,
      setProxyKey: setStoredKey,
      copyToClipboard,
    });
    repl.start();

    // Copy-on-select: Ctrl/Cmd+C copies an active selection to the OS
    // clipboard instead of being treated as the REPL's cancel/abort key.
    // Returning false tells xterm.js not to also forward the keystroke to
    // onData, so the two behaviors never both fire for the same press.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const isCopyChord = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c";
      if (isCopyChord && term.hasSelection()) {
        void copyToClipboard(term.getSelection());
        return false;
      }
      // Explicit paste chord as a fallback alongside xterm's native paste
      // handling, for contexts where the browser doesn't deliver a native
      // paste event to xterm's hidden textarea (e.g. it lost focus).
      const isPasteChord = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v";
      if (isPasteChord) {
        navigator.clipboard
          .readText()
          .then((text) => term.paste(text))
          .catch(() => {
            /* Clipboard read denied or unavailable; native paste may still work. */
          });
        return false;
      }
      return true;
    });

    const onDataDisposable = term.onData((data) => repl.handleData(data));

    const handleResize = () => fitAddon.fit();
    window.addEventListener("resize", handleResize);
    const resizeObserver = new ResizeObserver(handleResize);
    resizeObserver.observe(container);

    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
      onDataDisposable.dispose();
      term.dispose();
    };
  }, []);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%" }}
      aria-label="Interactive tokenhub-proxy command console"
    />
  );
}
