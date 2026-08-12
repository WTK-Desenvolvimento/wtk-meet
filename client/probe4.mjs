import { spawn } from 'node:child_process';
import { io } from 'socket.io-client';
const child = spawn(process.execPath, ['../server/src/index.js'], { env:{...process.env, PORT:'4324'}, stdio:['ignore','pipe','pipe'] });
await new Promise(r => child.stdout.on('data', d => String(d).includes('listening') && r()));
const s = io('http://127.0.0.1:4324', { transports:['websocket'], forceNew:true });
await new Promise(r => s.on('connect', r));
console.log('conectado');
s.removeAllListeners(); s.close();
const e = new Promise(r => child.once('exit', r)); child.kill(); await e;
child.stdout.destroy(); child.stderr.destroy();
setTimeout(() => {
  console.log('handles:', process._getActiveHandles().map(h => h.constructor.name).join(','));
  console.log('reqs:', process._getActiveRequests().length);
}, 300).unref();
