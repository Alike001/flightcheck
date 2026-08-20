#!/usr/bin/env node
import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { executeCli } from "./command.js";
import {
  executeStorageWorker,
  isStorageWorkerInput,
} from "./storage-worker.js";

if (!isMainThread && parentPort && isStorageWorkerInput(workerData)) {
  await executeStorageWorker(workerData, parentPort);
} else {
  process.exitCode = await executeCli(process.argv.slice(2));
}
