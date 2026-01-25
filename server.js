require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');

const app = express();
const port = process.env.PORT || 4001;

console.log("---------------------------------------------------------");
console.log("🛠️  INICIANDO SERVIDOR VINTEX BACKEND - MODO DEBUG 🛠️");
console.log("---------------------------------------------------------");

// --- 1. CONFIGURACIÓN CORS ---
const allowedOrigins = [
  'http://localhost:5173',
  'https://vintex.net.br',
  'https://www.vintex.net.br'
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) {
        console.log(`🌍 [CORS] Petición sin origen (posiblemente local/postman): Aceptada`);
        return callback(null, true);
    }
    if (allowedOrigins.indexOf(origin) !== -1) {
      console.log(`🌍 [CORS] Origen permitido: ${origin}`);
      return callback(null, true);
    }
    console.log(`⚠️ [CORS] Origen NO explícito, pero aceptando en modo permisivo: ${origin}`);
    return callback(null, true); // Modo permisivo
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));

// --- LOGGER GENERAL DE PETICIONES ---
app.use((req, res, next) => {
    console.log(`\n📥 [REQUEST] ${req.method} ${req.url}`);
    if (Object.keys(req.body).length > 0) console.log(`   📦 Body:`, JSON.stringify(req.body, null, 2));
    if (Object.keys(req.query).length > 0) console.log(`   🔍 Query:`, JSON.stringify(req.query, null, 2));
    next();
});

// --- 2. CONEXIÓN SUPABASE ---
console.log("🔌 [INIT] Conectando a Supabase...");
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
console.log("✅ [INIT] Cliente Supabase Inicializado");

// --- 3. CONEXIÓN GOOGLE DRIVE ---
let drive;
try {
  console.log("🔌 [INIT] Conectando a Google Drive...");
  const auth = new google.auth.GoogleAuth({
    keyFile: 'service-account.json',
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  drive = google.drive({ version: 'v3', auth });
  console.log("✅ [INIT] Google Drive Conectado Correctamente");
} catch (error) {
  console.error("❌ [INIT ERROR] Falló conexión a Drive:", error.message);
}

const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// --- MIDDLEWARES ---
const verifyToken = (req, res, next) => {
  console.log("🛡️  [AUTH] Verificando Token...");
  // SIEMPRE LOGUEAR ESTO PARA VERIFICAR SI LLEGA EL HEADER
  // const authHeader = req.headers['authorization'];
  // console.log("   🔑 Header recibido:", authHeader ? "SI" : "NO");
  
  // MOCK ACTUAL (Pasa siempre)
  req.user = { email: 'admin@sistema.com' }; 
  console.log("   🔓 [AUTH] Token aceptado (Bypass activo)");
  next();
};

const bypassAuth = (req, res, next) => {
  console.log("🛡️  [AUTH] Bypass Total activado para esta ruta");
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
    console.log(`🔎 [DB] Buscando alumnos. Pagina: ${page}, Filtro: '${search || "NINGUNO"}'`);

    const limit = 50;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    let query = supabase
      .from('student')
      .select('*', { count: 'exact' });

    if (search) {
      console.log(`   🏗️ [DB] Aplicando filtro ILIKE...`);
      query = query.or(`full_name.ilike.%${search}%,"numero Identificacion".ilike.%${search}%,legdef.ilike.%${search}%`);
    }

    const start = Date.now();
    const { data, count, error } = await query
      .order('created_at', { ascending: false })
      .range(from, to);
    const end = Date.now();

    if (error) {
        console.error("❌ [DB ERROR] Error en query 'student':", error);
        throw error;
    }

    console.log(`✅ [DB] Consulta exitosa en ${end - start}ms. Registros encontrados: ${data.length} (Total: ${count})`);

    // MAPEO DE DATOS
    const mappedData = data.map(s => ({
      id: s.id,
      full_name: s.full_name,
      dni: s['numero Identificacion'],
      legajo: s.legdef,
      contact_phone: s.telefono1,
      contact_email: s['correo Personal'],
      location: s['codPuntoKennedy'] || 'S/D',
      career_name: s['nombrePrograma'] || 'Sin Programa',
      status: 'Importado',
      general_notes: '',
      bot_students: true,
      last_interaction_at: s.created_at
    }));

    res.json({ 
      data: mappedData, 
      total: count, 
      page: parseInt(page), 
      userRole: 'admin' 
    });

  } catch (err) {
    console.error("💥 [SERVER ERROR] GET /api/students:", err.message);
    res.status(500).json({ error: 'Error obteniendo alumnos' });
  }
});

// --- 2. DETALLE ALUMNO + DOCUMENTOS (Drive) ---
app.get('/api/students/:id', verifyToken, async (req, res) => {
  const { id } = req.params;
  console.log(`👤 [DB] Buscando detalle alumno ID: ${id}`);

  try {
    // A. Buscar Alumno
    const { data: s, error } = await supabase
      .from('student')
      .select('*')
      .eq('id', id)
      .single();

    if (error || !s) {
        console.warn(`⚠️ [DB] Alumno no encontrado o error:`, error);
        return res.status(404).json({ error: 'Alumno no encontrado' });
    }
    console.log(`   ✅ [DB] Alumno encontrado: ${s.full_name}`);

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

    // B. Buscar Documentos
    let documents = [];
    const rawPhone = s.telefono1 || '';
    const cleanPhone = rawPhone.replace(/\D/g, ''); 
    console.log(`   📂 [DB] Buscando documentos para teléfono: ${cleanPhone} (Original: ${rawPhone})`);

    if (cleanPhone.length > 5) {
        const docQuery = await supabase
            .from('student_documents')
            .select('*')
            .eq('student_phone', cleanPhone)
            .order('uploaded_at', { ascending: false });
        
        if (docQuery.error) console.error("   ❌ [DB ERROR] Error buscando documentos:", docQuery.error);
        
        documents = docQuery.data || [];
        console.log(`   ✅ [DB] Documentos encontrados: ${documents.length}`);
    } else {
        console.log(`   ⚠️ [DB] Teléfono inválido o muy corto, saltando búsqueda de docs.`);
    }

    res.json({ student, documents });

  } catch (err) {
    console.error("💥 [SERVER ERROR] GET /api/students/:id", err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// --- 3. SUBIR DOCUMENTO (A Google Drive) ---
app.post('/api/students/phone/:phone/documents', verifyToken, upload.single('file'), async (req, res) => {
  const rawPhone = req.params.phone;
  console.log(`📤 [UPLOAD] Iniciando carga de archivo para teléfono: ${rawPhone}`);

  try {
    if (!drive) {
        console.error("❌ [DRIVE] El servicio de Drive no está inicializado.");
        return res.status(503).json({ error: 'Drive no disponible' });
    }
    
    const cleanPhone = rawPhone.replace(/\D/g, '');
    const { documentType } = req.body;
    const file = req.file;

    if (!file) {
        console.error("❌ [UPLOAD] No se recibió ningún archivo en el body.");
        return res.status(400).json({ error: 'Falta archivo' });
    }

    console.log(`   📄 Archivo: ${file.originalname} (${file.mimetype}) - Tipo: ${documentType}`);

    // 1. Subir a Google Drive
    console.log(`   ☁️ [DRIVE] Subiendo stream a Google Drive...`);
    const fileMetadata = {
      name: `${cleanPhone}_${documentType}_${file.originalname}`,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID],
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
    console.log(`   ✅ [DRIVE] Archivo subido. ID Google: ${driveResponse.data.id}`);

    // 2. Guardar referencia en Supabase
    console.log(`   💾 [DB] Guardando referencia en tabla 'student_documents'...`);
    const { data, error } = await supabase
      .from('student_documents')
      .insert([{
        student_phone: cleanPhone,
        document_type: documentType,
        drive_file_id: driveResponse.data.id, 
        file_name: file.originalname,
        mime_type: file.mimetype,
        uploaded_at: new Date()
      }])
      .select()
      .single();

    if (error) {
        console.error("   ❌ [DB ERROR] Falló al guardar referencia:", error);
        throw error;
    }

    console.log(`   ✅ [DB] Referencia guardada ID: ${data.id}`);
    res.json({ success: true, message: 'Subido a Drive', id: data.id });

  } catch (err) {
    console.error("💥 [SERVER ERROR] Upload failed:", err);
    res.status(500).json({ error: 'Error al subir archivo' });
  }
});

// --- 4. DESCARGAR DOCUMENTO (Desde Drive) ---
app.get('/api/documents/:id/download', verifyToken, async (req, res) => {
  const docId = req.params.id;
  console.log(`⬇️ [DOWNLOAD] Solicitud de descarga doc ID: ${docId}`);

  try {
    if (!drive) return res.status(503).json({ error: 'Drive no disponible' });

    // 1. Obtener ID de Drive desde Supabase
    const { data: doc, error } = await supabase
      .from('student_documents')
      .select('*')
      .eq('id', docId)
      .single();

    if (error || !doc) {
        console.error("❌ [DB] Documento no encontrado en base de datos.");
        return res.status(404).json({ error: 'Documento no encontrado' });
    }
    
    console.log(`   ✅ [DB] Metadata encontrada. Drive File ID: ${doc.drive_file_id}`);
    console.log(`   ☁️ [DRIVE] Obteniendo stream del archivo...`);

    // 2. Pedir stream a Google Drive
    const driveStream = await drive.files.get(
      { fileId: doc.drive_file_id, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Disposition', `attachment; filename="${doc.file_name}"`);
    res.setHeader('Content-Type', doc.mime_type);
    
    driveStream.data.pipe(res);
    console.log(`   ✅ [DOWNLOAD] Stream enviado al cliente.`);

  } catch (err) {
    console.error("💥 [SERVER ERROR] Download failed:", err.message);
    res.status(500).json({ error: 'Error en descarga' });
  }
});

// --- 5. OTRAS RUTAS ---
app.get('/api/bot', bypassAuth, async (req, res) => {
  console.log("🤖 [BOT] Consultando configuraciones...");
  const { data } = await supabase.from('bot_settings').select('*').single();
  res.json(data || {});
});

app.get('/api/careers', async (req, res) => {
    console.log("📚 [API] Consultando carreras (Mock vacío)");
    res.json([]); 
});

// --- ARRANQUE ---
app.listen(port, () => {
  console.log(`\n🚀 KENNEDY BACKEND (Supabase + G-Drive) ESCUCHANDO EN PUERTO ${port}`);
  console.log(`   ➜ Local: http://localhost:${port}`);
  console.log("---------------------------------------------------------");
});