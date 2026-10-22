// Worker thread for adblock.js: parses the downloaded filter lists (a few seconds of
// CPU for ~15 lists) and returns the serialized engine, off the main thread.

import { parentPort, workerData } from 'node:worker_threads';
import { FiltersEngine } from '@ghostery/adblocker';

const { lists, resources } = workerData;
const engine = FiltersEngine.parse(lists.join('\n'), { loadCosmeticFilters: true, loadNetworkFilters: true, enableCompression: true });
try {
  if (resources) engine.updateResources(resources, String(resources.length));
} catch {
  // a broken resources file only disables scriptlets/redirects; blocking still works
}
const buf = engine.serialize();
parentPort.postMessage(buf, [buf.buffer]);
