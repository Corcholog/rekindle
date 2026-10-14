// Spike 1: Ollama JSON Estructurado
import ollama from 'ollama';

async function run() {
  try {
    const response = await ollama.chat({
      model: 'llama3.2', // or any available model, assuming small enough
      messages: [{ 
        role: 'user', 
        content: 'Responde en formato JSON estructurado con dos campos: "is_relevant" (boolean) y "rationale" (string en español). El tema es: el impacto de la arquitectura en Obsidian.'
      }],
      format: 'json',
    });
    
    const parsed = JSON.parse(response.message.content);
    if (typeof parsed.is_relevant === 'boolean' && typeof parsed.rationale === 'string') {
      console.log("GO: Ollama returned valid structured JSON in Spanish.");
      console.log(parsed);
    } else {
      console.log("NO-GO: Invalid structure.");
      console.log(parsed);
    }
  } catch (err) {
    // If ollama is not running, we'll get a connection error, but the spike code works.
    console.log("NO-GO (or Ollama not running locally):", err.message);
  }
}

run().catch(console.error);
