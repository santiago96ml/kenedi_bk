const express = require('express');
const router = express.Router();
const verifyToken = require('../middlewares/auth');
const studentController = require('../controllers/studentController');

// Todas las rutas de alumnos requieren autenticación
router.use(verifyToken);

router.get('/', studentController.getStudents);
router.post('/', studentController.createStudent);
router.patch('/:id/notes', studentController.updateNotes);
// Aquí agregarías router.get('/:id', ...), router.delete('/:id', ...), etc.

module.exports = router;