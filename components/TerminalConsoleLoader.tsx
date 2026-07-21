"use client";

import dynamic from "next/dynamic";

// xterm.js touches the DOM as soon as it's instantiated, so it must never
// render during SSR. next/dynamic's ssr:false option is only valid from
// within a Client Component (Next.js 15), hence this thin wrapper around
// the actual TerminalConsole.
const TerminalConsole = dynamic(() => import("./TerminalConsole"), {
  ssr: false,
  loading: () => (
    <div style={{ color: "#8b949e", fontFamily: "monospace", padding: "1rem" }}>Loading console…</div>
  ),
});

export default function TerminalConsoleLoader() {
  return <TerminalConsole />;
}
