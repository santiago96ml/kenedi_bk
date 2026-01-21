const driveService = require('../services/driveService');

const uploadDocument = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No se envió ningún archivo' });
    
    const { id } = req.params; // Student ID
    const { documentType } = req.body;

    const result = await driveService.uploadFile(req.file, id, documentType || 'documento');
    
    res.status(201).json({ success: true, fileId: result.drive_file_id });
  } catch (error) {
    console.error("Upload Error:", error);
    res.status(500).json({ error: error.message });
  }
};

const downloadDocument = async (req, res) => {
  try {
    const { id } = req.params; // Document ID (ojo: ID de la tabla student_documents)
    
    const { stream, fileName, mimeType } = await driveService.getFileStream(id);

    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('Content-Type', mimeType);

    stream.pipe(res);
  } catch (error) {
    console.error("Download Error:", error);
    res.status(404).json({ error: error.message });
  }
};

module.exports = { uploadDocument, downloadDocument };