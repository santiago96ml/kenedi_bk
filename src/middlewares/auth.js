const jwt = require('jsonwebtoken');

const verifyToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Acceso denegado: Token requerido' });
  }

  // Verificamos el token usando el secreto de Supabase
  jwt.verify(token, process.env.SUPABASE_JWT_SECRET, (err, user) => {
    if (err) {
      console.error("Error JWT:", err.message);
      return res.status(403).json({ error: 'Token inválido o expirado' });
    }
    req.user = user; // Guardamos el usuario en la petición
    next();
  });
};

module.exports = verifyToken;