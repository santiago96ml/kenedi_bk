require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');
const OpenAI = require('openai');
const pdf = require('pdf-parse'); 

const app = express();
const port = process.env.PORT || 4001;

// ==========================================
// 1. CONFIGURACIÓN INICIAL
// ==========================================

const allowedOrigins = [
  'http://localhost:5173',
  'https://vintex.net.br',
  'https://www.vintex.net.br',
  'https://puntokennedy.tech'
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

// --- SUPABASE ---
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// --- GOOGLE DRIVE ---
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

// --- OPENROUTER (IA) ---
if (!process.env.OPENROUTER_API_KEY) console.warn("⚠️ FALTA OPENROUTER_API_KEY");

const openai = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: process.env.OPENROUTER_API_KEY || "dummy", 
});

const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// ==========================================
// 2. MIDDLEWARES DE SEGURIDAD
// ==========================================

const verifyUser = async (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1]; 
  
  if (!token) {
      console.log("⚠️ [AUTH] Bypass Admin (Modo Desarrollo/Test)");
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

    if (!profile || !profile.rol) {
        return res.status(403).json({ error: 'Tu cuenta está inactiva o sin rol asignado.' });
    }

    req.user = user;
    req.staffProfile = profile;
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

    res.status(201).json({ success: true, message: 'Usuario registrado.' });
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
// 4. GESTIÓN ALUMNOS
// ==========================================

// CREAR ALUMNO (POST)
app.post('/api/students', verifyUser, async (req, res) => {
    const { rol } = req.staffProfile;
    if (rol !== 'admin' && rol !== 'asesor') return res.status(403).json({ error: 'No tienes permisos para crear alumnos' });

    try {
        const newStudent = req.body; 
        delete newStudent.id; 
        
        const { data, error } = await supabase.from('student').insert([newStudent]).select();
        if (error) throw error;
        res.json({ success: true, data });
    } catch (err) {
        console.error("Create Student Error:", err);
        res.status(500).json({ error: 'Error creando alumno' });
    }
});

// LISTAR TODOS
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

// DETALLE DE UN ALUMNO (CORREGIDO PARSEO)
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
                    let rawMsg = c.message;
                    // Intenta parsear si es string
                    if (typeof rawMsg === 'string') {
                        try { rawMsg = JSON.parse(rawMsg); } catch (e) {
                            return { id: c.id, role: 'system', content: c.message };
                        }
                    }

                    const role = rawMsg.type === 'human' ? 'user' : 'assistant';
                    let content = rawMsg.content;

                    // Limpieza profunda de output de agentes
                    try {
                        if (typeof content === 'string' && (content.includes('output') || content.trim().startsWith('{'))) {
                            const innerJson = JSON.parse(content);
                            if (innerJson.output && innerJson.output.message) {
                                content = innerJson.output.message;
                            } else if (innerJson.output) {
                                content = [
                                    innerJson.output.message,
                                    innerJson.output.mensaje_1, 
                                    innerJson.output.mensaje_2, 
                                    innerJson.output.mensaje_3
                                ].filter(Boolean).join('\n\n');
                            }
                        }
                    } catch (e) { }

                    return { id: c.id, role, content };
                });
            }
        }
        
        const { data: docs } = await supabase
            .from('student_documents')
            .select('*')
            .eq('student_id', id)
            .order('uploaded_at', { ascending: false });

        res.json({ student: s, chatHistory, documents: docs || [] });
    } catch (err) { 
        console.error(err);
        res.status(500).json({ error: 'Error cargando detalle' }); 
    }
});

// ACTUALIZAR ALUMNO (PATCH)
app.patch('/api/students/:id', verifyUser, async (req, res) => {
    const { id } = req.params;
    const body = req.body;

    try {
        const { error } = await supabase
            .from('student')
            .update(body) 
            .eq('id', id);

        if (error) throw error;
        res.json({ success: true });

    } catch (err) {
        console.error("Update Error:", err);
        res.status(500).json({ error: 'Error actualizando alumno' });
    }
});

// ==========================================
// 5. CARRERAS (NUEVOS ENDPOINTS)
// ==========================================

app.get('/api/careers', verifyUser, async (req, res) => {
    const { data } = await supabase.from('resumen_carreras').select('*').order('CARRERA');
    res.json(data || []);
});

// CREAR CARRERA (SOLO ADMIN)
app.post('/api/careers', verifyUser, async (req, res) => {
    const { rol } = req.staffProfile;
    if (rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado: Solo administradores pueden crear carreras.' });

    try {
        const newCareer = req.body;
        delete newCareer.id; 
        delete newCareer.created_at;

        const { data, error } = await supabase.from('resumen_carreras').insert([newCareer]).select();
        
        if (error) throw error;
        res.json({ success: true, data });
    } catch (err) {
        console.error("Create Career Error:", err);
        res.status(500).json({ error: 'Error creando la carrera' });
    }
});

// EDITAR CARRERA
app.put('/api/careers/:id', verifyUser, async (req, res) => {
    const { rol } = req.staffProfile;
    if (rol === 'secretaria') return res.status(403).json({ error: 'Las secretarias no pueden editar carreras.' });

    try {
        const { id } = req.params;
        const updates = req.body;
        delete updates.id; 

        const { error } = await supabase.from('resumen_carreras').update(updates).eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error actualizando carrera' });
    }
});

// ELIMINAR CARRERA (SOLO ADMIN)
app.delete('/api/careers/:id', verifyUser, async (req, res) => {
    const { rol } = req.staffProfile;
    if (rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado: Solo administradores pueden eliminar carreras.' });

    try {
        const { id } = req.params;
        const { error } = await supabase.from('resumen_carreras').delete().eq('id', id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error("Delete Career Error:", err);
        res.status(500).json({ error: 'Error eliminando la carrera' });
    }
});

// ==========================================
// 6. STAFF (ADMINISTRACIÓN)
// ==========================================

app.get('/api/staff', verifyUser, async (req, res) => {
    const { rol } = req.staffProfile;
    let query = supabase.from('perfil_staff').select('*');
    if (rol === 'asesor') query = query.is('rol', null); 
    else if (rol !== 'admin') return res.status(403).json({ error: 'Acceso denegado' });
    const { data } = await query.order('created_at', { ascending: false });
    res.json(data || []);
});

app.put('/api/staff/:id', verifyUser, async (req, res) => {
    const { newRole, newSede } = req.body;
    const currentUser = req.staffProfile;
    try {
        if (currentUser.rol === 'admin') {
            await supabase.from('perfil_staff').update({ rol: newRole, sede: newSede }).eq('id', req.params.id);
        } else if (currentUser.rol === 'asesor') {
            if (newRole !== 'secretaria') return res.status(403).json({ error: 'Solo puedes asignar Secretarias' });
            await supabase.from('perfil_staff').update({ rol: 'secretaria', sede: currentUser.sede }).eq('id', req.params.id);
        } else return res.status(403).json({ error: 'No tienes permisos' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Error actualizando staff' }); }
});

app.delete('/api/staff/:id', verifyUser, async (req, res) => {
    const { rol } = req.staffProfile;
    if (rol !== 'admin') return res.status(403).json({ error: 'Solo Admin elimina cuentas' });

    try {
        const { error } = await supabase.from('perfil_staff').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Error eliminando staff' }); }
});

// ==========================================
// 7. SISTEMA ADMIN (CONTROL GLOBAL DEL BOT)
// ==========================================

async function getBotStatus() {
    try {
        const { data, error } = await supabase
            .from('bot_settings')
            .select('is_active')
            .eq('id', 1)
            .single();
        if (error || !data) return true;
        return data.is_active;
    } catch (e) { return true; }
}

app.post('/api/admin/bot-status', verifyUser, async (req, res) => {
    const { rol } = req.staffProfile;
    if (rol !== 'admin') return res.status(403).json({ error: 'Solo admin controla el bot.' });

    const { is_active } = req.body; 
    if (typeof is_active !== 'boolean') return res.status(400).json({ error: 'Requiere is_active boolean.' });

    await supabase.from('bot_settings').upsert({ id: 1, is_active: is_active, updated_at: new Date() });
    return res.json({ success: true, is_active });
});

app.get('/api/admin/bot-status', verifyUser, async (req, res) => {
    const isActive = await getBotStatus();
    res.json({ active: isActive, is_active: isActive });
});

// ==========================================
// 8. BOT ANALISTA (RAG CORREGIDO)
// ==========================================

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

    if (!chats || chats.length === 0) return "No hay historial reciente.";

    return chats.map(c => {
        let rawMsg = c.message;
        if (typeof rawMsg === 'string') {
            try { rawMsg = JSON.parse(rawMsg); } catch(e){}
        }

        const role = rawMsg.type === 'human' ? 'Alumno' : 'Bot';
        let content = rawMsg.content;
        
        if (typeof content === 'string' && content.includes('output')) {
             try { 
                 const inner = JSON.parse(content);
                 content = inner.output.message || inner.output.mensaje_1 || content; 
             } catch(e){}
        }
        if (typeof content === 'string' && content.includes('Esta es la url: https://drive.google.com')) {
            content = `[EL USUARIO ENVIÓ UNA IMAGEN/ARCHIVO]`;
        }
        return `${role}: ${content}`;
    }).reverse().join('\n');
}

async function nodeReadDrive(studentId) {
    const { data: docs } = await supabase.from('student_documents').select('*').eq('student_id', studentId);
    if (!docs || docs.length === 0) return "No hay documentos.";
    
    let documentsContent = "";
    for (const doc of docs) {
        try {
            if(!drive) continue;
            const response = await drive.files.get({ fileId: doc.drive_file_id, alt: 'media' }, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data);
            let text = "";
            if (doc.mime_type === 'application/pdf') {
                const pdfData = await pdf(buffer);
                text = `(PDF): ${pdfData.text.substring(0, 1000)}...`;
            } else { text = `[Archivo: ${doc.file_name}]`; }
            documentsContent += `\n--- DOC: ${doc.document_type} ---\n${text}\n`;
        } catch (err) { }
    }
    return documentsContent;
}

app.post('/api/bot/analyze', verifyUser, async (req, res) => {
    const systemActive = await getBotStatus();
    if (systemActive === false) return res.json({ answer: "⛔ IA desactivada por administrador." });

    const { studentId, question } = req.body;
    
    if (!process.env.OPENROUTER_API_KEY) return res.json({ answer: "⚠️ Error: Falta API Key." });

    try {
        const { data: student } = await supabase.from('student').select('*').eq('id', studentId).single();
        const [chatContext, docsContext] = await Promise.all([ nodeReadChat(studentId), nodeReadDrive(studentId) ]);

        const prompt = `
        ERES: Asistente administrativo Universidad Kennedy.
        ALUMNO: ${student.full_name} (${student.status}, ${student.codPuntoKennedy})
        HISTORIAL: ${chatContext}
        DOCS: ${docsContext}
        PREGUNTA: "${question}"
        RESPONDE BREVE Y PROFESIONAL.
        `;

        const completion = await openai.chat.completions.create({
            model: "google/gemini-2.0-flash-exp:free", 
            messages: [{ role: "user", content: prompt }],
        });

        if (!completion.choices || completion.choices.length === 0) throw new Error("Sin respuesta IA");
        res.json({ answer: completion.choices[0].message.content });

    } catch (err) {
        console.error("BOT ERROR:", err);
        res.status(500).json({ error: 'Error análisis IA' });
    }
});

// ==========================================
// 9. ARCHIVOS Y MENSAJES
// ==========================================

app.post('/api/students/phone/:phone/documents', verifyUser, upload.single('file'), async (req, res) => {
  const rawPhone = req.params.phone;
  try {
    if (!drive) return res.status(503).json({ error: 'Drive off' });
    const cleanPhone = rawPhone.replace(/\D/g, '');
    const { documentType } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'Falta archivo' });

    const { data: students } = await supabase.from('student').select('id').or(`telefono1.ilike.%${cleanPhone}%,telefono2.ilike.%${cleanPhone}%`).limit(1);
    const student = students && students.length > 0 ? students[0] : null;

    const fileMetadata = { name: `${cleanPhone}_${documentType}_${file.originalname}`, parents: [process.env.GOOGLE_DRIVE_FOLDER_ID] };
    const media = { mimeType: file.mimetype, body: stream.Readable.from(file.buffer) };
    const driveResponse = await drive.files.create({ resource: fileMetadata, media: media, fields: 'id' });

    const { data } = await supabase.from('student_documents').insert([{
        student_id: student ? student.id : null, student_phone: cleanPhone, document_type: documentType,
        drive_file_id: driveResponse.data.id, file_name: file.originalname, mime_type: file.mimetype, uploaded_at: new Date()
    }]).select().single();
    res.json({ success: true, id: data.id });
  } catch (err) { res.status(500).json({ error: 'Error upload' }); }
});

app.get('/api/documents/:id/download', verifyUser, async (req, res) => {
    try {
        if (!drive) return res.status(503).json({ error: 'Drive off' });
        const { data: doc } = await supabase.from('student_documents').select('*').eq('id', req.params.id).single();
        if (!doc) return res.status(404).json({ error: '404' });
        const driveStream = await drive.files.get({ fileId: doc.drive_file_id, alt: 'media' }, { responseType: 'stream' });
        res.setHeader('Content-Disposition', `attachment; filename="${doc.file_name}"`);
        res.setHeader('Content-Type', doc.mime_type);
        driveStream.data.pipe(res);
    } catch (err) { res.status(500).json({ error: 'Error download' }); }
});

app.post('/api/messages', verifyUser, async (req, res) => {
    try {
        const { studentId, messageText, phone } = req.body;
        const { data: student } = await supabase.from('student').select('codPuntoKennedy').eq('id', studentId).single();
        await supabase.from('Mensaje_de_secretaria').insert([{ "Telefono_EST": phone, "Mensaje de secretaria": { message: messageText, agent: req.staffProfile.nombre }, "sede": student?.codPuntoKennedy }]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: 'Error message' }); }
});

app.listen(port, () => console.log(`🚀 KENNEDY BACKEND v10.0 (Full Management) puerto ${port}`));