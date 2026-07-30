import { cmd } from "../../cli/cmd/cmd"
import { attach } from "./attach"

export const SharedTerminalCommand = cmd({
  command: "shared-terminal <url> <terminal-id>",
  describe: false as unknown as string,
  builder: (yargs) =>
    yargs
      .positional("url", { type: "string", demandOption: true })
      .positional("terminal-id", { type: "string", demandOption: true })
      .option("cols", { type: "number", default: 120 })
      .option("rows", { type: "number", default: 40 }),
  handler: async (args) => {
    // Ticket lives ONLY in env, never in argv, never in log output. Read and
    // delete BEFORE doing anything else (so a thrown error path can't leak
    // the value into a stack frame dump or stderr capture).
    const ticket = process.env.KILO_SHARED_TERMINAL_TICKET
    delete process.env.KILO_SHARED_TERMINAL_TICKET
    if (!ticket) {
      process.exitCode = 1
      return
    }

    const reason = await attach({
      url: args.url,
      terminalID: args["terminal-id"],
      ticket,
      cols: args.cols,
      rows: args.rows,
    })
    if (reason === "error" || reason === "pty_terminated") process.exitCode = 1
  },
})
