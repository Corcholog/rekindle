// Spike 2: Embeddings ONNX
import { pipeline, env } from '@huggingface/transformers';
import * as os from 'os';

env.allowLocalModels = false;
env.useBrowserCache = false;

async function run() {
  const startMemory = process.memoryUsage().rss / 1024 / 1024;
  console.log(`Starting RSS Memory: ${startMemory.toFixed(2)} MB`);

  const extractor = await pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2', {
    dtype: 'q8', // Quantized INT8
  });

  const loadMemory = process.memoryUsage().rss / 1024 / 1024;
  console.log(`Model Loaded RSS Memory: ${loadMemory.toFixed(2)} MB`);

  const res = await extractor('Este es un ensayo sobre la memoria de trabajo.', {
    pooling: 'mean',
    normalize: true,
  });

  const inferenceMemory = process.memoryUsage().rss / 1024 / 1024;
  console.log(`Inference RSS Memory: ${inferenceMemory.toFixed(2)} MB`);
  console.log(`Vector Dimensions: ${res.dims.join('x')}`);
  console.log(`Vector length: ${res.data.length}`);

  if (inferenceMemory < 500) {
    console.log("GO: Memory is well under 500MB.");
  } else {
    console.log("NO-GO: Memory exceeded 500MB limit.");
  }
}

run().catch(console.error);
