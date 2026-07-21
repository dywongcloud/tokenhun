import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "tokenhub-proxy",
  description: "Interactive console for the TokenHub proxy",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
