// server.js - Satélite Punto Kennedy
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');

const app = express();
const port = process.env.PORT || 4000;

// --- CONFIGURACIÓN ---
app.use(cors());
app.use(express.json());

// 1. Base de Datos (PostgreSQL Privada del Satélite)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 2. Configuración de Google Drive (Service Account)
// Asegúrate de tener el archivo 'service-account.json' en la raíz o usar variables de entorno
const auth = new google.auth.GoogleAuth({
  keyFile: 'service-account.json', // Tu archivo de credenciales de GCP
  scopes: ['https://www.googleapis.com/auth/drive'],
});
const drive = google.drive({ version: 'v3', auth });

// Configuración de Multer (Almacenamiento temporal en RAM para subida rápida)
const upload = multer({ storage: multer.memoryStorage() });

// --- MIDDLEWARE DE SEGURIDAD (Vintex Auth) ---
const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) return res.status(401).json({ error: 'Token requerido' });

  // Verificamos la firma usando el secreto compartido con el Master (Supabase)
  jwt.verify(token, process.env.SUPABASE_JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Token inválido o expirado' });
    req.user = user; // Inyectamos el usuario en la request
    next();
  });
};

// --- RUTAS DE LA API (Endpoints) ---

// A. OBTENER ALUMNOS (Con Filtros y Búsqueda)
app.get('/api/students', verifyToken, async (req, res) => {
  try {
    const { search, location, status, page = 1 } = req.query;
    const limit = 20;
    const offset = (page - 1) * limit;

    let query = `
      SELECT id, full_name, dni, career_interest, status, location, last_interaction_at 
      FROM students 
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 1;

    // Filtro inteligente (Busca por Nombre O DNI)
    if (search) {
      query += ` AND (full_name ILIKE $${paramCount} OR dni ILIKE $${paramCount})`;
      params.push(`%${search}%`);
      paramCount++;
    }

    // Filtro por Sede (Vital para Florencia y Rita)
    if (location && location !== 'Todas') {
      query += ` AND location = $${paramCount}`;
      params.push(location);
      paramCount++;
    }

    if (status) {
        query += ` AND status = $${paramCount}`;
        params.push(status);
        paramCount++;
    }

    query += ` ORDER BY last_interaction_at DESC LIMIT $${paramCount} OFFSET $${paramCount + 1}`;
    params.push(limit, offset);

    const result = await pool.query(query, params);
    
    // Contar total para paginación
    const countResult = await pool.query('SELECT COUNT(*) FROM students');
    
    res.json({
      data: result.rows,
      total: parseInt(countResult.rows[0].count),
      page: parseInt(page)
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al obtener alumnos' });
  }
});

// B. CREAR NUEVO PROSPECTO/ALUMNO
app.post('/api/students', verifyToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { 
      full_name, dni, contact_phone, contact_email, 
      career_interest, location, is_student_the_contact, contact_person_name,
      notes 
    } = req.body;

    const query = `
      INSERT INTO students (
        full_name, dni, contact_phone, contact_email, 
        career_interest, location, is_student_the_contact, contact_person_name,
        general_notes, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Sólo preguntó')
      RETURNING id
    `;
    
    const values = [
      full_name, dni, contact_phone, contact_email,
      career_interest, location || 'Catamarca', is_student_the_contact, contact_person_name,
      notes
    ];

    const result = await client.query(query, values);
    
    // Crear carpeta base en Drive para este alumno (Opcional, para orden)
    // createDriveFolder(dni + '_' + full_name); 

    await client.query('COMMIT');
    res.status(201).json({ message: 'Alumno creado', id: result.rows[0].id });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: 'Error creando alumno (Posible DNI duplicado)' });
  } finally {
    client.release();
  }
});

// C. SUBIR DOCUMENTOS (Proxy: React -> Node -> Google Drive)
app.post('/api/students/:id/documents', verifyToken, upload.single('file'), async (req, res) => {
  try {
    const studentId = req.params.id;
    const { documentType } = req.body; // Ej: 'DNI Frontal'
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'No se envió archivo' });

    // 1. Subir a Google Drive
    const fileMetadata = {
      name: `${documentType}_${Date.now()}_${file.originalname}`,
      parents: [process.env.GOOGLE_DRIVE_FOLDER_ID], // ID de la carpeta "PuntoKennedy_Legajos"
    };

    const media = {
      mimeType: file.mimetype,
      body: stream.Readable.from(file.buffer),
    };

    const driveResponse = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id, webViewLink',
    });

    // 2. Guardar referencia en SQL
    const query = `
      INSERT INTO student_documents (student_id, document_type, drive_file_id, file_name, mime_type)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, drive_file_id
    `;
    
    await pool.query(query, [
      studentId, 
      documentType, 
      driveResponse.data.id, 
      file.originalname,
      file.mimetype
    ]);

    res.json({ success: true, fileId: driveResponse.data.id });

  } catch (err) {
    console.error('Error subiendo a Drive:', err);
    res.status(500).json({ error: 'Fallo la subida del documento' });
  }
});

// D. DESCARGAR DOCUMENTOS (Proxy: Drive -> Node -> Navegador)
// Esto permite descargar sin hacer público el archivo
app.get('/api/documents/:id/download', verifyToken, async (req, res) => {
  try {
    const docId = req.params.id;
    
    // 1. Obtener ID de Drive de la DB
    const result = await pool.query('SELECT drive_file_id, file_name, mime_type FROM student_documents WHERE id = $1', [docId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Documento no encontrado' });

    const { drive_file_id, file_name, mime_type } = result.rows[0];

    // 2. Pedir el stream a Google
    const driveStream = await drive.files.get(
      { fileId: drive_file_id, alt: 'media' },
      { responseType: 'stream' }
    );

    // 3. Pipear (retransmitir) al cliente
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

// E. DETALLE COMPLETO DEL ALUMNO (Para el Modal)
app.get('/api/students/:id', verifyToken, async (req, res) => {
    try {
        const studentId = req.params.id;

        // Datos básicos
        const studentRes = await pool.query('SELECT * FROM students WHERE id = $1', [studentId]);
        
        // Documentos
        const docsRes = await pool.query('SELECT id, document_type, file_name, uploaded_at FROM student_documents WHERE student_id = $1', [studentId]);

        if (studentRes.rows.length === 0) return res.status(404).json({ error: 'Alumno no encontrado' });

        res.json({
            student: studentRes.rows[0],
            documents: docsRes.rows
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error del servidor' });
    }
});

app.listen(port, () => {
  console.log(`📡 Satélite Punto Kennedy activo en puerto ${port}`);
});