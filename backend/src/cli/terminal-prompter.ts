import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Line-oriented operator I/O for CLI commands; replaced by a scripted double in tests. */
export interface CliIo {
  ask(question: string): Promise<string>;
  /** Reads a line without echoing what is typed (passwords). */
  askHidden(question: string): Promise<string>;
  print(line: string): void;
  close(): void;
}

/**
 * Terminal implementation. Hidden input is read through readline with its echo routed into a sink
 * that drops everything while a secret is being typed, so the password never reaches the terminal,
 * scrollback or a log. History is disabled so no entered line is kept in memory after it is read.
 */
export function createTerminalPrompter(
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): CliIo {
  let muted = false;
  const echo = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) output.write(chunk, encoding);
      callback();
    },
  });
  const rl = createInterface({ input, output: echo, terminal: true, historySize: 0 });

  return {
    ask(question) {
      muted = false;
      return new Promise((resolve) => rl.question(question, resolve));
    },
    askHidden(question) {
      output.write(question);
      muted = true;
      return new Promise((resolve) =>
        rl.question('', (answer) => {
          muted = false;
          output.write('\n');
          resolve(answer);
        }),
      );
    },
    print(line) {
      output.write(`${line}\n`);
    },
    close() {
      rl.close();
    },
  };
}
