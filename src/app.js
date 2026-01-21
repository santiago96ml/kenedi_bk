require('dotenv').config();
const express = require('express');
const cors = require('cors');
const botRoutes = require('./routes/bot');
const driveRoutes = require('./routes/drive');

// Importar rutas
const studentRoutes = require('./routes/students');
// const botRoutes = require('./routes/bot'); // Cuando lo crees

const app = express();
const port = process.env.PORT || 4001;

// Middlewares Globales
app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.use('/api/bot', botRoutes);     // Esto habilita /api/bot/ai/generate
app.use('/api/drive', driveRoutes); // Esto habilita la subida/bajada

// Rutas Maestras
app.use('/api/students', studentRoutes);
// app.use('/api/bot', botRoutes);

// Ruta de salud (Health Check)
app.get('/', (req, res) => res.send('🚀 Kennedy Backend v2.0 Online'));

app.listen(port, () => {
  console.log(`
  ################################################
  🛡️  Servidor Corriendo en Puerto: ${port} 🛡️
  ################################################
  `);
});