require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');

const app = express();
const port = process.env.PORT || 4001;

// --- 1. CONFIGURACIÓN CORS ---
const allowedOrigins = [
  'http://localhost:5173',
  'https://vintex.net.br',
  'https://www.vintex.net.br'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }
    return callback(null, true); // Modo permisivo para evitar bloqueos
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));

// --- 2. CONEXIÓN SUPABASE ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// --- 3. CONEXIÓN GOOGLE DRIVE ---
let drive;
try {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'service-account.json',
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  drive = google.drive({ version: 'v3', auth });
  console.log("✅ Google Drive Conectado");
} catch (error) {
  console.error("❌ Error Drive:", error.message);
}

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// --- MIDDLEWARES ---
const verifyToken = (req, res, next) => {
  // Puedes descomentar la validación real si la necesitas
  // const token = req.headers['authorization']?.split(' ')[1];
  // if (!token) return res.status(401).json({ error: 'Token requerido' });
  req.user = { email: 'admin@sistema.com' }; 
  next();
};

const bypassAuth = (req, res, next) => {
  req.user = { email: 'admin@sistema.com' };
  req.staffProfile = { rol: 'admin', sede: 'Catamarca' };
  next();
};


// ==========================================
//              RUTAS API
// ==========================================

// --- 1. OBTENER ALUMNOS (Tabla 'student') ---
app.get('/api/students', verifyToken, async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const limit = 50;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabase
      .from('student') // OJO: Tabla singular 'student'
      .select('*', { count: 'exact' });

    // Búsqueda en columnas en español (usamos comillas dobles para nombres con espacios)
    if (search) {
      query = query.or(`full_name.ilike.%${search}%,"numero Identificacion".ilike.%${search}%,legdef.ilike.%${search}%`);
    }

    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(from, to);

    if (error) throw error;

    // MAPEO DE DATOS (Español -> Frontend English)
    const mappedData = data.map(s => ({
      id: s.id,
      full_name: s.full_name,
      dni: s['numero Identificacion'],      // Mapeo clave
      legajo: s.legdef,                     // Mapeo clave
      contact_phone: s.telefono1,           // Mapeo clave
      contact_email: s['correo Personal'],
      location: s['codPuntoKennedy'] || 'S/D',
      career_name: s['nombrePrograma'] || 'Sin Programa',
      status: 'Importado',                  // Default ya que la tabla no tiene status
      general_notes: '',                    // Default
      bot_students: true,                   // Asumimos activo para bot
      last_interaction_at: s.created_at
    }));

    res.json({ 
      data: mappedData, 
      total: count, 
      page: parseInt(page), 
      userRole: 'admin' 
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error obteniendo alumnos' });
  }
});

// --- 2. DETALLE ALUMNO + DOCUMENTOS (Drive) ---
app.get('/api/students/:id', verifyToken, async (req, res) => {
  try {
    const { id } = req.params;

    // A. Buscar Alumno
    const { data: s, error } = await supabase
      .from('student')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !s) return res.status(404).json({ error: 'Alumno no encontrado' });

    // Preparamos el objeto para el frontend
    const student = {
      id: s.id,
      full_name: s.full_name,
      dni: s['numero Identificacion'],
      legajo: s.legdef,
      contact_phone: s.telefono1,
      location: s['codPuntoKennedy'],
      career_name: s['nombrePrograma'],
      status: 'Importado',
      general_notes: ''
    };

    // B. Buscar Documentos (Usando el teléfono como nexo)
    let documents = [];
    // Limpiamos el teléfono para buscar coincidencias
    const rawPhone = s.telefono1 || '';
    const cleanPhone = rawPhone.replace(/\D/g, ''); // Solo números

    if (cleanPhone.length > 5) {
        // Buscamos en student_documents por student_phone
        const docQuery = await supabase
            .from('student_documents')
            .select('*')
            .eq('student_phone', cleanPhone)
            .order('uploaded_at', { ascending: false });
        
        documents = docQuery.data || [];
    }

    res.json({ student, documents });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// --- 3. SUBIR DOCUMENTO (A Google Drive) ---
app.post('/api/students/phone/:phone/documents', verifyToken, upload.single('file'), async (req, res) => {
  try {
    if (!drive) return res.status(503).json({ error: 'Drive no disponible' });
    
    const rawPhone = req.params.phone;
    const cleanPhone = rawPhone.replace(/\D/g, '');
    const { documentType } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'Falta archivo' });

    // 1. Subir a Google Drive
    const fileMetadata = {
      name: `${cleanPhone}_${documentType}_${file.originalname}`,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID], // ID de carpeta en .env
    };
    const media = {
      mimeType: file.mimetype,
      body: stream.Readable.from(file.buffer),
    };

    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id',
    });

    // 2. Guardar referencia en Supabase
    const { data, error } = await supabase
      .from('student_documents')
      .insert([{
        student_phone: cleanPhone,
        document_type: documentType,
        drive_file_id: driveResponse.data.id, // ID real de Google
        file_name: file.originalname,
        mime_type: file.mimetype,
        uploaded_at: new Date()
      }])
      .select()
      .single();

    if (error) throw error;

    res.json({ success: true, message: 'Subido a Drive', id: data.id });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir archivo' });
  }
});

// --- 4. DESCARGAR DOCUMENTO (Desde Drive) ---
app.get('/api/documents/:id/download', verifyToken, async (req, res) => {
  try {
    if (!drive) return res.status(503).json({ error: 'Drive no disponible' });

    // 1. Obtener ID de Drive desde Supabase
    const { data: doc, error } = await supabase
      .from('student_documents')
      .select('*')
      .eq('id', req.params.id)
      .single();

    if (error || !doc) return res.status(404).json({ error: 'Documento no encontrado' });

    // 2. Pedir stream a Google Drive
    const driveStream = await drive.files.get(
      { fileId: doc.drive_file_id, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Disposition', `attachment; filename="${doc.file_name}"`);
    res.setHeader('Content-Type', doc.mime_type);
    
    driveStream.data.pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error en descarga' });
  }
});

// --- 5. OTRAS RUTAS (Bot, Staff) ---
app.get('/api/bot', bypassAuth, async (req, res) => {
  const { data } = await supabase.from('bot_settings').select('*').single();
  res.json(data || {});
});

app.get('/api/careers', async (req, res) => {
    // Si tienes tabla careers úsala, si no, devuelve vacío o extrae de 'student' con distinct
    res.json([]); 
});

// --- ARRANQUE ---
app.listen(port, () => {
  console.log(`🚀 KENNEDY BACKEND (Supabase + G-Drive) en puerto ${port}`);
});