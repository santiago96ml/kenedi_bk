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

// Configuración CORS y JSON
app.use(cors());
app.use(express.json());

// --- CONFIGURACIÓN SUPABASE ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- CONFIGURACIÓN GOOGLE DRIVE ---
const auth = new google.auth.GoogleAuth({
  keyFile: 'service-account.json', 
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });
const upload = multer({ storage: multer.memoryStorage() });

// --- MIDDLEWARE DE AUTENTICACIÓN ---
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  
  if (!token) return res.status(401).json({ error: 'Token requerido' });

  jwt.verify(token, process.env.SUPABASE_JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
    req.user = user;
    next();
  });
};

// ==========================================
//               RUTAS DE API
// ==========================================

// 1. CARRERAS (Oferta Académica)
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

// 2. CONFIGURACIÓN DEL BOT
app.get('/api/bot', verifyToken, async (req, res) => {
  try {
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

// 3. ALUMNOS (Búsqueda Completa: Nombre, DNI, Legajo)
app.get('/api/students', verifyToken, async (req, res) => {
  try {
    const { search, career_id, status, page = 1 } = req.query;
    const limit = 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabase
      .from('students')
      .select(`
        *,
        careers ( name, fees )
      `, { count: 'exact' });

    // Búsqueda multi-campo (incluye Legajo)
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
      full_name, dni, legajo, 
      contact_phone, career_id, 
      location, notes 
    } = req.body;

    const { data, error } = await supabase
      .from('students')
      .insert([{
        full_name,
        dni,
        legajo: legajo || null, 
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
    if (err.code === '23505') {
        if (err.message.includes('legajo')) return res.status(400).json({ error: 'El Legajo ya existe' });
        return res.status(400).json({ error: 'El DNI ya existe' });
    }
    res.status(500).json({ error: 'Error creando alumno' });
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

// NUEVA RUTA: Actualizar solo las Notas
app.patch('/api/students/:id/notes', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;

    const { data, error } = await supabase
      .from('students')
      .update({ general_notes: notes, updated_at: new Date() })
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;
    res.json({ success: true, data });
  } catch (err) {
    console.error("Error updating notes:", err);
    res.status(500).json({ error: 'Error actualizando notas' });
  }
});

// 4. DOCUMENTOS (Google Drive)
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

app.get('/api/documents/:id/download', verifyToken, async (req, res) => {
  try {
    const docId = req.params.id; 
    
    const { data, error } = await supabase
      .from('student_documents')
      .select('drive_file_id, file_name, mime_type')
      .eq('id', docId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Documento no encontrado' });

    const driveStream = await drive.files.get(
      { fileId: data.drive_file_id, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Disposition', `attachment; filename="${data.file_name}"`);
    res.setHeader('Content-Type', data.mime_type);
    
    driveStream.data
      .on('error', err => {
        console.error('Error stream Drive:', err);
        res.status(500).end();
      })
      .pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error descargando archivo' });
  }
});

// 5. HISTORIAL DE CHAT (n8n Integration)
app.get('/api/chat-history/:phone', verifyToken, async (req, res) => {
  try {
    const rawPhone = req.params.phone;
    const phone = rawPhone.replace(/\D/g, ''); // Limpiar teléfono

    if (!phone || phone.length < 5) return res.json([]); 

    // Buscar en historial (match parcial en session_id)
    const { data, error } = await supabase
      .from('n8n_chat_histories')
      .select('message') 
      .ilike('session_id', `%${phone}%`)
      .order('id', { ascending: true })
      .limit(100);

    if (error) throw error;
    res.json(data);

  } catch (err) {
    console.error("Error fetching chat history:", err);
    res.status(500).json({ error: 'Error obteniendo historial' });
  }
});

// 6. INTELIGENCIA ARTIFICIAL (OpenRouter Proxy)
app.post('/api/ai/generate', verifyToken, async (req, res) => {
  try {
    // Aceptamos 'prompt' (texto simple) O 'messages' (historial chat)
    const { prompt, messages } = req.body;

    if (!prompt && !messages) {
        return res.status(400).json({ error: 'Datos (Prompt o Messages) requeridos' });
    }

    const rawKey = process.env.OPENROUTER_API_KEY;
    const apiKey = rawKey ? rawKey.trim() : "";

    if (!apiKey) console.warn("⚠️ API Key no configurada en .env");

    // Construcción inteligente del payload
    const payloadMessages = messages ? messages : [{ role: "user", content: prompt }];

    console.log(`🧠 IA Request: ${messages ? messages.length + " msgs" : "Prompt simple"}`);

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://vintex.net.br", 
        "X-Title": "Vintex Kennedy AI",
      },
      body: JSON.stringify({
        model: "xiaomi/mimo-v2-flash:free", 
        messages: payloadMessages,
      })
    });

    if (!response.ok) {
      const errData = await response.text();
      console.error("❌ Error OpenRouter:", response.status, errData);
      return res.status(response.status).json({ error: `IA Error (${response.status}): ${errData}` });
    }

    const data = await response.json();
    const resultText = data.choices?.[0]?.message?.content || "Sin respuesta.";
    
    res.json({ result: resultText });

  } catch (err) {
    console.error("🔥 Error Servidor IA:", err.message);
    res.status(500).json({ error: 'Error interno del servidor IA' });
  }
});

// --- INICIO DEL SERVIDOR ---
app.listen(port, () => {
  console.log(`📡 Backend Kennedy (vFinal) corriendo en puerto ${port}`);
});