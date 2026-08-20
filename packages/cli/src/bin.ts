import { executeCli } from "./command.js";

process.exitCode = await executeCli(process.argv.slice(2));
