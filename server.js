require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { createClient } = require('@supabase/supabase-js');
const Airtable = require('airtable');
const NodeCache = require('node-cache');
const jwt = require('jsonwebtoken');

// ==========================================
// 1. CONFIGURACIÓN E INICIALIZACIÓN
// ==========================================
const app = express();
const port = process.env.PORT || 4001;
const cache = new NodeCache({ stdTTL: 120 }); // Caché de 2 min

// --- A. Configuración CORS (Hostinger + Local) ---
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
    return callback(new Error('Bloqueado por CORS'));
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// --- B. Conexión SUPABASE (Sistema / Archivos / Bot) ---
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('❌ Falta configuración de Supabase en .env');
}
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// --- C. Conexión AIRTABLE (Datos de Alumnos) ---
if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
  console.error('❌ Falta configuración de Airtable en .env');
}
const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);

// --- D. Configuración MULTER (Almacenamiento Local) ---
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // Asegúrate de que esta carpeta exista: mkdir uploads
    cb(null, 'uploads/'); 
  },
  filename: function (req, file, cb) {
    // Nombre único: TIMESTAMP-RANDOM.ext
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 } // 50MB límite
});


// ==========================================
// 2. MIDDLEWARES DE SEGURIDAD
// ==========================================

// Validar Token JWT de Supabase
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token requerido' });

  // Si prefieres el modo "Bypass" (Inseguro) descomenta esto y comenta jwt.verify:
  // req.user = { email: 'admin@sistema.com' }; next(); return;

  jwt.verify(token, process.env.SUPABASE_JWT_SECRET, (err, decoded) => {
    if (err) {
      console.error("❌ Token inválido:", err.message);
      return res.status(403).json({ error: 'Sesión expirada' });
    }
    req.user = decoded;
    next();
  });
};

// Obtener Perfil del Staff (Rol y Sede)
const getStaffProfile = async (req, res, next) => {
  try {
    const email = req.user.email;
    const { data, error } = await supabase
      .from('perfil_staff')
      .select('rol, sede, id')
      .eq('email', email)
      .single();

    if (error || !data) return res.status(403).json({ error: 'No autorizado' });
    
    req.staffProfile = data;
    next();
  } catch (e) {
    return res.status(500).json({ error: 'Error de permisos' });
  }
};

// Solo Admins
const requireAdmin = async (req, res, next) => {
  if (req.staffProfile && req.staffProfile.rol === 'admin') {
    next();
  } else {
    return res.status(403).json({ error: 'Requiere Acceso Admin' });
  }
};


// ==========================================
// 3. RUTAS DE LA API
// ==========================================

// --- A. DOCUMENTOS (Subida Local + BD Supabase) ---

// Subir Documento (Usando Teléfono como ID)
app.post('/api/students/phone/:phone/documents', verifyToken, getStaffProfile, upload.single('file'), async (req, res) => {
  try {
    const rawPhone = req.params.phone;
    const { documentType } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'Falta archivo' });
    if (!rawPhone) return res.status(400).json({ error: 'Falta teléfono' });

    const cleanPhone = rawPhone.replace(/\D/g, ''); // Solo números

    // Guardar referencia en Supabase
    const { data, error } = await supabase.from('student_documents').insert([{
        student_phone: cleanPhone,
        document_type: documentType,
        file_name: file.originalname, // Nombre original
        drive_file_id: file.filename, // Nombre físico en disco (hack)
        mime_type: file.mimetype,
        uploaded_at: new Date()
    }]).select().single();

    if (error) {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path); // Borrar si falla BD
      throw error;
    }

    res.json({ success: true, message: 'Guardado localmente', id: data.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir' });
  }
});

// Descargar Documento
app.get('/api/documents/:id/download', verifyToken, async (req, res) => {
  try {
    // 1. Buscar en BD
    const { data: doc, error } = await supabase.from('student_documents').select('*').eq('id', req.params.id).single();
    if (error || !doc) return res.status(404).json({ error: 'No encontrado' });

    // 2. Buscar archivo físico
    const filePath = path.join(__dirname, 'uploads', doc.drive_file_id);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Archivo físico no existe' });

    // 3. Descargar
    res.download(filePath, doc.file_name);
  } catch (err) {
    res.status(500).json({ error: 'Error descargando' });
  }
});


// --- B. ALUMNOS (Lectura desde AIRTABLE) ---

// Listar Alumnos
app.get('/api/students', verifyToken, getStaffProfile, async (req, res) => {
  try {
    const { search, status, page = 1 } = req.query;
    let formula = "TRUE()"; 

    // Filtros Airtable
    if (search) {
      const s = search.toLowerCase();
      formula = `OR(SEARCH('${s}', LOWER({full_name})), SEARCH('${s}', {dni}), SEARCH('${s}', {legajo}))`;
    }
    if (status && status !== 'Todos') formula = `AND(${formula}, {status} = '${status}')`;

    const records = await base('students').select({
      filterByFormula: formula,
      sort: [{ field: "last_interaction_at", direction: "desc" }],
      pageSize: 50
    }).firstPage();

    // Mapeo de datos Airtable -> Frontend
    const data = records.map(r => ({
      id: r.id, 
      full_name: r.get('full_name'),
      dni: r.get('dni'),
      legajo: r.get('legajo'),
      contact_phone: r.get('contact_phone'),
      status: r.get('status'),
      location: r.get('location'),
      general_notes: r.get('general_notes'),
      last_interaction_at: r.get('last_interaction_at'),
      secretaria: r.get('secretaria'),
      bot_students: r.get('bot_students'),
      career_name: r.get('career_name_lookup') || 'Carrera'
    }));

    res.json({ data, total: data.length, page: parseInt(page), userRole: req.staffProfile.rol });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error conectando con Airtable' });
  }
});

// Detalle Alumno (Híbrido: Airtable + Supabase Docs)
app.get('/api/students/:id', verifyToken, async (req, res) => {
  try {
    // 1. Buscar en Airtable
    const record = await base('students').find(req.params.id);
    const rawPhone = record.get('contact_phone') || '';
    const cleanPhone = rawPhone.replace(/\D/g, '');

    const student = {
      id: record.id,
      full_name: record.get('full_name'),
      dni: record.get('dni'),
      contact_phone: rawPhone,
      location: record.get('location'),
      status: record.get('status'),
      general_notes: record.get('general_notes'),
      secretaria: record.get('secretaria'),
      bot_students: record.get('bot_students')
    };

    // 2. Buscar Documentos en Supabase (por Teléfono)
    let documents = [];
    if (cleanPhone) {
        const { data } = await supabase.from('student_documents')
            .select('*').eq('student_phone', cleanPhone).order('uploaded_at', { ascending: false });
        documents = data || [];
    }

    res.json({ student, documents });
  } catch (err) {
    res.status(404).json({ error: 'Alumno no encontrado' });
  }
});

// Crear Alumno (Airtable)
app.post('/api/students', verifyToken, async (req, res) => {
  try {
    const { full_name, dni, contact_phone, location, notes } = req.body;
    const created = await base('students').create([{
      "fields": {
        "full_name": full_name,
        "dni": dni,
        "contact_phone": contact_phone,
        "location": location,
        "status": "Sólo preguntó",
        "general_notes": notes,
        "created_at": new Date().toISOString(),
        "last_interaction_at": new Date().toISOString()
      }
    }]);
    res.json({ success: true, id: created[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Error creando en Airtable' });
  }
});

// Actualizar Perfil (Airtable)
app.patch('/api/students/:id/update-profile', verifyToken, async (req, res) => {
  try {
      await base('students').update(req.params.id, {
          "full_name": req.body.full_name,
          "dni": req.body.dni,
          "location": req.body.location,
          "status": req.body.status
      });
      res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }) }
});

// Actualizar Notas (Airtable)
app.patch('/api/students/:id/notes', verifyToken, async (req, res) => {
  try {
      await base('students').update(req.params.id, { "general_notes": req.body.notes });
      res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }) }
});


// --- C. BOT Y STAFF (Supabase Directo) ---

app.get('/api/bot', verifyToken, requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/bot', verifyToken, requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('bot_settings').update({ ...req.body, updated_at: new Date() }).eq('id', 1).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

app.get('/api/admin/staff', verifyToken, requireAdmin, async (req, res) => {
  const { data } = await supabase.from('perfil_staff').select('*').order('created_at', {ascending: false});
  res.json(data);
});

app.patch('/api/admin/staff/:id', verifyToken, requireAdmin, async (req, res) => {
  const { data, error } = await supabase.from('perfil_staff').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});


// ==========================================
// 4. INICIO DEL SERVIDOR
// ==========================================
app.get('/', (req, res) => res.send('🚀 Kennedy Backend Híbrido (Airtable + LocalFS) Online'));

app.listen(port, () => {
  console.log(`✅ Servidor corriendo en puerto ${port}`);
  console.log(`📂 Carpeta uploads configurada: ${path.join(__dirname, 'uploads')}`);
});