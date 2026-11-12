import { app, BrowserWindow, shell, Menu } from "electron";
import http from "http";
import { join } from "path";
import { createClient } from "@libsql/client";
import "./env"; // PRIMEIRO: carrega a config antes de qualquer lib abrir client de banco
import { ensureSchema } from "../lib/db-schema";
import { startSyncLoop } from "../lib/sync-replica";
import { envSource, localDbPath, isDev } from "./env";

/**
 * Processo main do Notas (Electron):
 *
 * 1. Config carregada por ./env (primeiro import) — notas.env do usuário ou .env.local em dev
 * 2. Garante o schema da réplica local (SQLite em arquivo, offline-first)
 * 3. Sobe o app Next como sidecar IN-PROCESS (a mesma UI web, sem reescrita)
 * 4. Aponta a BrowserWindow pro servidor local — carregamentos instantâneos
 * 5. Roda o laço de sync em background (réplica ↔ Turso, backoff em falha)
 */

async function createWindow(url: string): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    title: "Notas",
    autoHideMenuBar: true,
    backgroundColor: "#0f172a",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "preload.cjs"),
    },
  });

  // Links de preview/notas abrem no navegador do sistema, não dentro do app
  win.webContents.setWindowOpenHandler(({ url: external }) => {
    shell.openExternal(external);
    return { action: "deny" };
  });

  installAppMenu(win);
  await win.loadURL(url);
  return win;
}

/**
 * Menu nativo com os atalhos de aba (estilo browser):
 *   Ctrl+N  nova aba (nova nota, sem fechar a atual)
 *   Ctrl+W  fecha a aba atual
 *   Ctrl+Tab / Ctrl+Shift+Tab  próxima / anterior
 * Os comandos vão por IPC pro renderer (page.tsx cuida do estado das abas).
 * O menu fica escondido (autoHideMenuBar) — os atalhos continuam valendo.
 */
function installAppMenu(win: BrowserWindow): void {
  const send = (cmd: string) => () => win.webContents.send("tabs-command", cmd);

  const menu = Menu.buildFromTemplate([
    {
      label: "Arquivo",
      submenu: [
        { label: "Nova aba (nova nota)", accelerator: "CmdOrCtrl+N", click: send("new") },
        { label: "Fechar aba", accelerator: "CmdOrCtrl+W", click: send("close") },
        { type: "separator" },
        { role: "quit", label: "Sair" },
      ],
    },
    {
      label: "Editar",
      submenu: [
        { role: "undo", label: "Desfazer" },
        { role: "redo", label: "Refazer" },
        { type: "separator" },
        { role: "cut", label: "Cortar" },
        { role: "copy", label: "Copiar" },
        { role: "paste", label: "Colar" },
        { role: "selectAll", label: "Selecionar tudo" },
      ],
    },
    {
      label: "Abas",
      submenu: [
        { label: "Próxima aba", accelerator: "Ctrl+Tab", click: send("next") },
        { label: "Aba anterior", accelerator: "Shift+Ctrl+Tab", click: send("prev") },
      ],
    },
    {
      label: "Exibir",
      submenu: [
        { role: "reload", label: "Recarregar" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom", label: "Zoom padrão" },
        { role: "zoomIn", label: "Ampliar" },
        { role: "zoomOut", label: "Reduzir" },
      ],
    },
  ]);
  Menu.setApplicationMenu(menu);
}

/** Sobe o app Next em-processo (sidecar) e devolve a porta local. */
async function startNextServer(): Promise<number> {
  // `next` é CJS — interpolação segura do default em runtime (esbuild não tipa aqui)
  const nextModule = (await import("next")) as unknown as Record<string, unknown>;
  const nextFactory = (nextModule.default ?? nextModule) as (opts: {
    dev: boolean;
    dir: string;
  }) => {
    prepare: () => Promise<void>;
    getRequestHandler: () => (req: http.IncomingMessage, res: http.ServerResponse) => void;
  };

  const dir = isDev ? process.cwd() : app.getAppPath();
  const nextApp = nextFactory({ dev: false, dir });
  await nextApp.prepare();

  const handle = nextApp.getRequestHandler();
  const server = http.createServer((req, res) => {
    handle(req, res);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  return typeof address === "object" && address ? address.port : 3000;
}

app.whenReady().then(async () => {
  console.log(`[Notas] config: ${envSource} | banco local: ${localDbPath}`);

  try {
    // 1. Schema da réplica local (idempotente — seguro a cada boot)
    const localClient = createClient({ url: `file:${localDbPath}` });
    await ensureSchema(localClient);

    // 2. Sync em background: réplica local ↔ Turso remoto
    const remoteUrl = process.env.TURSO_URL || process.env.TURSO_LINK || "";
    const remoteToken = process.env.TURSO_TOKEN || process.env.TURSO_AUTH_TOKEN || "";
    if (remoteUrl && remoteToken) {
      const remote = createClient({ url: remoteUrl, authToken: remoteToken });
      startSyncLoop(localClient, remote, {
        intervalMs: 30_000,
        onSync: (r) => {
          if (r.pushedNotes || r.pulledNotes || r.appliedTombstones || r.conflicts.length) {
            console.log(
              `[SYNC] pushed=${r.pushedNotes} pulled=${r.pulledNotes} tombs=${r.appliedTombstones} conflitos=${r.conflicts.length}`
            );
          }
        },
      });
      console.log("[SYNC] laço iniciado (30s + backoff)");
    } else {
      console.warn("[SYNC] sem TURSO_LINK/TURSO_TOKEN — app roda 100% local, sem sincronizar");
    }

    // 3. Sidecar Next + janela
    const port = await startNextServer();
    await createWindow(`http://127.0.0.1:${port}`);
  } catch (err) {
    console.error("[Notas] falha ao iniciar:", err);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
