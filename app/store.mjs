import {
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
export class Store {
  constructor(root) {
    this.root = root;
    mkdirSync(root, { recursive: true });
    this.path = join(root, "settings.json");
    this.data = existsSync(this.path)
      ? JSON.parse(readFileSync(this.path, "utf8"))
      : {
          schema: 1,
          projects: {},
          grants: {},
          usage: {},
          audit: [],
          connectors: {},
        };
    if (this.data.schema !== 1)
      throw new Error(
        "Unsupported settings schema; preserve state and migrate explicitly.",
      );
  }
  save() {
    const temp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    renameSync(temp, this.path);
  }
  audit(action, details = {}) {
    this.data.audit.push({ at: new Date().toISOString(), action, ...details });
    this.data.audit = this.data.audit.slice(-300);
    this.save();
  }
}
