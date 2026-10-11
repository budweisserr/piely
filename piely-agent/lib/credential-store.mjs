// The provider credentials pi-ai reads: one JSON object, keyed by provider id.
//
// Writes are serialized per provider and land through a temp file + rename, so
// a crash cannot leave a half-written file. The file holds OAuth tokens, so it
// is written 0600.
import { chmod, readFile, rename, writeFile } from "node:fs/promises";

export class FileCredentialStore {
  constructor(path) {
    this.path = path;
    this.credentials = new Map();
    this.loaded = this.load();
    this.chains = new Map();
  }

  async load() {
    let raw;
    try {
      raw = await readFile(this.path, "utf8");
    } catch {
      return; // missing file == no credentials
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Writing the next login over a damaged file would silently drop every
      // other provider, so the damaged file is kept for recovery first.
      console.error(
        `auth file is not valid JSON, keeping it as ${this.path}.corrupt:`,
        error
      );
      await rename(this.path, `${this.path}.corrupt`).catch(() => {});
      return;
    }

    for (const [providerId, credential] of Object.entries(parsed)) {
      this.credentials.set(providerId, credential);
    }
  }

  async persist() {
    const tmp = `${this.path}.tmp`;
    // 0600: the file holds OAuth tokens and API keys. `mode` only applies when
    // the file is created, so an existing world-readable file is chmodded too.
    await writeFile(tmp, JSON.stringify(Object.fromEntries(this.credentials), null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600).catch(() => {});
  }

  enqueue(providerId, task) {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const queued = previous.catch(() => {}).then(task);
    this.chains.set(providerId, queued.catch(() => {}));
    return queued;
  }

  async read(providerId) {
    await this.loaded;
    return this.credentials.get(providerId);
  }

  async list() {
    await this.loaded;
    return [...this.credentials].map(([providerId, credential]) => ({
      providerId,
      type: credential.type,
    }));
  }

  modify(providerId, fn) {
    return this.enqueue(providerId, async () => {
      await this.loaded;
      const current = this.credentials.get(providerId);
      const next = await fn(current);
      if (next !== undefined) this.credentials.set(providerId, next);
      await this.persist();
      return next ?? current;
    });
  }

  delete(providerId) {
    return this.enqueue(providerId, async () => {
      await this.loaded;
      this.credentials.delete(providerId);
      await this.persist();
    });
  }
}
