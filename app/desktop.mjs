import { app, BrowserWindow, Tray, Menu, nativeImage, session, shell } from "electron";
import { startServer } from "./server.mjs";
import { join, isAbsolute } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { addNativeToolPaths } from './native-tool-path.mjs';
app.setName("AgentSpaces Desktop");
if (app.isPackaged) {
  process.env.AGENTSPACES_NODE_BINARY = join(process.resourcesPath,'runtime',process.platform==='win32'?'node.exe':'node');
  process.env.PATH = join(process.resourcesPath,'runtime') + (process.platform==='win32'?';':':') + (process.env.PATH ?? '');
}
addNativeToolPaths();
if (process.platform === "win32") app.setAppUserModelId("com.agentspaces.desktop");
const desktopIcon = fileURLToPath(new URL("../assets/agentspaces.png", import.meta.url));
if (process.env.AGENTSPACES_DESKTOP_STATE) {
  mkdirSync(process.env.AGENTSPACES_DESKTOP_STATE, { recursive: true });
  app.setPath("userData", process.env.AGENTSPACES_DESKTOP_STATE);
}
let companion,
  window,
  tray,
  quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      const locationPath = join(app.getPath('userData'),'workspace-location.json');
      let savedRoot = null;
      if (existsSync(locationPath)) {
        try { const saved = JSON.parse(readFileSync(locationPath,'utf8')); if(saved.schema===1 && typeof saved.root==='string' && saved.root.length<4096 && isAbsolute(saved.root)) savedRoot=saved.root; } catch {}
      }
      const ownedRoot = process.env.AGENTSPACES_STATE ?? savedRoot ?? join(app.getPath('userData'),'workspace');
      const sourceRuntime = process.env.AGENTSPACES_STATE || savedRoot || app.isPackaged ? join(ownedRoot, "runtime.json") : fileURLToPath(new URL("../.local/runtime.json", import.meta.url));
      const sharedRuntime = process.env.AGENTSPACES_DESKTOP_RUNTIME ?? (!process.env.AGENTSPACES_DESKTOP_STATE && existsSync(sourceRuntime) ? sourceRuntime : null);
      if (sharedRuntime) {
        let runtime;
        try {
          runtime = JSON.parse(readFileSync(sharedRuntime, "utf8"));
          if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(runtime.address)) throw new Error("Invalid companion address");
          const response = await fetch(runtime.address + "/api/health", { headers: { Authorization: "Bearer " + runtime.admin }, signal: AbortSignal.timeout(3000) });
          const health = await response.json();
          if (!response.ok || health.instance !== runtime.instance || health.pid !== runtime.pid) throw new Error("Companion runtime identity mismatch");
          // An attached desktop window does not own the background process.
          companion = { address: runtime.address, close: async () => {} };
        } catch (error) {
          // A saved runtime can outlive its service after a computer restart.
          // Do not replace a live process or an explicitly selected runtime.
          let live = false;
          if (Number.isInteger(runtime?.pid) && runtime.pid > 0) try { process.kill(runtime.pid, 0); live = true; } catch {}
          if (live || process.env.AGENTSPACES_DESKTOP_RUNTIME) throw error;
        }
      }
      if (!companion) companion = await startServer({
        root: ownedRoot,
        port: 43127,
      });
      session.defaultSession.setPermissionRequestHandler((_w, _p, callback) =>
        callback(false),
      );
      const show = () => {
        if (!window) {
          window = new BrowserWindow({
            width: 1220,
            height: 830,
            minWidth: 720,
            minHeight: 540,
            title: "AgentSpaces Desktop",
            icon: desktopIcon,
            backgroundColor: "#f6f7f9",
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
            },
          });
          window.setMenuBarVisibility(false);
          window.loadURL(companion.address);
          window.webContents.setWindowOpenHandler(({ url }) => {
            try {
              const target = new URL(url);
              const company = target.protocol === 'https:' && ['badmonkey.ai','www.badmonkey.ai'].includes(target.hostname);
              const project = target.protocol === 'https:' && target.hostname === 'github.com' && /^\/(?:badmonkeyai(?:\/|$)|Weston-Tyler\/agentspaces-desktop(?:\/|$))/.test(target.pathname);
              if ((company || project) && !target.username && !target.password) void shell.openExternal(target.href);
            } catch {}
            return { action: 'deny' };
          });
          window.webContents.on("will-navigate", (event, url) => {
            if (new URL(url).origin !== companion.address)
              event.preventDefault();
          });
          window.on("close", (event) => {
            if (!quitting) {
              event.preventDefault();
              window.hide();
            }
          });
        }
        window.show();
        window.focus();
      };
      const pixels = Buffer.alloc(32 * 32 * 4);
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++) {
          const i = (y * 32 + x) * 4;
          const ink =
            x >= 6 &&
            x <= 25 &&
            ((y >= 7 && y <= 10) ||
              (y >= 14 && y <= 17) ||
              (y >= 21 && y <= 24));
          pixels.set(ink ? [240, 245, 255, 255] : [41, 73, 188, 255], i);
        }
      tray = new Tray(
        nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }),
      );
      tray.setToolTip("AgentSpaces Desktop");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "Open companion", click: show },
          { label: "Quit", click: () => app.quit() },
        ]),
      );
      tray.on("click", show);
      show();
      if (process.env.AGENTSPACES_QA_SCREENSHOT) {
        window.webContents.once("did-finish-load", () =>
          setTimeout(async () => {
            const capture = await window.webContents.capturePage();
            writeFileSync(
              process.env.AGENTSPACES_QA_SCREENSHOT,
              capture.toPNG(),
            );
            console.log("Native shell render captured");
          }, 700),
        );
      }
      app.on("before-quit", (event) => {
        if (quitting) return;
        event.preventDefault();
        quitting = true;
        companion.close().finally(() => app.quit());
      });
      app.on("window-all-closed", () => {});
    })
    .catch((error) => {
      console.error(error);
      app.quit();
    });
}
