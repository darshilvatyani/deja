const crypto = require('node:crypto');
const out = [];
out.push(Math.random());
out.push(Date.now());
out.push(new Date().toISOString());
out.push(typeof Date());
out.push(new Date(2020, 1, 1).getFullYear());
out.push(performance.now());
out.push(String(process.hrtime.bigint()));
out.push(process.hrtime().length);
out.push(crypto.randomUUID());
out.push(crypto.randomBytes(8).toString('hex'));
out.push(crypto.randomInt(1000));
out.push(Buffer.from(crypto.getRandomValues(new Uint8Array(4))).toString('hex'));
out.push(new Date() instanceof Date, Object.prototype.toString.call(new Date()));
class MyDate extends Date {}
out.push(new MyDate() instanceof Date);
console.log(JSON.stringify(out));
