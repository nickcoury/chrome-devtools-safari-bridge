export class Logger {
  constructor(scopeName = "bridge") {
    this.scopeName = scopeName;
  }

  scope(name) {
    return new Logger(`${this.scopeName}:${name}`);
  }

  info(...args) {
    this.#log("INFO", ...args);
  }

  warn(...args) {
    this.#log("WARN", ...args);
  }

  error(...args) {
    this.#log("ERROR", ...args);
  }

  debug(...args) {
    if (process.env.DEBUG) {
      this.#log("DEBUG", ...args);
    }
  }

  #log(level, ...args) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] [${this.scopeName}]`, ...args);
  }
}
