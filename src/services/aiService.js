class AIService {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    this.apiUrl = "https://openrouter.ai/api/v1/chat/completions";
  }

  async generateResponse(prompt, messages = null) {
    if (!this.apiKey) throw new Error('API Key de OpenRouter no configurada');

    // Priorizamos 'messages' si viene (historial de chat), sino usamos 'prompt' simple
    const payloadMessages = messages ? messages : [{ role: "user", content: prompt }];

    const response = await fetch(this.apiUrl, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://vintex.net.br", // Requerido por OpenRouter
        "X-Title": "Kennedy System",
      },
      body: JSON.stringify({
        model: "xiaomi/mimo-v2-flash:free", // O el modelo que prefieras de tu .env
        messages: payloadMessages,
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenRouter Error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Sin respuesta de la IA.";
  }
}

module.exports = new AIService();