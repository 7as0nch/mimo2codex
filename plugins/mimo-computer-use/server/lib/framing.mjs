const HEADER_END = "\r\n\r\n";

export function encodeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}${HEADER_END}`, "utf8"),
    body,
  ]);
}

export class MessageReader {
  constructor(onMessage) {
    this.onMessage = onMessage;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    this.#drain();
  }

  #drain() {
    while (this.buffer.length > 0) {
      const headerIndex = this.buffer.indexOf(HEADER_END);
      if (headerIndex >= 0) {
        const header = this.buffer.slice(0, headerIndex).toString("utf8");
        const match = /^Content-Length:\s*(\d+)/im.exec(header);
        if (!match) {
          this.buffer = Buffer.alloc(0);
          return;
        }
        const length = Number(match[1]);
        const bodyStart = headerIndex + HEADER_END.length;
        const bodyEnd = bodyStart + length;
        if (this.buffer.length < bodyEnd) return;
        const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
        this.buffer = this.buffer.slice(bodyEnd);
        this.#emitJson(body);
        continue;
      }

      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).toString("utf8").trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.#emitJson(line);
    }
  }

  #emitJson(text) {
    try {
      this.onMessage(JSON.parse(text));
    } catch {
      // Ignore malformed peer output. MCP peers should not write logs to stdout,
      // but several local wrappers do. Diagnostics belong on stderr.
    }
  }
}

export function writeMessage(stream, message) {
  stream.write(encodeMessage(message));
}
