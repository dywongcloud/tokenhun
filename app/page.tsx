import TerminalConsoleLoader from "@/components/TerminalConsoleLoader";

export default function Home() {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "#0b0f14",
        color: "#e6edf3",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      }}
    >
      <header style={{ padding: "0.75rem 1rem", borderBottom: "1px solid #1c2733", flexShrink: 0 }}>
        <strong>tokenhub-proxy</strong>
        <span style={{ color: "#8b949e" }}>
          {" "}
          — interactive console. Type <code>help</code> to list every mapped TokenHub endpoint, or{" "}
          <code>auth &lt;key&gt;</code> to set your proxy key. Requires JavaScript.
        </span>
      </header>
      <div style={{ flex: 1, minHeight: 0, padding: "0.5rem" }}>
        <TerminalConsoleLoader />
      </div>
    </main>
  );
}
