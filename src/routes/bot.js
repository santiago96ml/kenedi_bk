const express = require('express');
const router = express.Router();
const verifyToken = require('../middlewares/auth');
const botController = require('../controllers/botController');

router.use(verifyToken); // Protección global para rutas de bot

router.get('/', botController.getSettings);
router.put('/', botController.updateSettings);
router.post('/ai/generate', botController.generateAIResponse); // Ruta de IA

module.exports = router;