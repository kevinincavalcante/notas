import type { Metadata } from "next";
import "./globals.css";
import { UIProvider } from "@/components/UIProvider";
import VaultProvider from "@/components/VaultProvider";

export const metadata: Metadata = {
  title: "Knotas - Gerenciador Pessoal",
  description: "Gerenciador pessoal de notas estilo Google Keep de alta performance",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR">
      <body className="antialiased"><UIProvider><VaultProvider>{children}</VaultProvider></UIProvider></body>
    </html>
  );
}
