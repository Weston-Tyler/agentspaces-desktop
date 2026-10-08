import { app, BrowserWindow, Tray, Menu, nativeImage, session } from "electron";
import { startServer } from "./server.mjs";
import { join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
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
      companion = await startServer({
        root: join(app.getPath("userData"), "alpha-state"),
        port: 0,
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
            backgroundColor: "#f6f7f9",
            webPreferences: {
              nodeIntegration: false,
              contextIsolation: true,
              sandbox: true,
            },
          });
          window.setMenuBarVisibility(false);
          window.loadURL(companion.address);
          window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
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
