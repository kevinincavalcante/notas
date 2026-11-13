import { app, BrowserWindow, ipcMain, shell, Menu } from "electron";
import http from "http";
import { join } from "path";
import { createClient } from "@libsql/client";
import "./bootstrap-env"; // PRIMEIRO: escreve notas-local.env (thin-client, sem Turso/R2)
import { writeSessionFile } from "./bootstrap-env";

import "./env"; // depois carrega tudo (ordem é contrato: libs abrem client no load)
import { ensureSchema } from "../lib/db-schema";
import { startSyncLoop } from "../lib/sync-replica";
import { syncOnceWith } from "../lib/sync-core";
import { makeHttpSyncRun } from "../lib/sync-http";
import type { SyncPush } from "../lib/sync-types";
import { getDesktopSessionToken } from "../lib/desktop-session";
import { envSource, localDbPath, isDev } from "./env";

/** Janela ativa — o sync envia o status pra ela via IPC. */
let mainWindow: BrowserWindow | null = null;

/* ---- Login: a MESMA página do web, servida pelo sidecar local.
   O /api/auth/login local repassa as credenciais pra API remota e grava o
   JWT no arquivo de sessão — nada de janela própria de login. ---- */

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

  mainWindow = win;
  setupApplicationMenu(win);

  // Links de preview/notas abrem no navegador do sistema, não dentro do app
  win.webContents.setWindowOpenHandler(({ url: external }) => {
    shell.openExternal(external);
    return { action: "deny" };
  });

  await win.loadURL(url);
  return win;
}

/** Menu do app com atalhos de teclado nativos pra gerenciar abas. */
function setupApplicationMenu(win: BrowserWindow) {
  const send = (cmd: string) => () => {
    if (!win.isDestroyed()) win.webContents.send("tabs-command", cmd);
  };

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

    // Token da sessão pro sidecar — SÓ depois do whenReady: safeStorage não
    // funciona no load do módulo, e o arquivo nasce vazio se gravar antes
    writeSessionFile();

    // 2. Sidecar primeiro: o login do desktop é a própria página /login do
    // app local (que repassa pra API remota) — precisa dela no ar pra janela
    const port = await startNextServer();
    const baseUrl = `http://127.0.0.1:${port}`;

    // 3. Sync via API (mesmo protocolo do celular) — token lido do ARQUIVO de
    // sessão a cada ciclo: fonte única e fresca (login/saída da UI refletem
    // na hora; arquivo vazio = sem sessão, é o que o logout faz)
    const syncRun = async (cursor: number, push: SyncPush) => {
      const token = await getDesktopSessionToken();
      if (!token) return Promise.reject(new Error("Sem sessão — faça login novamente"));
      return makeHttpSyncRun(
        { baseUrl: loadConfig().apiUrl, token },
        {
          onUnauthorized: () => {
            console.log("[Notas] 401 do remoto — mandando pra página de login");
            mainWindow?.loadURL(`${baseUrl}/login`);
          },
        }
      )(cursor, push);
    };

    startSyncLoop(localClient, syncRun, {
      intervalMs: 30_000,
      onSync: (r) => {
        if (r.pushedNotes || r.pulledNotes || r.appliedTombstones || r.conflicts.length) {
          console.log(
            `[SYNC] pushed=${r.pushedNotes} pulled=${r.pulledNotes} tombs=${r.appliedTombstones} conflitos=${r.conflicts.length}`
          );
        }
      },
      onStatus: (s) => mainWindow?.webContents.send("sync-status", s),
    });
    console.log("[SYNC] laço iniciado (30s + backoff, via API)");

    // Botão "sync agora" da UI: um ciclo imediato, sem esperar o laço
    ipcMain.handle("sync-now", async () => {
      try {
        const r = await syncOnceWith(localClient, syncRun);
        const s = {
          ok: true,
          at: Date.now(),
          changed:
            (r.pulledNotes || 0) + (r.pulledVersions || 0) + r.appliedTombstones + r.conflicts.length > 0,
        };
        mainWindow?.webContents.send("sync-status", s);
        return s;
      } catch (err) {
        const s = { ok: false, at: Date.now(), error: err instanceof Error ? err.message : String(err) };
        mainWindow?.webContents.send("sync-status", s);
        return s;
      }
    });

    // 4. Janela: sem sessão salva → abre direto na página de login
    const session = await getDesktopSessionToken();
    await createWindow(session ? baseUrl : `${baseUrl}/login`);
  } catch (err) {
    console.error("[Notas] falha ao iniciar:", err);
    app.quit();
  }
});

app.on("window-all-closed", () => {
  app.quit();
});
