import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Notas - Gerenciador Pessoal",
  description: "Gerenciador pessoal de notas estilo Google Keep de alta performance",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body className="antialiased">{children}</body>
    </html>
  );
}
