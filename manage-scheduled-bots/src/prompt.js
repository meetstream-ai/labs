/**
 * Interactive confirmation for the destructive commands.
 */

import readline from "node:readline/promises";
import { stdin, stdout } from "node:process";

/**
 * Asks the user to type an exact confirmation word.
 *
 * Returns false immediately when stdin is not a TTY (CI, piped input) so a
 * scripted run can never be silently confirmed. Use --yes for those.
 */
export async function confirm(question, expected = "yes") {
  if (!stdin.isTTY) {
    console.error("\nNot an interactive terminal, refusing to confirm implicitly.");
    console.error("Re-run with --yes if you are sure.");
    return false;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(`${question} Type "${expected}" to continue: `);
    return answer.trim() === expected;
  } finally {
    rl.close();
  }
}
