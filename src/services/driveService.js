const getDriveClient = require('../config/drive');
const stream = require('stream');
const supabase = require('../config/supabase');

class DriveService {
  constructor() {
    this.drive = getDriveClient();
    this.folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  }

  // Subir archivo
  async uploadFile(fileObject, studentId, documentType) {
    if (!this.drive) throw new Error('Servicio de Drive no disponible');

    const fileMetadata = {
      name: `${documentType}_${Date.now()}_${fileObject.originalname}`,
      parents: [this.folderId],
    };

    const media = {
      mimeType: fileObject.mimetype,
      body: stream.Readable.from(fileObject.buffer),
    };

    // 1. Subir a Google Drive
    const driveResponse = await this.drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: 'id',
    });

    const driveFileId = driveResponse.data.id;

    // 2. Guardar referencia en Supabase (student_documents)
    const { data, error } = await supabase
      .from('student_documents')
      .insert([{
        student_id: studentId,
        document_type: documentType,
        drive_file_id: driveFileId,
        file_name: fileObject.originalname,
        mime_type: fileObject.mimetype
      }])
      .select()
      .single();

    if (error) {
      // Rollback: Si falla Supabase, intentamos borrar el archivo de Drive para no dejar basura
      await this.drive.files.delete({ fileId: driveFileId }).catch(() => {});
      throw new Error(`Error BD: ${error.message}`);
    }

    return data;
  }

  // Preparar descarga (Devuelve el stream y metadatos)
  async getFileStream(documentId) {
    if (!this.drive) throw new Error('Servicio de Drive no disponible');

    // 1. Obtener ID de Drive desde Supabase
    const { data: doc, error } = await supabase
      .from('student_documents')
      .select('drive_file_id, file_name, mime_type')
      .eq('id', documentId)
      .single();

    if (error || !doc) throw new Error('Documento no encontrado en base de datos');

    // 2. Obtener Stream desde Google
    try {
      const driveRes = await this.drive.files.get(
        { fileId: doc.drive_file_id, alt: 'media' },
        { responseType: 'stream' }
      );

      return {
        stream: driveRes.data,
        fileName: doc.file_name,
        mimeType: doc.mime_type
      };
    } catch (err) {
      throw new Error('El archivo ya no existe en Google Drive');
    }
  }
}

module.exports = new DriveService();