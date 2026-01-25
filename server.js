require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const multer = require('multer');
const { google } = require('googleapis');
const stream = require('stream');

const app = express();
const port = process.env.PORT || 4001;

// --- CONFIGURACIÓN CORS ---
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

const upload = multer({ storage: multer.memoryStorage() });

// --- MIDDLEWARES DE SEGURIDAD ---

// 1. Verifica Token y Carga Perfil del Staff
const verifyUser = async (req, res, next) => {
  const token = req.headers['authorization']?.split(' ')[1]; // Bearer TOKEN
  
  // MODO DESARROLLO / BYPASS (Si no hay token o falla, usamos un admin por defecto para pruebas)
  // EN PRODUCCIÓN: Debes validar el token real con supabase.auth.getUser(token)
  if (!token) {
      console.log("⚠️ [AUTH] Sin token, usando modo Bypass Admin");
      req.user = { id: 'admin-bypass', email: 'admin@test.com' };
      req.staffProfile = { rol: 'admin', sede: 'Catamarca' }; // Asume admin por defecto en dev
      return next();
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) throw new Error("Token inválido");

    // Buscar perfil en tabla staff
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

// 2. Solo Admins
const requireAdmin = (req, res, next) => {
    if (req.staffProfile?.rol === 'admin') return next();
    return res.status(403).json({ error: 'Requiere acceso Admin' });
};

// ==========================================
//           RUTAS DE AUTENTICACIÓN
// ==========================================

// Login Email/Pass
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
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

// Registro Email/Pass
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, nombre, sede } = req.body;
    const { data: authData, error: authError } = await supabase.auth.signUp({ email, password });
    
    if (authError) return res.status(400).json({ error: authError.message });

    // Crear perfil con ROL NULL por defecto (esperando aprobación)
    await supabase.from('perfil_staff').insert([{
        email, 
        nombre: nombre || email.split('@')[0],
        rol: null, 
        sede: null, // Sede null hasta que el admin la asigne
        master_user_id: authData.user.id
    }]);

    res.status(201).json({ success: true, message: 'Usuario registrado. Espera aprobación.' });
  } catch (err) {
    res.status(500).json({ error: 'Error registro' });
  }
});

// Sincronización Google
app.post('/api/auth/google-sync', async (req, res) => {
    try {
        const { email, uuid } = req.body;
        let { data: profile } = await supabase.from('perfil_staff').select('*').eq('email', email).single();

        if (!profile) {
            const { data: newProfile } = await supabase.from('perfil_staff').insert([{
                email,
                nombre: email.split('@')[0],
                rol: null, // Sin rol inicial
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
    } catch (err) {
        res.status(500).json({ error: "Error sync Google" });
    }
});

// ==========================================
//           RUTAS DE ALUMNOS (STUDENTS)
// ==========================================

app.get('/api/students', verifyUser, async (req, res) => {
  try {
    const { search, page = 1 } = req.query;
    const { rol, sede } = req.staffProfile;
    const limit = 50; 
    const from = (page - 1) * limit; 
    const to = from + limit - 1;

    let query = supabase.from('student').select('*', { count: 'exact' });

    // 1. FILTRO POR SEDE (Si no es admin)
    if (rol !== 'admin' && sede) {
        query = query.eq('codPuntoKennedy', sede);
    }

    // 2. BUSQUEDA TEXTUAL
    if (search) {
      query = query.or(`full_name.ilike.%${search}%,"numero Identificacion".ilike.%${search}%,legdef.ilike.%${search}%`);
    }

    // 3. ORDENAMIENTO INTELIGENTE: Primero los que piden secretaria
    query = query.order('solicita secretaria', { ascending: false }) // True primero
                 .order('created_at', { ascending: false });

    const { data, count, error } = await query.range(from, to);
    if (error) throw error;

    // Mapeo para el Frontend
    const mappedData = (data || []).map(s => ({
      id: s.id,
      full_name: s.full_name,
      dni: s['numero Identificacion'],
      legajo: s.legdef,
      contact_phone: s.telefono1 || s.telefono2,
      location: s['codPuntoKennedy'],
      career_name: s['nombrePrograma'],
      bot_active: s['bot active'], // Mapeo exacto de columnas
      solicita_secretaria: s['solicita secretaria'],
      mood: s.mood || 'Neutro',
      last_interaction: s.created_at
    }));

    res.json({ 
        data: mappedData, 
        total: count || 0, 
        userRole: rol,
        userSede: sede
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error buscando alumnos' });
  }
});

// Detalle Alumno + Chats + Docs
app.get('/api/students/:id', verifyUser, async (req, res) => {
    const { id } = req.params;
    try {
        // A. Datos del Alumno
        const { data: s } = await supabase.from('student').select('*').eq('id', id).single();
        if (!s) return res.status(404).json({ error: 'No encontrado' });

        // B. Historial de Chat (Búsqueda por teléfono)
        // Limpiamos los teléfonos para buscar coincidencias parciales
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
                    .order('id', { ascending: true }); // Orden cronológico
                
                // Procesar Mensajes (Parsing JSON)
                chatHistory = (chats || []).map(c => {
                    let parsedContent = c.message.content;
                    let isBot = c.message.type === 'ai';
                    
                    // Si es Bot y tiene JSON anidado, extraer mensaje_1, mensaje_2...
                    if (isBot && typeof parsedContent === 'string' && parsedContent.includes('output')) {
                        try {
                            const innerJson = JSON.parse(parsedContent);
                            if (innerJson.output) {
                                // Juntamos mensaje 1, 2 y 3 en un solo texto limpio
                                parsedContent = [
                                    innerJson.output.mensaje_1,
                                    innerJson.output.mensaje_2,
                                    innerJson.output.mensaje_3
                                ].filter(Boolean).join('\n\n');
                            }
                        } catch (e) { /* Fallback si falla parseo */ }
                    }

                    return {
                        id: c.id,
                        role: c.message.type === 'human' ? 'user' : 'assistant',
                        content: parsedContent,
                        raw: c.message // Guardamos el raw por si acaso
                    };
                });
            }
        }

        res.json({ 
            student: s,
            chatHistory 
        });

    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error cargando detalle' });
    }
});

// Acción: "Atendido" (Toggle Solicita Secretaria)
app.put('/api/students/:id/toggle-help', verifyUser, async (req, res) => {
    try {
        // Lógica: Si presiona el botón, es porque ya atendió al alumno.
        // Pone 'solicita secretaria' en FALSE y reactiva el BOT.
        const { error } = await supabase
            .from('student')
            .update({ 
                'solicita secretaria': false,
                'bot active': true 
            })
            .eq('id', req.params.id);
            
        if (error) throw error;
        res.json({ success: true, message: 'Alumno atendido. Bot reactivado.' });
    } catch (err) {
        res.status(500).json({ error: 'Error actualizando estado' });
    }
});

// Acción: Enviar Mensaje (Insertar en tabla para n8n)
app.post('/api/messages', verifyUser, async (req, res) => {
    try {
        const { studentId, messageText, phone } = req.body;
        
        // Estructura JSON requerida por n8n
        const payload = {
            message: messageText,
            agent: req.staffProfile.nombre || 'Secretaria'
        };

        const { error } = await supabase
            .from('Mensaje_de_secretaria')
            .insert([{
                "Telefono_EST": phone,
                "Mensaje de secretaria": payload
            }]);

        if (error) throw error;
        res.json({ success: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Error enviando mensaje' });
    }
});

// ==========================================
//           RUTAS DE CARRERAS
// ==========================================
app.get('/api/careers', verifyUser, async (req, res) => {
    const { data } = await supabase.from('resumen_carreras').select('*').order('CARRERA');
    res.json(data || []);
});

// ==========================================
//           GESTIÓN DE EQUIPO (STAFF)
// ==========================================

// Listar pendientes o todo el equipo (Solo Admin/Asesor)
app.get('/api/staff', verifyUser, async (req, res) => {
    const { rol, sede } = req.staffProfile;
    
    let query = supabase.from('perfil_staff').select('*');

    // Si es Asesor, solo ve gente de su sede o gente sin sede (para aprobar)
    if (rol === 'asesor') {
        // Lógica: Asesor ve los de su sede y los NULL (pendientes)
        // Supabase no tiene OR simple entre columnas y nulos facil, simplificamos:
        // El asesor verá todos y filtraremos en backend o solo los NULL.
        // Para simplificar: Asesor solo ve pendientes (rol is null).
        query = query.is('rol', null); 
    } else if (rol !== 'admin') {
        return res.status(403).json({ error: 'Acceso denegado' });
    }

    const { data } = await query.order('created_at', { ascending: false });
    res.json(data || []);
});

// Aprobar/Editar Staff
app.put('/api/staff/:id', verifyUser, async (req, res) => {
    const { id } = req.params;
    const { newRole, newSede } = req.body; // Lo que se quiere asignar
    const currentUser = req.staffProfile;

    try {
        // Validaciones de permisos
        if (currentUser.rol === 'admin') {
            // Admin puede hacer todo
            await supabase.from('perfil_staff').update({ rol: newRole, sede: newSede }).eq('id', id);
        } else if (currentUser.rol === 'asesor') {
            // Asesor solo puede asignar rol 'secretaria' y SU propia sede
            if (newRole !== 'secretaria') return res.status(403).json({ error: 'Solo puedes asignar Secretarias' });
            await supabase.from('perfil_staff').update({ rol: 'secretaria', sede: currentUser.sede }).eq('id', id);
        } else {
            return res.status(403).json({ error: 'No tienes permisos' });
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Error actualizando staff' });
    }
});


// Arrancar
app.listen(port, () => console.log(`🚀 KENNEDY BACKEND v4.0 corriendo en puerto ${port}`));