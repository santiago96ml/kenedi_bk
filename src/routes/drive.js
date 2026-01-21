const express = require('express');
const router = express.Router();
const multer = require('multer');
const verifyToken = require('../middlewares/auth');
const driveController = require('../controllers/driveController');

const upload = multer({ storage: multer.memoryStorage() });

router.use(verifyToken);

// POST: /api/drive/students/:id/upload
router.post('/students/:id/upload', upload.single('file'), driveController.uploadDocument);

// GET: /api/drive/download/:id (ID del documento)
router.get('/download/:id', driveController.downloadDocument);

module.exports = router;