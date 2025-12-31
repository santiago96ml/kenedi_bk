// server.js - Satélite Punto Kennedy (Versión Supabase Client)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js'); // ✅ Cambio principal
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');

const app = express();
const port = process.env.PORT || 4001;

// --- CONFIGURACIÓN ---
app.use(cors());
app.use(express.json());

// 1. Conexión a Supabase (Cliente Oficial)
// Usamos la SERVICE_ROLE_KEY para tener permisos de administrador (leer/escribir todo)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// 2. Configuración de Google Drive (Service Account)
// Asegúrate de tener el archivo 'service-account.json' en la raíz
const auth = new google.auth.GoogleAuth({
  keyFile: 'service-account.json', 
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

// Configuración de Multer (Almacenamiento temporal en RAM)
const upload = multer({ storage: multer.memoryStorage() });

// --- MIDDLEWARE DE SEGURIDAD (Vintex Auth) ---
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token requerido' });

  // Verificamos el token firmado por el MASTER usando su secreto
  jwt.verify(token, process.env.SUPABASE_JWT_SECRET, (err, user) => {
    if (err) {
      console.error("❌ ERROR JWT:", err.message); 
      return res.status(403).json({ error: 'Token inválido o expirado' });
    }
    req.user = user;
    next();
  });
};

// --- RUTAS DE LA API (Endpoints) ---

// A. OBTENER ALUMNOS (Con Filtros y Búsqueda)
app.get('/api/students', verifyToken, async (req, res) => {
  try {
    const { search, location, status, page = 1 } = req.query;
    const limit = 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Construcción de la consulta ("Query Builder")
    let query = supabase
      .from('students')
      .select('id, full_name, dni, career_interest, status, location, last_interaction_at', { count: 'exact' });

    // 1. Filtro inteligente (Busca por Nombre O DNI)
    if (search) {
      // Sintaxis de Supabase para OR: "columna.operador.valor, columna.operador.valor"
      query = query.or(`full_name.ilike.%${search}%,dni.ilike.%${search}%`);
    }

    // 2. Filtro por Sede
    if (location && location !== 'Todas') {
      query = query.eq('location', location);
    }

    // 3. Filtro por Estado
    if (status && status !== 'Todos') {
      query = query.eq('status', status);
    }

    // Ordenamiento y Paginación
    query = query
      .order('last_interaction_at', { ascending: false })
      .range(from, to);

    // Ejecutar consulta
    const { data, error, count } = await query;

    if (error) throw error;
    
    res.json({
      data: data,
      total: count,
      page: parseInt(page)
    });

  } catch (err) {
    console.error('Error Supabase:', err.message);
    res.status(500).json({ error: 'Error al obtener alumnos' });
  }
});

// B. CREAR NUEVO PROSPECTO/ALUMNO
app.post('/api/students', verifyToken, async (req, res) => {
  try {
    const { 
      full_name, dni, contact_phone, contact_email, 
      career_interest, location, is_student_the_contact, contact_person_name,
      notes 
    } = req.body;

    const { data, error } = await supabase
      .from('students')
      .insert([
        {
          full_name,
          dni,
          contact_phone,
          contact_email,
          career_interest,
          location: location || 'Catamarca',
          is_student_the_contact,
          contact_person_name,
          general_notes: notes,
          status: 'Sólo preguntó'
        }
      ])
      .select('id') // Pedimos que nos devuelva el ID creado
      .single();

    if (error) throw error;

    // Crear carpeta base en Drive (Opcional, lógica comentada igual que antes)
    // createDriveFolder(dni + '_' + full_name); 

    res.status(201).json({ message: 'Alumno creado', id: data.id });

  } catch (err) {
    console.error('Error creando alumno:', err.message);
    // Manejo de duplicados (código de error Postgres para Unique Violation es 23505)
    if (err.code === '23505') {
        res.status(500).json({ error: 'El DNI ya existe en la base de datos' });
    } else {
        res.status(500).json({ error: 'Error creando alumno' });
    }
  }
});

// C. SUBIR DOCUMENTOS (Proxy: React -> Node -> Google Drive -> DB)
app.post('/api/students/:id/documents', verifyToken, upload.single('file'), async (req, res) => {
  try {
    const studentId = req.params.id;
    const { documentType } = req.body; 
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No se envió archivo' });

    // 1. Subir a Google Drive (Esto sigue igual, usa la librería de Google)
    const fileMetadata = {
      name: `${documentType}_${Date.now()}_${file.originalname}`,
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

    // 2. Guardar referencia en Supabase
    const { data, error } = await supabase
      .from('student_documents')
      .insert([
        {
          student_id: studentId,
          document_type: documentType,
          drive_file_id: driveResponse.data.id,
          file_name: file.originalname,
          mime_type: file.mimetype
        }
      ])
      .select('id, drive_file_id')
      .single();

    if (error) throw error;

    res.json({ success: true, fileId: driveResponse.data.id });

  } catch (err) {
    console.error('Error subiendo documento:', err);
    res.status(500).json({ error: 'Fallo la subida del documento' });
  }
});

// D. DESCARGAR DOCUMENTOS (Proxy: Drive -> Node -> Navegador)
app.get('/api/documents/:id/download', verifyToken, async (req, res) => {
  try {
    const docId = req.params.id;
    
    // 1. Obtener ID de Drive desde Supabase
    const { data, error } = await supabase
      .from('student_documents')
      .select('drive_file_id, file_name, mime_type')
      .eq('id', docId)
      .single();

    if (error || !data) return res.status(404).json({ error: 'Documento no encontrado' });

    const { drive_file_id, file_name, mime_type } = data;

    // 2. Pedir el stream a Google (Igual que antes)
    const driveStream = await drive.files.get(
      { fileId: drive_file_id, alt: 'media' },
      { responseType: 'stream' }
    );

    // 3. Pipear al cliente
    res.setHeader('Content-Disposition', `attachment; filename="${file_name}"`);
    res.setHeader('Content-Type', mime_type);
    
    driveStream.data
      .on('end', () => console.log('Descarga completada'))
      .on('error', err => {
        console.error('Error en stream:', err);
        res.status(500).end();
      })
      .pipe(res);

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error descargando archivo' });
  }
});

// E. DETALLE COMPLETO DEL ALUMNO
app.get('/api/students/:id', verifyToken, async (req, res) => {
    try {
        const studentId = req.params.id;

        // Fetch en paralelo para optimizar velocidad
        const [studentRes, docsRes] = await Promise.all([
            supabase.from('students').select('*').eq('id', studentId).single(),
            supabase.from('student_documents').select('id, document_type, file_name, uploaded_at').eq('student_id', studentId)
        ]);

        if (studentRes.error) {
            return res.status(404).json({ error: 'Alumno no encontrado' });
        }

        res.json({
            student: studentRes.data,
            documents: docsRes.data || []
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

app.listen(port, () => {
  console.log(`📡 Satélite Punto Kennedy (Supabase JS) activo en puerto ${port}`);
});