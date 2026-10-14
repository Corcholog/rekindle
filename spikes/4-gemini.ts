// Spike 4: Gemini Structured Output
import { GoogleGenAI } from '@google/genai';

async function run() {
  // Requires GEMINI_API_KEY env var
  if (!process.env.GEMINI_API_KEY) {
    console.log("NO-GO: GEMINI_API_KEY not set. Cannot test Gen AI SDK.");
    return;
  }

  try {
    const ai = new GoogleGenAI({});
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'Sugiere una acción para mejorar este texto: "El software es difícil de mantener si no hay tests."',
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: "OBJECT",
          properties: {
            action_type: { type: "STRING" },
            suggested_action: { type: "STRING" }
          },
          required: ["action_type", "suggested_action"]
        }
      }
    });

    const parsed = JSON.parse(response.text!);
    if (parsed.action_type && parsed.suggested_action) {
      console.log("GO: Gemini returned structured JSON.");
      console.log(parsed);
    } else {
      console.log("NO-GO: Invalid Gemini structure.");
      console.log(parsed);
    }
  } catch (err) {
    console.log("NO-GO:", err.message);
  }
}

run().catch(console.error);
