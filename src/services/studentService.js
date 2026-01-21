const supabase = require('../config/supabase');

class StudentService {
  
  // Obtener alumnos con paginación y filtros
  async getAllStudents({ page = 1, search, career_id, status }) {
    const limit = 20;
    const from = (page - 1) * limit;
    const to = from + limit - 1;

    // Construimos la query base
    // NOTA: En tu docx, la relación es career_id -> careers(id)
    let query = supabase
      .from('students')
      .select(`
        *,
        careers ( name, fees, modality ) 
      `, { count: 'exact' });

    // Filtros dinámicos
    if (search) {
      // Buscamos por nombre, DNI o Legajo (según tu esquema)
      query = query.or(`full_name.ilike.%${search}%,dni.ilike.%${search}%,legajo.ilike.%${search}%`);
    }
    if (career_id) query = query.eq('career_id', career_id);
    if (status && status !== 'Todos') query = query.eq('status', status);

    // Orden y Paginación
    const { data, error, count } = await query
      .order('last_interaction_at', { ascending: false })
      .range(from, to);

    if (error) throw new Error(error.message);
    
    return { data, total: count, page: parseInt(page) };
  }

  // Crear alumno (Validando duplicados)
  async createStudent(studentData) {
    // 1. Verificamos si ya existe DNI o Legajo
    const { data: existing } = await supabase
      .from('students')
      .select('id')
      .or(`dni.eq.${studentData.dni},legajo.eq.${studentData.legajo}`)
      .maybeSingle();

    if (existing) {
      throw new Error('DUPLICATE_ENTRY: El DNI o Legajo ya existe en el sistema.');
    }

    // 2. Insertamos
    // Mapeamos los campos exactos de tu tabla "create table public.docx"
    const newStudent = {
      full_name: studentData.full_name,
      dni: studentData.dni,
      legajo: studentData.legajo || null,
      career_id: studentData.career_id,
      contact_phone: studentData.contact_phone,
      contact_email: studentData.email || null, // Agregado según docx
      location: studentData.location || 'Catamarca',
      status: 'Sólo preguntó', // Default según constraint
      general_notes: studentData.notes,
      last_interaction_at: new Date(),
      bot_students: true, // Default activo para el bot
      secretaria: false   // Default no derivado a secretaria
    };

    const { data, error } = await supabase
      .from('students')
      .insert([newStudent])
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }

  // Actualizar Notas (Patch rápido)
  async updateNotes(id, notes) {
    const { data, error } = await supabase
      .from('students')
      .update({ 
        general_notes: notes, 
        last_interaction_at: new Date() // Actualizamos la última interacción
      })
      .eq('id', id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    return data;
  }
}

module.exports = new StudentService();