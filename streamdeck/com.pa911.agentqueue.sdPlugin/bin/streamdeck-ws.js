"use strict";

const crypto = require("node:crypto");
const net = require("node:net");

class StreamDeckWebSocket {
  constructor({ port, onMessage, onClose }) {
    this.port = Number(port);
    this.onMessage = onMessage;
    this.onClose = onClose;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.connected = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString("base64");
      const socket = net.createConnection({ host: "127.0.0.1", port: this.port }, () => {
        socket.write([
          "GET / HTTP/1.1",
          "Host: 127.0.0.1",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          "",
        ].join("\r\n"));
      });

      let headerBuffer = Buffer.alloc(0);
      const fail = (error) => {
        socket.destroy();
        reject(error);
      };

      socket.once("error", fail);
      socket.on("data", (chunk) => {
        if (this.connected) {
          this.readFrames(chunk);
          return;
        }

        headerBuffer = Buffer.concat([headerBuffer, chunk]);
        const headerEnd = headerBuffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;

        const header = headerBuffer.slice(0, headerEnd).toString("utf8");
        if (!/^HTTP\/1\.1 101\b/.test(header)) {
          fail(new Error(`Stream Deck websocket rejected connection: ${header.split("\r\n")[0]}`));
          return;
        }

        socket.off("error", fail);
        socket.on("error", (error) => {
          if (this.onClose) this.onClose(error);
        });
        socket.on("close", () => {
          if (this.onClose) this.onClose();
        });

        this.socket = socket;
        this.connected = true;
        const remaining = headerBuffer.slice(headerEnd + 4);
        if (remaining.length) this.readFrames(remaining);
        resolve(this);
      });
    });
  }

  send(value) {
    this.sendFrame(0x1, Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8"));
  }

  sendFrame(opcode, payload = Buffer.alloc(0)) {
    if (!this.connected || !this.socket) return;
    const headerLength = payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10;
    const frame = Buffer.alloc(headerLength + 4 + payload.length);
    frame[0] = 0x80 | opcode;
    if (payload.length < 126) {
      frame[1] = 0x80 | payload.length;
    } else if (payload.length < 65536) {
      frame[1] = 0x80 | 126;
      frame.writeUInt16BE(payload.length, 2);
    } else {
      frame[1] = 0x80 | 127;
      frame.writeBigUInt64BE(BigInt(payload.length), 2);
    }

    const maskOffset = headerLength;
    const mask = crypto.randomBytes(4);
    mask.copy(frame, maskOffset);
    for (let index = 0; index < payload.length; index += 1) {
      frame[maskOffset + 4 + index] = payload[index] ^ mask[index % 4];
    }
    this.socket.write(frame);
  }

  readFrames(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 2) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        length = Number(this.buffer.readBigUInt64BE(offset));
        offset += 8;
      }

      const maskOffset = masked ? offset : -1;
      if (masked) offset += 4;
      if (this.buffer.length < offset + length) return;

      let payload = this.buffer.slice(offset, offset + length);
      if (masked) {
        const mask = this.buffer.slice(maskOffset, maskOffset + 4);
        payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
      }

      this.buffer = this.buffer.slice(offset + length);
      if (opcode === 0x8) {
        this.socket.end();
        return;
      }
      if (opcode === 0x9) {
        this.sendFrame(0xA, payload);
        continue;
      }
      if (opcode === 0xA) continue;
      if (opcode !== 0x1) continue;

      if (this.onMessage) this.onMessage(payload.toString("utf8"));
    }
  }
}

module.exports = { StreamDeckWebSocket };
