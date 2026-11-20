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
export async function createRunner(model, options = {}) {
  let data;
  try { data = await (options.loadModel ?? loadModel)(model); }
  catch (cause) { throw Object.assign(new Error('Model download failed', { cause }), { code: 'MODEL_DOWNLOAD' }); }
  const loadGPU = options.loadGPU ?? (() => import('../vendor/ort/ort.webgpu.min.mjs'));
  const loadWasm = options.loadWasm ?? (() => import('../vendor/ort/ort.wasm.min.mjs'));
  const gpu = options.gpu ?? globalThis.navigator?.gpu;
  const isolated = options.isolated ?? globalThis.crossOriginIsolated;
  let runtime, session, backend, inputW, inputH;
  async function open(provider) {
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
      await session.release(); session = null; throw new Error('Unsupported model shape');
    }
    inputH = shape[2]; inputW = shape[3]; backend = provider;
  }
  async function release() {
    const previous = session; session = null;
    if (previous) await previous.release();
  }
  let available = false;
  try { available = Boolean(gpu && await gpu.requestAdapter()); } catch {}
  if (available) {
    try { await open('webgpu'); }
    catch { await release().catch(() => {}); await open('wasm'); }
  } else await open('wasm');
  async function infer(pixels) {
    const input = new runtime.Tensor('float32', pixels, [1, 3, inputH, inputW]);
    let output;
    try {
      output = await session.run({ [session.inputNames[0]]: input });
      return new Float32Array(output[session.outputNames[0]].data);
    } finally {
      input.dispose?.();
      if (output) for (const tensor of Object.values(output)) tensor.dispose?.();
    }
  }
  return {
    get backend() { return backend; }, get inputW() { return inputW; }, get inputH() { return inputH; },
    async run(pixels) {
      try { return await infer(pixels); }
      catch (error) {
        if (backend !== 'webgpu') throw error;
        await release().catch(() => {}); await open('wasm');
        return infer(pixels);
      }
    }, release,
  };
}
