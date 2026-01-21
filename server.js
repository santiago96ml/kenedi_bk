require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');

const app = express();
const port = process.env.PORT || 4001;

// --- 1. SEGURIDAD CORTAFUEGOS (CORS) ---
app.use(cors({
  origin: '*', // 🔓 ABRIMOS A TODO EL MUNDO (Modo Inseguro)
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));

// --- 2. CONEXIÓN SUPABASE (Service Role) ---
// Usamos la clave de servicio para tener poder total sobre la BD
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// --- 3. CONEXIÓN GOOGLE DRIVE ---
let drive;
try {
  const auth = new google.auth.GoogleAuth({
    keyFile: 'service-account.json',
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  drive = google.drive({ version: 'v3', auth });
} catch (error) {
  console.log('⚠️ Drive no configurado (Continuando sin él)');
}

const upload = multer({ storage: multer.memoryStorage() });

// --- 4. MIDDLEWARE DE "FALSA AUTENTICACIÓN" ---
// En lugar de verificar el JWT, este código INVENTA un usuario Admin
const bypassAuth = (req, res, next) => {
  // Simulamos que quien llama es siempre el Admin
  req.user = { email: 'admin@sistema.com' };
  req.staffProfile = { 
      rol: 'admin', 
      sede: 'Catamarca' // Sede por defecto
  };
  console.log(`🔓 Acceso permitido a: ${req.path}`);
  next();
};

// ==========================================
//              RUTAS DE LA API
// ==========================================

// --- GESTIÓN DE EQUIPO ---
app.get('/api/admin/staff', bypassAuth, async (req, res) => {
  const { data, error } = await supabase.from('perfil_staff').select('*');
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.patch('/api/admin/staff/:id', bypassAuth, async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('perfil_staff')
    .update(req.body)
    .eq('id', id)
    .select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

// --- CONFIGURACIÓN BOT ---
app.get('/api/bot', bypassAuth, async (req, res) => {
  const { data, error } = await supabase.from('bot_settings').select('*').eq('id', 1).single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.put('/api/bot', bypassAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('bot_settings')
    .update({ ...req.body, updated_at: new Date() })
    .eq('id', 1).select();
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true, data });
});

// --- ALUMNOS ---
app.get('/api/students', bypassAuth, async (req, res) => {
  try {
    const { search, career_id, status, page = 1 } = req.query;
    const from = (page - 1) * 20;
    const to = from + 19;

    let query = supabase.from('students').select('*, careers(name, fees)', { count: 'exact' });

    // Como estamos en modo "Sin JWT", NO filtramos por sede. Vemos todo.
    if (search) query = query.or(`full_name.ilike.%${search}%,dni.ilike.%${search}%`);
    if (career_id) query = query.eq('career_id', career_id);
    if (status && status !== 'Todos') query = query.eq('status', status);

    const { data, count, error } = await query.range(from, to).order('last_interaction_at', { ascending: false });
    
    if (error) throw error;
    
    // Devolvemos rol admin forzado para que el frontend muestre todos los botones
    res.json({ data, total: count, page: parseInt(page), userRole: 'admin' });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/students', bypassAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from('students').insert([{
      ...req.body,
      location: req.body.location || 'Catamarca', // Forzamos una sede si no viene
      last_interaction_at: new Date()
    }]).select().single();
    
    if (error) throw error;
    res.json({ message: 'Creado', id: data.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/students/:id', bypassAuth, async (req, res) => {
    const { data: student } = await supabase.from('students').select('*, careers(*)').eq('id', req.params.id).single();
    const { data: docs } = await supabase.from('student_documents').select('*').eq('student_id', req.params.id);
    if (!student) return res.status(404).json({error: 'No encontrado'});
    res.json({ student, documents: docs || [] });
});

app.patch('/api/students/:id/update-profile', bypassAuth, async (req, res) => {
    const { error } = await supabase.from('students').update(req.body).eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

app.patch('/api/students/:id/notes', bypassAuth, async (req, res) => {
    const { error } = await supabase.from('students')
        .update({ general_notes: req.body.notes, last_interaction_at: new Date() })
        .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

app.patch('/api/students/:id/resolve', bypassAuth, async (req, res) => {
    const { error } = await supabase.from('students')
        .update({ bot_students: true, secretaria: false, last_interaction_at: new Date() })
        .eq('id', req.params.id);
    if (error) return res.status(500).json({ error: error.message });
    res.json({ success: true });
});

// --- CARRERAS Y OTROS ---
app.get('/api/careers', async (req, res) => {
    const { data } = await supabase.from('careers').select('*').eq('active', true).order('name');
    res.json(data || []);
});

app.get('/api/chat-history/:phone', async (req, res) => {
    const phone = req.params.phone.replace(/\D/g, '');
    const { data } = await supabase.from('n8n_chat_histories').select('message').ilike('session_id', `%${phone}%`).limit(50);
    res.json(data || []);
});

// --- ARRANQUE ---
app.listen(port, () => {
  console.log(`🚀 BACKEND "MODO LIBRE" (SIN JWT) CORRIENDO EN PUERTO ${port}`);
  console.log(`⚠️  ADVERTENCIA: La seguridad está desactivada.`);
});