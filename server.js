require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');

const app = express();
const port = process.env.PORT || 4001;

app.use(cors());
app.use(express.json());

// --- CONFIGURACIÓN ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Google Drive
const auth = new google.auth.GoogleAuth({
  keyFile: 'service-account.json', 
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });
const upload = multer({ storage: multer.memoryStorage() });

// Middleware Auth
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  jwt.verify(token, process.env.SUPABASE_JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido' });
    req.user = user;
    next();
  });
};

// --- RUTAS API ---

// 1. OBTENER CARRERAS (Para la pestaña "Oferta Académica")
app.get('/api/careers', verifyToken, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('careers')
      .select('*')
      .eq('active', true)
      .order('name');
    
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error al cargar oferta académica' });
  }
});

// 2. CONFIGURACIÓN DEL BOT (Obtener y Guardar)
app.get('/api/bot', verifyToken, async (req, res) => {
  try {
    // Obtenemos la config ID=1
    const { data, error } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Error cargando bot settings' });
  }
});

app.put('/api/bot', verifyToken, async (req, res) => {
  try {
    const { is_active, welcome_message, away_message } = req.body;
    
    const { data, error } = await supabase
      .from('bot_settings')
      .update({ is_active, welcome_message, away_message, updated_at: new Date() })
      .eq('id', 1)
      .select();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ error: 'Error guardando bot settings' });
  }
});

// 3. ALUMNOS (Con Join a Carreras)
// 3. ALUMNOS (Con Join a Carreras y Búsqueda por Legajo)
app.get('/api/students', verifyToken, async (req, res) => {
  try {
    const { search, career_id, status, page = 1 } = req.query;
    const limit = 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Seleccionamos datos del alumno Y el nombre de la carrera relacionada
    let query = supabase
      .from('students')
      .select(`
        *,
        careers ( name, fees )
      `, { count: 'exact' });

    // --- CAMBIO AQUÍ: Agregamos legajo.ilike.%${search}% ---
    if (search) {
      query = query.or(`full_name.ilike.%${search}%,dni.ilike.%${search}%,legajo.ilike.%${search}%`);
    }

    if (career_id) query = query.eq('career_id', career_id);
    if (status && status !== 'Todos') query = query.eq('status', status);

    query = query.order('last_interaction_at', { ascending: false }).range(from, to);

    const { data, error, count } = await query;
    if (error) throw error;
    
    res.json({ data, total: count, page: parseInt(page) });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error obteniendo alumnos' });
  }
});

app.post('/api/students', verifyToken, async (req, res) => {
  try {
    const { 
      full_name, dni, legajo, // <--- CAMBIO AQUÍ: Recibimos legajo
      contact_phone, career_id, 
      location, notes 
    } = req.body;

    const { data, error } = await supabase
      .from('students')
      .insert([{
        full_name,
        dni,
        legajo: legajo || null, // <--- CAMBIO AQUÍ: Lo guardamos (o null si viene vacío)
        contact_phone, 
        career_id, 
        location: location || 'Catamarca',
        general_notes: notes,
        status: 'Sólo preguntó'
      }])
      .select('id')
      .single();

    if (error) throw error;
    res.status(201).json({ message: 'Alumno creado', id: data.id });
  } catch (err) {
    // Manejo de errores de duplicados (DNI o Legajo)
    if (err.code === '23505') {
        if (err.message.includes('legajo')) {
             return res.status(400).json({ error: 'El Legajo ya existe' });
        }
        return res.status(400).json({ error: 'El DNI ya existe' });
    }
    res.status(500).json({ error: 'Error creando alumno' });
  }
});

// 4. DOCUMENTOS
// A. SUBIR DOCUMENTO (Endpoint existente por si se sube desde el panel web)
app.post('/api/students/:id/documents', verifyToken, upload.single('file'), async (req, res) => {
  try {
    const studentId = req.params.id;
    const { documentType } = req.body; 
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No se envió archivo' });

    const fileMetadata = {
      name: `${documentType}_${Date.now()}_${file.originalname}`,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID], 
    };

    const media = {
      mimeType: file.mimetype,
      body: stream.Readable.from(file.buffer),
    };

    const driveResponse = await drive.files.create({
      resource: fileMetadata, media: media, fields: 'id',
    });

    const { error } = await supabase
      .from('student_documents')
      .insert([{
        student_id: studentId,
        document_type: documentType,
        drive_file_id: driveResponse.data.id,
        file_name: file.originalname,
        mime_type: file.mimetype
      }]);

    if (error) throw error;
    res.json({ success: true, fileId: driveResponse.data.id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Fallo subida' });
  }
});

// B. DESCARGAR DOCUMENTO (Proxy: Drive -> Node -> Navegador)
// Esta es la ruta que usará el botón de descarga del panel
app.get('/api/documents/:id/download', verifyToken, async (req, res) => {
  try {
    const docId = req.params.id; // ID del registro en Supabase (no el de Drive)
    
    // 1. Obtener ID de Drive y metadatos desde Supabase
    const { data, error } = await supabase
      .from('student_documents')
      .select('drive_file_id, file_name, mime_type')
      .eq('id', docId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Documento no encontrado' });

    const { drive_file_id, file_name, mime_type } = data;

    // 2. Pedir el archivo (stream) a Google Drive usando las credenciales del servidor
    const driveStream = await drive.files.get(
      { fileId: drive_file_id, alt: 'media' },
      { responseType: 'stream' }
    );

    // 3. Enviar el stream al cliente (navegador) forzando la descarga
    res.setHeader('Content-Disposition', `attachment; filename="${file_name}"`);
    res.setHeader('Content-Type', mime_type);
    
    driveStream.data
      .on('end', () => console.log('Descarga completada'))
      .on('error', err => {
        console.error('Error en stream de Drive:', err);
        res.status(500).end();
      })
      .pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error descargando archivo' });
  }
});

app.get('/api/students/:id', verifyToken, async (req, res) => {
    try {
        const studentId = req.params.id;
        const [studentRes, docsRes] = await Promise.all([
            supabase.from('students').select('*, careers(*)').eq('id', studentId).single(),
            supabase.from('student_documents').select('*').eq('student_id', studentId)
        ]);

        if (studentRes.error) return res.status(404).json({ error: 'No encontrado' });

        res.json({
            student: studentRes.data,
            documents: docsRes.data || []
        });
    } catch (err) {
        res.status(500).json({ error: 'Error servidor' });
    }
});

// --- RUTA NUEVA: Generar Texto con IA (Proxy Seguro) ---
app.post('/api/ai/generate', verifyToken, async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'Prompt requerido' });

    // 1. Limpieza de la llave (Vital para evitar errores de espacios)
    const rawKey = process.env.OPENROUTER_API_KEY;
    const apiKey = rawKey ? rawKey.trim() : "";

    console.log("🔑 Enviando a OpenRouter...", apiKey ? "OK (Key presente)" : "ERROR (Key vacía)");

    // 2. Petición a OpenRouter
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://vintex.net.br", // Requerido por OpenRouter
        "X-Title": "Vintex AI",                  // Requerido por OpenRouter
      },
      body: JSON.stringify({
        model: "xiaomi/mimo-v2-flash:free",
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!response.ok) {
      const errData = await response.text();
      console.error("❌ Error OpenRouter:", response.status, errData);
      // Si el error es 401, avisamos claramente que la llave está mal
      if (response.status === 401) {
          return res.status(401).json({ error: 'La API Key de OpenRouter ha caducado o es inválida.' });
      }
      return res.status(response.status).json({ error: `Error proveedor IA (${response.status})` });
    }

    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content || "No se pudo generar respuesta.";
    
    res.json({ result: resultText });

  } catch (err) {
    console.error("🔥 Error Servidor IA:", err.message);
    res.status(500).json({ error: 'Error interno del servidor IA' });
  }
});

app.listen(port, () => {
  console.log(`📡 Backend Punto Kennedy (SQL Update) activo puerto ${port}`);
});