const { google } = require('googleapis');
const path = require('path');

// Inicialización Lazy (Solo se conecta si se usa)
const getDriveClient = () => {
  try {
    // Si la ruta es relativa, aseguramos que apunte a la raíz
    const keyFilePath = process.env.GOOGLE_SERVICE_ACCOUNT_PATH || 'service-account.json';
    
    const auth = new google.auth.GoogleAuth({
      keyFile: keyFilePath,
      scopes: ['https://www.googleapis.com/auth/drive'],
    });

    return google.drive({ version: 'v3', auth });
  } catch (error) {
    console.error('❌ Error configurando Google Drive:', error.message);
    return null; // Retornamos null para manejarlo en el servicio
  }
};

module.exports = getDriveClient;