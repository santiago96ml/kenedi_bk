require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
// IA LIBS
const OpenAI = require('openai');
const pdf = require('pdf-parse'); 

const app = express();
const port = process.env.PORT || 4001;

// ==========================================
// 1. CONFIGURACIÓN INICIAL
// ==========================================

// --- CORS ---
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
    return callback(null, true);
  },
  credentials: true
}));

app.use(express.json({ limit: '50mb' }));

// --- CONEXIÓN SUPABASE ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// --- CONEXIÓN GOOGLE DRIVE ---
let drive;
try {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'service-account.json',
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  drive = google.drive({ version: 'v3', auth });
  console.log("✅ [INIT] Google Drive Conectado");
} catch (error) {
  console.error("❌ [INIT ERROR] Drive no disponible:", error.message);
}

// --- CONEXIÓN IA (OPENROUTER) ---
const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY, 
});

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// ==========================================
// 2. MIDDLEWARES DE SEGURIDAD
// ==========================================

const verifyUser = async (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1]; 
  
  if (!token) {
      console.log("⚠️ [AUTH] Sin token, usando modo Bypass Admin");
      req.user = { id: 'admin-bypass', email: 'admin@test.com' };
      req.staffProfile = { rol: 'admin', sede: 'Catamarca' }; 
      return next();
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) throw new Error("Token inválido");

    const { data: profile } = await supabase
        .from('perfil_staff')
        .select('*')
        .eq('email', user.email)
        .single();

    req.user = user;
    req.staffProfile = profile || { rol: null, sede: null };
    next();
  } catch (err) {
    console.error("Auth Error:", err.message);
    return res.status(401).json({ error: 'No autorizado' });
  }
};

// ==========================================
// 3. RUTAS DE AUTENTICACIÓN
// ==========================================

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) return res.status(401).json({ error: 'Credenciales inválidas' });

    const { data: profile } = await supabase.from('perfil_staff').select('*').eq('email', email).single();

    res.json({
      success: true,
      token: authData.session.access_token,
      user: {
        id: authData.user.id,
        email: authData.user.email,
        rol: profile?.rol || null,
        sede: profile?.sede || null,
        nombre: profile?.nombre || 'Usuario'
      }
    });
  } catch (err) { res.status(500).json({ error: 'Error interno' }); }
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, nombre, sede } = req.body;
    const { data: authData, error: authError } = await supabase.auth.signUp({ email, password });
    if (authError) return res.status(400).json({ error: authError.message });

    await supabase.from('perfil_staff').insert([{
        email, 
        nombre: nombre || email.split('@')[0], 
        rol: null, 
        sede: null, 
        master_user_id: authData.user.id
    }]);

    res.status(201).json({ success: true, message: 'Usuario registrado. Espera aprobación.' });
  } catch (err) { res.status(500).json({ error: 'Error registro' }); }
});

app.post('/api/auth/google-sync', async (req, res) => {
    try {
        const { email, uuid } = req.body;
        let { data: profile } = await supabase.from('perfil_staff').select('*').eq('email', email).single();
        if (!profile) {
            const { data: newProfile } = await supabase.from('perfil_staff').insert([{
                email, 
                nombre: email.split('@')[0], 
                rol: null, 
                sede: null, 
                master_user_id: uuid
            }]).select().single();
            profile = newProfile;
        }
        res.json({ 
            success: true, 
            user: { 
                id: uuid, 
                email, 
                rol: profile.rol, 
                sede: profile.sede, 
                nombre: profile.nombre 
            } 
        });
    } catch (err) { res.status(500).json({ error: "Error sync Google" }); }
});

// ==========================================
// 4. GESTIÓN DE ALUMNOS (STUDENTS)
// ==========================================

app.get('/api/students', verifyUser, async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const { rol, sede } = req.staffProfile;
    const limit = 50; 
    const from = (page - 1) * limit; 
    const to = from + limit - 1;

    let query = supabase.from('student').select('*', { count: 'exact' });

    if (rol !== 'admin' && sede) {
        query = query.eq('codPuntoKennedy', sede);
    }
    if (search) {
      query = query.or(`full_name.ilike.%${search}%,"numero Identificacion".ilike.%${search}%,legdef.ilike.%${search}%`);
    }

    query = query.order('solicita secretaria', { ascending: false })
                 .order('created_at', { ascending: false });

    const { data, count, error } = await query.range(from, to);
    if (error) throw error;

    const mappedData = (data || []).map(s => ({
      id: s.id,
      full_name: s.full_name,
      dni: s['numero Identificacion'],
      legajo: s.legdef,
      contact_phone: s.telefono1 || s.telefono2,
      location: s['codPuntoKennedy'],
      career_name: s['nombrePrograma'],
      bot_active: s['bot active'], 
      solicita_secretaria: s['solicita secretaria'],
      status: s.status || 'Sólo preguntó',
      mood: s.mood || 'Neutro',
      last_interaction: s.created_at
    }));

    res.json({ data: mappedData, total: count || 0, userRole: rol, userSede: sede });
  } catch (err) { res.status(500).json({ error: 'Error buscando alumnos' }); }
});

app.get('/api/students/:id', verifyUser, async (req, res) => {
    const { id } = req.params;
    try {
        const { data: s } = await supabase.from('student').select('*').eq('id', id).single();
        if (!s) return res.status(404).json({ error: 'No encontrado' });

        const p1 = s.telefono1 ? s.telefono1.replace(/\D/g, '') : null;
        const p2 = s.telefono2 ? s.telefono2.replace(/\D/g, '') : null;
        let chatHistory = [];
        
        if (p1 || p2) {
            let orQuery = [];
            if (p1 && p1.length > 5) orQuery.push(`session_id.ilike.%${p1}%`);
            if (p2 && p2.length > 5) orQuery.push(`session_id.ilike.%${p2}%`);
            
            if (orQuery.length > 0) {
                const { data: chats } = await supabase
                    .from('n8n_chat_histories')
                    .select('*')
                    .or(orQuery.join(','))
                    .order('id', { ascending: true });
                
                chatHistory = (chats || []).map(c => {
                    let parsedContent = c.message.content;
                    let isBot = c.message.type === 'ai';
                    
                    if (isBot && typeof parsedContent === 'string' && parsedContent.includes('output')) {
                        try {
                            const innerJson = JSON.parse(parsedContent);
                            if (innerJson.output) {
                                parsedContent = [
                                    innerJson.output.mensaje_1, 
                                    innerJson.output.mensaje_2, 
                                    innerJson.output.mensaje_3
                                ].filter(Boolean).join('\n\n');
                            }
                        } catch (e) { }
                    }
                    return { id: c.id, role: c.message.type === 'human' ? 'user' : 'assistant', content: parsedContent };
                });
            }
        }
        
        let documents = [];
        const docPhone = p1 || p2;
        if (docPhone && docPhone.length > 5) {
             const { data: docs } = await supabase
                .from('student_documents')
                .select('*')
                .eq('student_phone', docPhone)
                .order('uploaded_at', { ascending: false });
             documents = docs || [];
        }

        res.json({ student: s, chatHistory, documents });
    } catch (err) { res.status(500).json({ error: 'Error cargando detalle' }); }
});

app.patch('/api/students/:id', verifyUser, async (req, res) => {
    const { id } = req.params;
    const { status, bot_active, solicita_secretaria, mood } = req.body;
    
    try {
        const updates = {};
        if (status !== undefined) updates.status = status;
        if (bot_active !== undefined) updates['bot active'] = bot_active;
        if (solicita_secretaria !== undefined) updates['solicita secretaria'] = solicita_secretaria;
        if (mood !== undefined) updates.mood = mood;

        const { error } = await supabase
            .from('student')
            .update(updates)
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error actualizando alumno' });
    }
});

// ==========================================
// 5. SISTEMA DE ARCHIVOS (GOOGLE DRIVE)
// ==========================================

app.post('/api/students/phone/:phone/documents', verifyUser, upload.single('file'), async (req, res) => {
  const rawPhone = req.params.phone;
  try {
    if (!drive) return res.status(503).json({ error: 'Drive no disponible' });
    const cleanPhone = rawPhone.replace(/\D/g, '');
    const { documentType } = req.body;
    const file = req.file;

    if (!file) return res.status(400).json({ error: 'Falta archivo' });

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

    if (error) throw error;
    res.json({ success: true, message: 'Subido a Drive', id: data.id });

  } catch (err) {
    res.status(500).json({ error: 'Error al subir archivo' });
  }
});

app.get('/api/documents/:id/download', verifyUser, async (req, res) => {
  const docId = req.params.id;
  try {
    if (!drive) return res.status(503).json({ error: 'Drive no disponible' });

    const { data: doc, error } = await supabase
      .from('student_documents')
      .select('*')
      .eq('id', docId)
      .single();

    if (error || !doc) return res.status(404).json({ error: 'Documento no encontrado' });

    const driveStream = await drive.files.get(
      { fileId: doc.drive_file_id, alt: 'media' },
      { responseType: 'stream' }
    );

    res.setHeader('Content-Disposition', `attachment; filename="${doc.file_name}"`);
    res.setHeader('Content-Type', doc.mime_type);
    
    driveStream.data.pipe(res);
  } catch (err) {
    res.status(500).json({ error: 'Error en descarga' });
  }
});

// ==========================================
// 6. MENSAJERÍA MANUAL
// ==========================================

app.post('/api/messages', verifyUser, async (req, res) => {
    try {
        const { studentId, messageText, phone } = req.body;
        
        const { data: student, error: stError } = await supabase
            .from('student')
            .select('codPuntoKennedy')
            .eq('id', studentId)
            .single();

        if (stError) throw new Error("Estudiante no encontrado");

        const payload = {
            message: messageText,
            agent: req.staffProfile.nombre || 'Secretaria'
        };

        const { error } = await supabase
            .from('Mensaje_de_secretaria')
            .insert([{
                "Telefono_EST": phone,
                "Mensaje de secretaria": payload,
                "sede": student.codPuntoKennedy 
            }]);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error enviando mensaje' });
    }
});

// ==========================================
// 7. GESTIÓN DE STAFF Y CARRERAS
// ==========================================

app.get('/api/careers', verifyUser, async (req, res) => {
    const { data } = await supabase.from('resumen_carreras').select('*').order('CARRERA');
    res.json(data || []);
});

app.get('/api/staff', verifyUser, async (req, res) => {
    const { rol } = req.staffProfile;
    let query = supabase.from('perfil_staff').select('*');
    
    if (rol === 'asesor') {
        query = query.is('rol', null); 
    } else if (rol !== 'admin') {
        return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { data } = await query.order('created_at', { ascending: false });
    res.json(data || []);
});

app.put('/api/staff/:id', verifyUser, async (req, res) => {
    const { id } = req.params;
    const { newRole, newSede } = req.body;
    const currentUser = req.staffProfile;

    try {
        if (currentUser.rol === 'admin') {
            await supabase.from('perfil_staff').update({ rol: newRole, sede: newSede }).eq('id', id);
        } else if (currentUser.rol === 'asesor') {
            if (newRole !== 'secretaria') return res.status(403).json({ error: 'Solo puedes asignar Secretarias' });
            await supabase.from('perfil_staff').update({ rol: 'secretaria', sede: currentUser.sede }).eq('id', id);
        } else {
            return res.status(403).json({ error: 'No tienes permisos' });
        }
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Error actualizando staff' }); }
});

// ==========================================
// 8. BOT ANALISTA (RAG / INTELIGENCIA)
// ==========================================

// Función Auxiliar: Leer Historial Reciente
async function nodeReadChat(studentId) {
    const { data: student } = await supabase.from('student').select('telefono1, telefono2').eq('id', studentId).single();
    if (!student) return "Sin historial.";

    const p1 = student.telefono1 ? student.telefono1.replace(/\D/g, '') : 'X';
    const p2 = student.telefono2 ? student.telefono2.replace(/\D/g, '') : 'X';

    const { data: chats } = await supabase
        .from('n8n_chat_histories')
        .select('message')
        .or(`session_id.ilike.%${p1}%,session_id.ilike.%${p2}%`)
        .order('id', { ascending: false }) 
        .limit(20);

    if (!chats || chats.length === 0) return "No hay historial de chat reciente.";

    return chats.map(c => {
        const msg = c.message;
        const role = msg.type === 'human' ? 'Alumno' : 'Bot';
        let content = msg.content;
        if (typeof content === 'string' && content.includes('output')) {
             try { content = JSON.parse(content).output.mensaje_1 || content; } catch(e){}
        }
        return `${role}: ${content}`;
    }).reverse().join('\n');
}

// Función Auxiliar: Leer Documentos de Drive
async function nodeReadDrive(studentId) {
    // 1. Obtener Teléfonos para buscar en tabla student_documents
    const { data: student } = await supabase.from('student').select('telefono1, telefono2').eq('id', studentId).single();
    const p1 = student.telefono1 ? student.telefono1.replace(/\D/g, '') : 'X';
    const p2 = student.telefono2 ? student.telefono2.replace(/\D/g, '') : 'X';

    const { data: docs } = await supabase
        .from('student_documents')
        .select('*')
        .or(`student_phone.eq.${p1},student_phone.eq.${p2}`);

    if (!docs || docs.length === 0) return "No hay documentos cargados.";

    let documentsContent = "";

    for (const doc of docs) {
        try {
            if(!drive) continue;
            console.log(`📄 Analizando archivo: ${doc.file_name}`);
            
            const response = await drive.files.get(
                { fileId: doc.drive_file_id, alt: 'media' },
                { responseType: 'arraybuffer' }
            );
            
            const buffer = Buffer.from(response.data);
            let text = "";

            if (doc.mime_type === 'application/pdf') {
                const pdfData = await pdf(buffer);
                text = pdfData.text;
            } else if (doc.mime_type.includes('text') || doc.mime_type.includes('json')) {
                text = buffer.toString('utf-8');
            } else {
                text = "[Archivo de imagen o formato no legible]";
            }
            documentsContent += `\n--- DOC: ${doc.document_type} ---\n${text.substring(0, 1500)}...\n`;
        } catch (err) {
            console.error(`Error leyendo ${doc.file_name}:`, err.message);
        }
    }
    return documentsContent;
}

// Endpoint del Bot
app.post('/api/bot/analyze', verifyUser, async (req, res) => {
    const { studentId, question } = req.body;
    console.log(`🤖 [BOT] Analizando alumno ${studentId}... Pregunta: ${question}`);

    try {
        const { data: student } = await supabase.from('student').select('*').eq('id', studentId).single();
        
        // Ejecución Paralela de Nodos
        const [chatContext, docsContext] = await Promise.all([
            nodeReadChat(studentId),
            nodeReadDrive(studentId)
        ]);

        const prompt = `
        ACTÚA COMO: Un asistente experto de la secretaría académica de la Universidad Kennedy.
        TU OBJETIVO: Responder la pregunta de la secretaria basándote E STRICTAMENTE en la información proporcionada.

        --- PERFIL DEL ALUMNO ---
        Nombre: ${student.full_name}
        DNI: ${student['numero Identificacion']}
        Carrera: ${student['nombrePrograma']}
        Estado: ${student.status}
        Sede: ${student['codPuntoKennedy']}

        --- HISTORIAL DE CHAT RECIENTE ---
        ${chatContext}

        --- CONTENIDO DE DOCUMENTOS EN DRIVE ---
        ${docsContext}

        --- PREGUNTA DE LA SECRETARIA ---
        ${question}

        RESPUESTA (Sé conciso, profesional y cita la fuente si viene de un documento o del chat):
        `;

        const completion = await openai.chat.completions.create({
            model: "meta-llama/llama-3.3-70b-instruct:free", 
            messages: [{ role: "user", content: prompt }],
        });

        const answer = completion.choices[0].message.content;
        res.json({ answer });

    } catch (err) {
        console.error("Bot Error:", err);
        res.status(500).json({ error: 'Error al procesar con la IA' });
    }
});


// --- ARRANQUE ---
app.listen(port, () => console.log(`🚀 KENNEDY BACKEND FULL v7.0 (AI + Drive) en puerto ${port}`));