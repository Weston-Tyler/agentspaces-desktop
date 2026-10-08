import { installHostRouter } from "../app/router-install.mjs";
const [host = "local", action = "preview"] = process.argv.slice(2);
if (!["preview", "install"].includes(action)) throw new Error("Use: node scripts/install-router.mjs local|remote preview|install");
console.log(JSON.stringify(await installHostRouter(host, action === "preview"), null, 2));
