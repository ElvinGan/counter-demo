const downloads = {
  nano: () => fetch('./models/yolox_nano.onnx'),
  tiny: () => fetch('./models/yolox_tiny.onnx'),
  s: () => fetch('./models/yolox_s.onnx'),
};
const bytes = new Map();
async function loadModel(model) {
  if (!bytes.has(model)) {
    const pending = downloads[model]().then(async response => {
      if (!response.ok) throw new Error('Model unavailable');
      return new Uint8Array(await response.arrayBuffer());
    });
    bytes.set(model, pending);
    pending.catch(() => bytes.delete(model));
  }
  return bytes.get(model);
}
export const modelSizes = { nano: '4 MB', tiny: '20 MB', s: '36 MB' };
export const modelNames = { nano: 'Fastest', tiny: 'Balanced', s: 'Most accurate' };
export function nextFasterModel(model) {
  return model === 's' ? 'tiny' : model === 'tiny' ? 'nano' : null;
}
export function stepDownTarget(runTimesMs, { model, chosen }) {
  if (chosen || runTimesMs.length < 13) return null;
  // Startup work must not make a capable device settle for a smaller model.
  const recent = runTimesMs.slice(3).slice(-10).sort((a,b) => a-b);
  return (recent[4]+recent[5])/2 > 125 ? nextFasterModel(model) : null;
}
export async function createRunner(model, options = {}) {
  const modelChosen = options.modelChosen ?? Boolean(model);
  const loadGPU = options.loadGPU ?? (() => import('../vendor/ort/ort.webgpu.min.mjs'));
  const loadWasm = options.loadWasm ?? (() => import('../vendor/ort/ort.wasm.min.mjs'));
  const gpu = options.gpu ?? globalThis.navigator?.gpu;
  const isolated = options.isolated ?? globalThis.crossOriginIsolated;
  const startTimer = options.setTimeout ?? globalThis.setTimeout;
  const cancelTimer = options.clearTimeout ?? globalThis.clearTimeout;
  const now = options.now ?? (() => performance.now());
  let lastRunMs = null;
  let runtime, session, backend, inputW, inputH, lastProblem = '', unusable = false;
  function problem(message) { lastProblem = message; options.onProblem?.(message); }
  async function open(provider) {
    model ??= provider === 'webgpu' ? 's' : 'nano';
    options.onLoading?.(model);
    let data;
    try { data = await (options.loadModel ?? loadModel)(model); }
    catch (cause) { throw Object.assign(new Error('Model download failed', { cause }), { code: 'MODEL_DOWNLOAD' }); }
    runtime = await (provider === 'webgpu' ? loadGPU() : loadWasm());
    runtime.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
    runtime.env.wasm.numThreads = isolated ? Math.min(4, globalThis.navigator?.hardwareConcurrency || 2) : 1;
    // The WASM-only entry supports a proxy worker; WebGPU must stay on the calling thread.
    runtime.env.wasm.proxy = provider === 'wasm';
    // ORT 1.31.1 cannot serialize preferredOutputLocation through its WASM proxy.
    const sessionOptions = { executionProviders: [provider] };
    if (provider === 'webgpu') sessionOptions.preferredOutputLocation = 'cpu';
    session = await runtime.InferenceSession.create(data, sessionOptions);
    const shape = session.inputMetadata[0]?.shape;
    if (!shape || shape.length !== 4 || shape[0] !== 1 || shape[1] !== 3 || !shape.slice(2).every(n => Number.isInteger(n) && n > 0)) {
      await release(); throw new Error('Unsupported model shape');
    }
    inputH = shape[2]; inputW = shape[3]; backend = provider;
  }
  async function release() {
    const previous = session; session = null;
    if (previous) await previous.release();
  }
  async function fallback(error) {
    // A lost GPU can also hang in release. Retire it without blocking the WASM attempt.
    void release().catch(() => {});
    const switched = !modelChosen && model !== 'nano';
    if (switched) model = 'nano';
    problem((error.code === 'RUN_TIMEOUT' ? 'WebGPU took more than 8 seconds for a picture.' : 'WebGPU could not run the counter.') +
      (switched ? ' Switched to Fastest on WASM.' : ' Using WASM instead.'));
    await open('wasm');
  }
  let available = false;
  try { available = Boolean(gpu && await gpu.requestAdapter()); } catch {}
  if (available) {
    try { await open('webgpu'); }
    catch (error) { if (error.code === 'MODEL_DOWNLOAD') throw error; await fallback(error); }
  } else {
    if (!modelChosen) model = 'nano';
    await open('wasm');
  }
  async function infer(pixels) {
    // Capture these before awaiting: an abandoned run may finish after fallback replaced them.
    const active = session;
    const input = new runtime.Tensor('float32', typeof pixels === 'function' ? pixels() : pixels, [1, 3, inputH, inputW]);
    let output;
    try {
      const started = now();
      try { output = await active.run({ [active.inputNames[0]]: input }); }
      finally {
        // A retired GPU result must not replace the current WASM run's measurement.
        if (active === session) lastRunMs = now()-started;
      }
      return new Float32Array(output[active.outputNames[0]].data);
    } finally {
      input.dispose?.();
      if (output) for (const tensor of Object.values(output)) tensor.dispose?.();
    }
  }
  async function timedInfer(pixels) {
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = startTimer(() => reject(Object.assign(new Error('This device is taking more than 8 seconds a picture. Open More and choose Fastest.'), { code: 'RUN_TIMEOUT' })), 8000);
    });
    try { return await Promise.race([infer(pixels), deadline]); }
    finally { cancelTimer(timer); }
  }
  async function wasmInfer(pixels) {
    try { return await timedInfer(pixels); }
    catch (error) {
      if (error.code === 'RUN_TIMEOUT') {
        unusable = true;
        void release().catch(() => {});
      }
      throw error;
    }
  }
  return {
    get model() { return model; }, get lastProblem() { return lastProblem; },
    get lastRunMs() { return lastRunMs; },
    get backend() { return backend; }, get inputW() { return inputW; }, get inputH() { return inputH; },
    async run(pixels) {
      if (unusable || !session) throw new Error('The counter needs to be restarted.');
      if (backend === 'wasm') return wasmInfer(pixels);
      try { return await timedInfer(pixels); }
      catch (error) { await fallback(error); return wasmInfer(pixels); }
    }, release,
  };
}
