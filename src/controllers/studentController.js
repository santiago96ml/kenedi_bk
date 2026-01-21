const studentService = require('../services/studentService');

const getStudents = async (req, res) => {
  try {
    const result = await studentService.getAllStudents(req.query);
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error al obtener alumnos' });
  }
};

const createStudent = async (req, res) => {
  try {
    const newStudent = await studentService.createStudent(req.body);
    res.status(201).json({ message: 'Alumno creado con éxito', data: newStudent });
  } catch (error) {
    console.error(error);
    // Manejo de errores específico
    if (error.message.includes('DUPLICATE_ENTRY')) {
      return res.status(400).json({ error: error.message });
    }
    res.status(500).json({ error: 'Error interno al crear alumno' });
  }
};

const updateNotes = async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body;
    await studentService.updateNotes(id, notes);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = { getStudents, createStudent, updateNotes };