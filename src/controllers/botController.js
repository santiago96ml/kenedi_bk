const botService = require('../services/botService');
const aiService = require('../services/aiService');

// --- BOT SETTINGS ---
const getSettings = async (req, res) => {
  try {
    const settings = await botService.getSettings();
    res.json(settings);
  } catch (error) {
    res.status(500).json({ error: 'Error obteniendo configuración del bot' });
  }
};

const updateSettings = async (req, res) => {
  try {
    const updated = await botService.updateSettings(req.body);
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// --- IA GENERATION ---
const generateAIResponse = async (req, res) => {
  try {
    const { prompt, messages } = req.body;
    if (!prompt && !messages) return res.status(400).json({ error: 'Falta prompt' });

    const resultText = await aiService.generateResponse(prompt, messages);
    res.json({ result: resultText });
  } catch (error) {
    console.error("AI Error:", error.message);
    res.status(500).json({ error: error.message });
  }
};

module.exports = { getSettings, updateSettings, generateAIResponse };