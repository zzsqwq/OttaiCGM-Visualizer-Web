/**
 * 极简 CDP 客户端（仅用于开发期的端到端冒烟测试）
 *
 * 为什么不用 Node 内置的 WebSocket：Chrome 的 DevTools 端点会直接断开它
 * （握手成功但随即 1006），所以这里用 node:http 的 Upgrade 自己实现
 * RFC6455 的最小帧编解码，零依赖。
 */
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';

const OPCODE = { TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

function encodeFrame(payload) {
  const data = Buffer.from(payload);
  const mask = randomBytes(4);
  const len = data.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | OPCODE.TEXT;
  const masked = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

class MiniWebSocket {
  constructor(url) {
    this.url = new URL(url);
    this.buffer = Buffer.alloc(0);
    this.handlers = { message: [], open: [], close: [] };
    this.open = false;
  }

  on(event, fn) {
    this.handlers[event]?.push(fn);
    return this;
  }

  emit(event, arg) {
    for (const fn of this.handlers[event] ?? []) fn(arg);
  }

  connect() {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: this.url.hostname,
        port: this.url.port,
        path: this.url.pathname + this.url.search,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        },
      });
      req.on('upgrade', (res, socket) => {
        this.socket = socket;
        this.open = true;
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('close', () => {
          this.open = false;
          this.emit('close');
        });
        socket.on('error', () => {
          this.open = false;
        });
        this.emit('open');
        resolve();
      });
      req.on('response', (res) => reject(new Error(`WebSocket 升级失败: HTTP ${res.statusCode}`)));
      req.on('error', reject);
      req.end();
    });
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = this.readFrame();
      if (!frame) return;
      if (frame.opcode === OPCODE.TEXT) this.emit('message', frame.payload.toString('utf8'));
      else if (frame.opcode === OPCODE.CLOSE) {
        this.socket?.end();
        this.emit('close');
        return;
      } else if (frame.opcode === OPCODE.PING) {
        this.sendFrame(frame.payload, OPCODE.PONG);
      }
    }
  }

  readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) return null;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) return null;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    this.buffer = buf.subarray(offset + len);
    if (!fin) throw new Error('不支持分片帧');
    return { opcode, payload };
  }

  sendFrame(payload, opcode = OPCODE.TEXT) {
    const frame = encodeFrame(payload);
    if (opcode !== OPCODE.TEXT) frame[0] = 0x80 | opcode;
    this.socket.write(frame);
  }

  send(text) {
    this.sendFrame(text);
  }

  close() {
    try {
      this.socket?.end();
    } catch {
      /* 忽略 */
    }
    this.open = false;
  }
}

export class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    this.timeoutMs = 30000;
    ws.on('message', (text) => {
      const msg = JSON.parse(text);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' '));
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(
          msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text ?? 'exception',
        );
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new MiniWebSocket(wsUrl);
    await ws.connect();
    return new CDP(ws);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'eval 失败');
    }
    return res.result.value;
  }

  async waitFor(expression, { timeout = 20000, label = expression, interval = 120 } = {}) {
    const start = Date.now();
    for (;;) {
      if (await this.eval(`return Boolean(${expression});`)) return true;
      if (Date.now() - start > timeout) throw new Error(`等待超时: ${label}`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  async screenshot(file) {
    const res = await this.send('Page.captureScreenshot', { format: 'png' });
    const { writeFileSync } = await import('node:fs');
    writeFileSync(file, Buffer.from(res.data, 'base64'));
    return file;
  }

  async click(x, y) {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, buttons: 1 });
    }
  }

  async drag(from, to, steps = 6) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', clickCount: 1, buttons: 1 });
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', clickCount: 1, buttons: 1 });
  }

  async typeText(text) {
    for (const ch of text) await this.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
  }

  async pressKey(key, code, keyCode) {
    for (const type of ['keyDown', 'keyUp']) {
      await this.send('Input.dispatchKeyEvent', {
        type,
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        nativeVirtualKeyCode: keyCode,
      });
    }
  }

  async setFileInput(selector, paths) {
    const { root } = await this.send('DOM.getDocument', { depth: -1 });
    const { nodeId } = await this.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    if (!nodeId) throw new Error(`找不到 ${selector}`);
    await this.send('DOM.setFileInputFiles', { nodeId, files: paths });
  }

  close() {
    this.ws.close();
  }
}

/**
 * 找一个可用的 Chrome：优先 CHROME_PATH 环境变量，其次各平台常见安装位置
 */
export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* 继续找 */
    }
  }
  throw new Error('没找到 Chrome，请用 CHROME_PATH 环境变量指定可执行文件路径');
}

/** 每次跑用一个随机端口：固定端口很容易连到上一次遗留的 Chrome 实例上 */
export function randomPort(base = 9300, span = 400) {
  return base + Math.floor(Math.random() * span);
}

export function launchChrome({ port, profile, chromePath, args = [] }) {
  const spawnArgs = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1440,1000',
    // 在受限环境（容器/沙箱）里 Chrome 自带沙箱起不来，会导致渲染进程崩溃、
    // DevTools 连接被断开，所以这里显式关掉。
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--crash-dumps-dir=/tmp/chrome-crashes',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    ...args,
    'about:blank',
  ];
  return import('node:child_process').then(({ spawn }) => spawn(chromePath, spawnArgs, { stdio: 'ignore' }));
}

export async function waitForChrome(port, timeoutMs = 20000) {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch {
      /* 继续等 */
    }
    if (Date.now() - start > timeoutMs) throw new Error('Chrome 启动超时');
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function pageTarget(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  if (!page) throw new Error('没有可用的页面 target');
  return page;
}
