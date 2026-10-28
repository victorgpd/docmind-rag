import multer from 'multer';

/** Upload multipart em memoria com limite de tamanho: `router.post('/x', upload(25 * 1024 * 1024).single('file'), handler)` -> req.file.buffer. Excesso => 413 pelo errorHandler. */
export const upload = (maxBytes: number) => multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: 1 } });
