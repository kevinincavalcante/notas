import { app, BrowserWindow, ipcMain, shell, Menu } from "electron";
import http from "http";
import { join } from "path";
import { writeFileSync } from "fs";
import { createClient } from "@libsql/client";
import "./bootstrap-env"; // PRIMEIRO: escreve notas-local.env (thin-client, sem Turso/R2)
import "./env"; // depois carrega tudo (ordem é contrato: libs abrem client no load)
import { ensureSchema } from "../lib/db-schema";
import { startSyncLoop } from "../lib/sync-replica";
import { syncOnceWith } from "../lib/sync-core";
import { makeHttpSyncRun } from "../lib/sync-http";
import type { SyncPush } from "../lib/sync-types";
import {
  loadConfig,
  saveConfig,
  getSessionToken,
  encryptToken,
  DEFAULT_API_URL,
} from "./config";
import { envSource, localDbPath, isDev } from "./env";

/** Janela ativa — o sync envia o status pra ela via IPC. */
let mainWindow: BrowserWindow | null = null;

/* ---- Login (estilo celular): janela própria, sem arquivo de env ---- */

let loginWindow: BrowserWindow | null = null;
let loginPromise: Promise<boolean> | null = null;
let loginResolver: ((value: boolean) => void) | null = null;

function openLoginWindow(): Promise<boolean> {
  if (loginPromise) return loginPromise;
  loginPromise = new Promise<boolean>((resolve) => {
    loginResolver = resolve;
    const cfg = loadConfig();
    const win = new BrowserWindow({
      width: 430,
      height: 500,
      title: "Entrar no Notas",
      autoHideMenuBar: true,
      backgroundColor: "#0f172a",
      resizable: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(__dirname, "login-preload.cjs"),
      },
    });
    loginWindow = win;
    const html = loginHtml(cfg.username || "", cfg.apiUrl || DEFAULT_API_URL);
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.on("closed", () => {
      loginWindow = null;
      if (loginResolver) {
        loginResolver(false);
        loginResolver = null;
      }
      loginPromise = null;
    });
  });
  return loginPromise;
}

function loginHtml(username: string, apiUrl: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { background: #0f172a; color: #f8fafc; margin: 0; padding: 32px 28px; }
    h1 { font-size: 24px; margin: 0 0 6px; font-weight: 700; color: #f8fafc; }
    p { color: #94a3b8; font-size: 13px; margin: 0 0 24px; }
    label { display: block; font-size: 12px; font-weight: 600; color: #cbd5e1; margin-bottom: 6px; }
    input { width: 100%; padding: 10px 12px; background: #1e293b; border: 1px solid #334155; border-radius: 8px; color: #f8fafc; font-size: 14px; margin-bottom: 16px; outline: none; }
    input:focus { border-color: #3b82f6; }
    button { width: 100%; padding: 11px; background: #3b82f6; color: #fff; border: 0; border-radius: 8px; font-weight: 600; font-size: 14px; cursor: pointer; margin-top: 8px; }
    button:hover { background: #2563eb; }
    .err { color: #ef4444; font-size: 12px; margin-top: 12px; min-height: 16px; text-align: center; }
  </style></head><body>
  <form id="f">
    <h1>Notas</h1><p>Sua conta na nuvem — o app guarda o acesso no cofre do sistema</p>
    <label>Usuário</label><input id="u" value="${username}" autocapitalize="none">
    <label>Senha</label><input id="p" type="password">
    <label>Endereço da API</label><input id="a" value="${apiUrl}" autocapitalize="none">
    <button type="submit">Entrar</button>
    <div class="err" id="err"></div>
  </form>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const err = document.getElementById('err'); err.textContent = 'Entrando…';
      const r = await window.notasLogin.submit({
        apiUrl: document.getElementById('a').value,
        username: document.getElementById('u').value,
        password: document.getElementById('p').value,
      });
      if (!r || !r.ok) { err.textContent = (r && r.error) || 'Login falhou'; }
    });
  </script></body></html>`;
}

ipcMain.handle("login-submit", async (_e, data: { apiUrl?: string; username?: string; password?: string }) => {
  const baseUrl = (data.apiUrl || DEFAULT_API_URL).trim().replace(/\/+$/, "");
  try {
    const res = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: data.username || "", password: data.password || "" }),
    });
    const json = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!res.ok || !json.token) {
      return { ok: false, error: json.error || "Login falhou" };
    }
    const enc = encryptToken(json.token);
    saveConfig({
      apiUrl: baseUrl,
      username: data.username,
      token: enc.token,
      encrypted: enc.encrypted,
    });
    writeFileSync(join(app.getPath("userData"), "notas-session.token"), json.token);
    if (loginResolver) {
      loginResolver(true);
      loginResolver = null;
    }
    loginWindow?.close();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Falha de conexão com a API" };
  }
});

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

    // 2. Login estilo celular: sem sessão salva → janela de login
    let session = getSessionToken();
    if (!session) {
      const ok = await openLoginWindow();
      if (!ok) {
        console.log("[Notas] login cancelado — encerrando");
        app.quit();
        return;
      }
      session = getSessionToken();
    }
    console.log(`[Notas] sessão de ${loadConfig().username ?? "?"} em ${loadConfig().apiUrl}`);

    // 3. Sync via API (mesmo protocolo do celular) — token lido a cada
    // ciclo (re-login emite token novo sem reiniciar o app)
    const syncRun = (cursor: number, push: SyncPush) => {
      const token = getSessionToken();
      const apiUrl = loadConfig().apiUrl;
      if (!token) return Promise.reject(new Error("Sem sessão — faça login novamente"));
      return makeHttpSyncRun(
        { baseUrl: apiUrl, token },
        { onUnauthorized: () => void openLoginWindow() }
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
    console.log("[SYNC] laço iniciado (30s + backoff, via API)");

    // 4. Sidecar Next + janela
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
