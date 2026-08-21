#!/usr/bin/env node
import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { executeCli } from "./command.js";
import {
  executeComputeWorker,
  isComputeWorkerInput,
} from "./compute.js";
import {
  executeStorageWorker,
  isStorageWorkerInput,
} from "./storage-worker.js";

if (!isMainThread && parentPort) {
  if (isStorageWorkerInput(workerData)) {
    await executeStorageWorker(workerData, parentPort);
  } else if (isComputeWorkerInput(workerData)) {
    await executeComputeWorker(workerData, parentPort);
  } else {
    process.exitCode = 2;
  }
} else {
  process.exitCode = await executeCli(process.argv.slice(2));
}
