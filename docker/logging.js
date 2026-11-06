import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const logDir = process.env.LOG_DIR;

if (logDir) {
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  const stderrWrite = process.stderr.write.bind(process.stderr);

  for (const [stream, level] of [[process.stdout, 'INFO'], [process.stderr, 'ERROR']]) {
    const write = stream.write.bind(stream);
    stream.write = function (chunk, ...args) {
      const time = formatter.format(new Date());
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      try {
        appendFileSync(join(logDir, `app-${time.slice(0, 10)}.log`), `[${time} KST] [${level}] ${text}`, { mode: 0o600 });
      } catch (error) {
        stderrWrite(`파일 로그 저장 실패: ${error.code ?? error.name}\n`);
      }
      return write(chunk, ...args);
    };
  }
}
